import * as assert from 'assert'

const { IntegrationQueue, SKIPPED_JOB } = require('../src/queue/integration-queue')
const { IntegrationService } = require('../src/service/integration.service')
const { IntegrationAuthError } = require('../src/service/integration-auth.service')
const {
  IntegrationRecordsResolver
} = require('../src/resolver/integration/integration-records.resolver')
const { FormIntegrationsResolver } = require('../src/resolver/form/form-integrations.resolver')
const {
  IntegrationRecordSchema,
  IntegrationRecordStatusEnum,
  MAX_WAITING_RECORDS
} = require('../src/model/integration-record.model')
const { IntegrationStatusEnum } = require('../src/model/integration.model')

const { SUCCEEDED, FAILED } = IntegrationRecordStatusEnum

const JOB_DATA = {
  appId: 'webhook',
  formId: 'form_1',
  integrationId: 'integration_1',
  submissionId: 'submission_1'
}

function createJob(attemptsMade: number, attempts?: number) {
  return {
    id: 7,
    queue: { name: 'IntegrationQueue' },
    data: JOB_DATA,
    attemptsMade,
    opts: attempts === undefined ? {} : { attempts }
  }
}

function createQueue(addRecord?: (record: any) => Promise<void>) {
  const records: any[] = []
  const integrationService = {
    addRecord:
      addRecord ??
      (async (record: any) => {
        records.push(record)
      })
  }
  const queue = new IntegrationQueue({}, integrationService, {}, {}, {})

  return { queue, records }
}

// --- queue events -----------------------------------------------------------

async function testRecordsSuccessWithAttemptNumber() {
  const { queue, records } = createQueue()

  // Succeeded on the third try: two failed attempts before it
  await queue.recordSuccess(createJob(2, 3), undefined)

  assert.deepStrictEqual(records, [{ ...JOB_DATA, status: SUCCEEDED, attempt: 3, maxAttempts: 3 }])
}

async function testSkippedJobsAreNotRecorded() {
  const { queue, records } = createQueue()

  await queue.recordSuccess(createJob(0, 3), SKIPPED_JOB)
  assert.deepStrictEqual(records, [])
}

async function testRecordsFailureThatWillBeRetried() {
  const { queue, records } = createQueue()

  // Bull counts the failed attempt before emitting `failed`
  await queue.recordFailure(createJob(1, 3), new Error('Response code 502 (Bad Gateway)'))

  assert.deepStrictEqual(records, [
    {
      ...JOB_DATA,
      status: FAILED,
      attempt: 1,
      maxAttempts: 3,
      willRetry: true,
      error: 'Response code 502 (Bad Gateway)'
    }
  ])
}

async function testRecordsFinalFailure() {
  const { queue, records } = createQueue()

  await queue.recordFailure(createJob(3, 3), new Error('Promise timed out after 60000 ms'))

  assert.strictEqual(records[0].attempt, 3)
  assert.strictEqual(records[0].willRetry, false)
  assert.strictEqual(records[0].error, 'Promise timed out after 60000 ms')
}

async function testAuthFailuresAreFinal() {
  const { queue, records } = createQueue()

  // Not fixed by reconnecting (an install problem), so not kept waiting
  await queue.recordFailure(
    createJob(1, 5),
    new IntegrationAuthError('Google rejected the token request: invalid_client')
  )

  assert.strictEqual(records[0].willRetry, false)
  assert.strictEqual(records[0].attempt, 1)
  assert.strictEqual(records[0].maxAttempts, 5)
}

async function testDefaultsToOneAttempt() {
  const { queue, records } = createQueue()

  await queue.recordFailure(createJob(1), new Error('boom'))
  assert.deepStrictEqual(
    [records[0].attempt, records[0].maxAttempts, records[0].willRetry],
    [1, 1, false]
  )
}

async function testRecordingErrorsDoNotFailTheJob() {
  const { queue } = createQueue(async () => {
    throw new Error('mongo down')
  })
  const logged: string[] = []
  queue.logger = { error: (message: string) => logged.push(message) }

  await queue.recordSuccess(createJob(0, 3), undefined)
  await queue.recordFailure(createJob(1, 3), new Error('x'))

  assert.deepStrictEqual(logged, [
    "Couldn't record IntegrationQueue#7: mongo down",
    "Couldn't record IntegrationQueue#7: mongo down"
  ])
}

async function testProcessResultDistinguishesSkippedJobs() {
  const runs: any[] = []
  const app = { id: 'webhook', run: async () => runs.push(1) && 'response body' }
  const createProcessQueue = (integration: any) =>
    new IntegrationQueue(
      { findById: () => app },
      { findById: async () => integration },
      { getRunAuth: async () => ({ type: 'none' }) },
      { findById: async () => ({ id: 'submission_1' }) },
      { findById: async () => ({ id: 'form_1' }) }
    )

  // The app's result isn't returned, so Bull doesn't store it
  assert.strictEqual(
    await createProcessQueue({ id: 'integration_1', status: 1, config: {} }).process({
      data: JOB_DATA
    }),
    undefined
  )
  assert.strictEqual(runs.length, 1)

  // A deleted integration: nothing ran, nothing to record
  assert.strictEqual(await createProcessQueue(null).process({ data: JOB_DATA }), SKIPPED_JOB)
  assert.strictEqual(runs.length, 1)
}

// --- service ----------------------------------------------------------------

function createService() {
  const created: any[] = []
  const deleted: any[] = []
  const recordModel = {
    create: async (doc: any) => created.push(doc),
    deleteMany: async (filter: any) => deleted.push(filter)
  }
  const integrationModel = {
    deleteOne: async () => ({ deletedCount: 1 })
  }
  const service = new IntegrationService(integrationModel, recordModel, {}, {}, {})

  return { service, created, deleted }
}

async function testAddRecordShortensLongErrors() {
  const { service, created } = createService()

  await service.addRecord({
    ...JOB_DATA,
    status: FAILED,
    attempt: 1,
    maxAttempts: 1,
    error: 'e'.repeat(2000)
  })
  await service.addRecord({ ...JOB_DATA, status: SUCCEEDED, attempt: 1, maxAttempts: 1 })

  assert.strictEqual(created[0].error.length, 500)
  assert.ok(created[0].error.endsWith('…'))
  assert.strictEqual(created[0].willRetry, false)
  assert.strictEqual(created[1].error, undefined)
}

async function testOnlyTheCurrentIntegrationsRecordsAreListed() {
  const queries: any[] = []
  const chain = (filter: any) => {
    queries.push(filter)
    return { sort: () => ({ limit: async () => [] }) }
  }
  let current: any = { id: 'integration_2' }
  const service = new IntegrationService(
    { findOne: async () => current },
    { find: chain },
    {},
    {},
    {}
  )

  await service.findRecords('form_1', 'webhook', 20)
  // Records left by a deleted integration_1 (e.g. a job that finished after
  // the delete) are not included
  assert.deepStrictEqual(queries, [
    { formId: 'form_1', appId: 'webhook', integrationId: 'integration_2' }
  ])

  current = null
  assert.deepStrictEqual(await service.findRecords('form_1', 'webhook', 20), [])
  assert.strictEqual(queries.length, 1)
}

async function testDeletingAnIntegrationDeletesItsRecords() {
  const { service, deleted } = createService()

  assert.strictEqual(await service.delete('form_1', 'webhook'), true)
  assert.deepStrictEqual(deleted, [{ formId: 'form_1', appId: 'webhook' }])
}

// --- waiting for reconnection -------------------------------------------------

const { WAITING } = IntegrationRecordStatusEnum
const NEEDS_RECONNECT = IntegrationStatusEnum.NEEDS_RECONNECT
const ACTIVE = IntegrationStatusEnum.ACTIVE

// An in-memory IntegrationRecordModel with the queries the service uses
function createRecordModel() {
  let nextId = 1
  let clock = Date.parse('2026-10-23T10:00:00.000Z')
  const docs: any[] = []
  const matches = (doc: any, filter: Record<string, any>) =>
    Object.entries(filter).every(([key, value]) => doc[key] === value)
  const insert = (fields: any) => {
    const doc = { _id: `record_${nextId++}`, createdAt: new Date(clock++), ...fields }
    docs.push(doc)
    return doc
  }
  const sorted = (filter: any, spec: Record<string, number>) => {
    const direction = spec.createdAt ?? 1
    const result = docs
      .filter(doc => matches(doc, filter))
      .sort((a, b) => direction * (a.createdAt - b.createdAt))
    return Object.assign(Promise.resolve(result), {
      limit: async (n: number) => result.slice(0, n)
    })
  }

  return {
    docs,
    create: async (fields: any) => insert(fields),
    countDocuments: async (filter: any) => docs.filter(doc => matches(doc, filter)).length,
    updateOne: async (filter: any, update: any, options: any) => {
      if (docs.some(doc => matches(doc, filter))) {
        return { matchedCount: 1 }
      }
      if (options?.upsert) {
        insert({ ...filter, ...update.$setOnInsert })
      }
      return { matchedCount: 0 }
    },
    find: (filter: any) => ({ sort: (spec: any) => sorted(filter, spec) }),
    // Atomic, as in MongoDB: only one caller gets the document
    findOneAndDelete: (filter: any) => ({
      lean: async () => {
        const index = docs.findIndex(doc => matches(doc, filter))
        return index < 0 ? null : docs.splice(index, 1)[0]
      }
    }),
    deleteMany: async (filter: any) => {
      for (let i = docs.length - 1; i >= 0; i--) {
        if (matches(docs[i], filter)) docs.splice(i, 1)
      }
    },
    collection: {
      insertOne: async (doc: any) => {
        docs.push(doc)
      }
    }
  }
}

// A Bull queue that, like Bull, ignores add() while a job with the id exists
function createBullQueue() {
  const jobs = new Map<string, any>()
  const added: any[] = []
  const queue = {
    jobs,
    added,
    failAdd: false,
    add: async (data: any, opts: any) => {
      if (queue.failAdd) {
        throw new Error('Redis is down')
      }
      if (jobs.has(opts.jobId)) {
        return jobs.get(opts.jobId)
      }
      const job: any = {
        id: opts.jobId,
        data,
        opts,
        state: 'waiting',
        getState: async () => job.state,
        remove: async () => {
          jobs.delete(job.id)
        }
      }
      jobs.set(job.id, job)
      added.push({ data, opts })
      return job
    },
    getJob: async (id: string) => jobs.get(id) ?? null
  }

  return queue
}

const queuedApp = { id: 'webhook', queue: { attempts: 4 } }

function createWaitingService(status = NEEDS_RECONNECT) {
  const recordModel = createRecordModel()
  const bull = createBullQueue()
  const integration: any = {
    id: 'integration_1',
    formId: 'form_1',
    appId: 'webhook',
    status
  }
  const integrationModel = {
    findById: async (id: string) => (id === integration.id ? integration : null),
    find: async (filter: any) =>
      filter.formId === integration.formId && filter.status.$in.includes(integration.status)
        ? [integration]
        : []
  }
  const notifications: any[] = []
  const service = new IntegrationService(
    integrationModel,
    recordModel,
    { findById: (id: string) => (id === 'webhook' ? queuedApp : undefined) },
    bull,
    { add: (data: any) => notifications.push(data) }
  )
  const logged: string[] = []
  ;(service as any).logger = { error: (message: string) => logged.push(message) }

  const waitingIds = () =>
    recordModel.docs.filter(doc => doc.status === WAITING).map(doc => doc.submissionId)

  return { service, recordModel, bull, integration, logged, waitingIds }
}

function waitingInput(submissionId: string, extra: Record<string, any> = {}) {
  return { ...JOB_DATA, integrationId: 'integration_1', submissionId, ...extra }
}

async function testSubmissionsWaitWhileTheIntegrationNeedsReconnecting() {
  const { service, bull, recordModel, waitingIds } = createWaitingService()

  await service.addQueue({ id: 'form_1', settings: {} }, 'submission_1')
  await service.addQueue({ id: 'form_1', settings: {} }, 'submission_2')

  assert.deepStrictEqual(bull.added, [], 'not queued')
  assert.deepStrictEqual(waitingIds(), ['submission_1', 'submission_2'])
  assert.deepStrictEqual(
    [recordModel.docs[0].attempt, recordModel.docs[0].maxAttempts, recordModel.docs[0].willRetry],
    [0, 1, false]
  )
  assert.strictEqual(await service.countWaiting('integration_1'), 2)
}

async function testActiveIntegrationsGetOneJobPerSubmission() {
  const { service, bull, waitingIds } = createWaitingService(ACTIVE)

  await service.addQueue({ id: 'form_1', settings: {} }, 'submission_1')

  assert.deepStrictEqual(bull.added, [
    {
      data: waitingInput('submission_1'),
      opts: { attempts: 4, jobId: 'integration_1-submission_1' }
    }
  ])
  assert.deepStrictEqual(waitingIds(), [])
}

async function testASubmissionWaitsOnce() {
  const { service, recordModel } = createWaitingService()

  assert.strictEqual(
    await service.holdForReconnect(
      waitingInput('submission_1', { attempt: 2, maxAttempts: 3, error: 'e'.repeat(900) })
    ),
    true
  )
  await service.holdForReconnect(waitingInput('submission_1', { error: 'again' }))

  assert.strictEqual(recordModel.docs.length, 1)
  assert.strictEqual(recordModel.docs[0].attempt, 2)
  assert.strictEqual(recordModel.docs[0].maxAttempts, 3)
  assert.strictEqual(recordModel.docs[0].error.length, 500, 'shortened like other errors')
}

async function testWaitingIsCapped() {
  const { service, recordModel, waitingIds } = createWaitingService()

  for (let i = 0; i < MAX_WAITING_RECORDS; i++) {
    recordModel.docs.push({
      _id: `old_${i}`,
      integrationId: 'integration_1',
      submissionId: `old_${i}`,
      status: WAITING,
      createdAt: new Date(i)
    })
  }

  assert.strictEqual(await service.holdForReconnect(waitingInput('submission_new')), false)
  assert.strictEqual(waitingIds().length, MAX_WAITING_RECORDS)

  const failed = recordModel.docs.find(doc => doc.submissionId === 'submission_new')
  assert.strictEqual(failed.status, FAILED)
  assert.strictEqual(failed.willRetry, false)
  assert.match(failed.error, /1000 submissions are already waiting/)
}

async function testReconnectResendsOldestFirstAndOnlyOnce() {
  const { service, bull, integration, waitingIds } = createWaitingService()

  for (const id of ['submission_1', 'submission_2', 'submission_3']) {
    await service.holdForReconnect(waitingInput(id))
  }

  integration.status = ACTIVE
  // e.g. the OAuth callback handled twice at the same time
  const counts = await Promise.all([
    service.resendWaiting(integration),
    service.resendWaiting(integration)
  ])
  // ...and once more after the jobs ran (Bull removes completed jobs, so
  // their ids no longer stop a second add)
  bull.jobs.clear()
  counts.push(await service.resendWaiting(integration))

  assert.deepStrictEqual(
    counts.reduce((a, b) => a + b),
    3
  )
  assert.deepStrictEqual(
    bull.added.map(job => job.data.submissionId),
    ['submission_1', 'submission_2', 'submission_3']
  )
  assert.deepStrictEqual(bull.added[0].opts, { attempts: 4, jobId: 'integration_1-submission_1' })
  assert.deepStrictEqual(waitingIds(), [], 'waiting records are removed once queued')
}

async function testResendDoesNotDuplicateAQueuedJob() {
  const { service, bull, integration } = createWaitingService()

  // Still queued from before: it will deliver
  await bull.add(waitingInput('submission_1'), { jobId: 'integration_1-submission_1' })
  // Failed with the old credentials; Bull keeps failed jobs under their id
  const failed = await bull.add(waitingInput('submission_2'), {
    jobId: 'integration_1-submission_2'
  })
  failed.state = 'failed'
  bull.added.length = 0

  await service.holdForReconnect(waitingInput('submission_1'))
  await service.holdForReconnect(waitingInput('submission_2'))
  integration.status = ACTIVE
  await service.resendWaiting(integration)

  assert.deepStrictEqual(
    bull.added.map(job => job.data.submissionId),
    ['submission_2'],
    'the queued job is left alone and the failed one replaced'
  )
  assert.strictEqual(bull.jobs.get('integration_1-submission_2').state, 'waiting')
}

async function testResendFailureKeepsTheSubmissionWaiting() {
  const { service, bull, integration, logged, waitingIds, recordModel } = createWaitingService()

  await service.holdForReconnect(waitingInput('submission_1'))
  await service.holdForReconnect(waitingInput('submission_2'))
  const createdAt = recordModel.docs[0].createdAt

  bull.failAdd = true
  assert.strictEqual(await service.resendWaiting(integration), 0, 'never throws')
  assert.deepStrictEqual(waitingIds().sort(), ['submission_1', 'submission_2'])
  assert.strictEqual(
    recordModel.docs.find(doc => doc.submissionId === 'submission_1').createdAt,
    createdAt,
    'keeps its place in line'
  )
  assert.match(logged[0], /Couldn't resend waiting submissions of integration integration_1/)

  bull.failAdd = false
  assert.strictEqual(await service.resendWaiting(integration), 2)
  assert.deepStrictEqual(
    bull.added.map(job => job.data.submissionId),
    ['submission_1', 'submission_2']
  )
}

async function testWaitingAfterAReconnectIsSentStraightAway() {
  const { service, bull, integration, waitingIds } = createWaitingService()

  // The job read the old status, then the account was reconnected before
  // its failure was recorded
  integration.status = ACTIVE
  await service.holdForReconnect(waitingInput('submission_1'))

  assert.deepStrictEqual(
    bull.added.map(job => job.data.submissionId),
    ['submission_1']
  )
  assert.deepStrictEqual(waitingIds(), [])
}

async function testReconnectFailuresWaitInsteadOfFailing() {
  const held: any[] = []
  const { queue, records } = createQueue()
  ;(queue as any).integrationService.holdForReconnect = async (input: any) => held.push(input)

  await queue.recordFailure(
    createJob(1, 3),
    new IntegrationAuthError('Google rejected the token request: invalid_grant', true)
  )

  assert.deepStrictEqual(records, [], 'not recorded as a spent failure')
  assert.deepStrictEqual(held, [
    {
      ...JOB_DATA,
      attempt: 1,
      maxAttempts: 3,
      error: 'Google rejected the token request: invalid_grant'
    }
  ])
}

async function testDeletingDiscardsWaitingSubmissions() {
  const { service, waitingIds, recordModel } = createWaitingService()
  ;(service as any).integrationModel.deleteOne = async () => ({ deletedCount: 1 })

  await service.holdForReconnect(waitingInput('submission_1'))
  await service.delete('form_1', 'webhook')

  assert.deepStrictEqual(waitingIds(), [])
  assert.strictEqual(recordModel.docs.length, 0)
}

function testWaitingRecordsDoNotExpire() {
  const indexes = IntegrationRecordSchema.indexes()
  const ttl = indexes.find(([, options]: any) => options.expireAfterSeconds)
  const unique = indexes.find(([, options]: any) => options.unique)

  assert.deepStrictEqual(ttl, [
    { createdAt: 1 },
    {
      expireAfterSeconds: 30 * 24 * 60 * 60,
      // Settled attempts only (SUCCEEDED, FAILED), not WAITING (0)
      partialFilterExpression: { status: { $gte: SUCCEEDED } },
      background: true
    }
  ])
  assert.deepStrictEqual(unique, [
    { integrationId: 1, submissionId: 1 },
    { unique: true, partialFilterExpression: { status: WAITING }, background: true }
  ])
}

async function testFormIntegrationsReportWaitingCount() {
  const integrationService = {
    findAllInForm: async () => [
      { id: 'integration_1', formId: 'form_1', appId: 'webhook', status: NEEDS_RECONNECT },
      { id: 'integration_2', formId: 'form_1', appId: 'other', status: ACTIVE }
    ],
    countWaiting: async (id: string) => (id === 'integration_1' ? 12 : 0)
  }

  const listed = await new FormIntegrationsResolver(integrationService).formIntegrations({
    formId: 'form_1'
  })

  assert.deepStrictEqual(
    listed.map((integration: any) => integration.waitingCount),
    [12, 0]
  )
}

// --- resolver ---------------------------------------------------------------

async function testResolverReturnsRecentRecordsForTheFormApp() {
  const calls: any[] = []
  const integrationService = {
    findRecords: async (formId: string, appId: string, limit: number) => {
      calls.push([formId, appId, limit])
      return [
        {
          id: 'record_2',
          submissionId: 'submission_2',
          status: FAILED,
          attempt: 2,
          maxAttempts: 3,
          willRetry: true,
          error: 'Response code 500 (Internal Server Error)',
          createdAt: new Date('2026-10-23T10:00:05.900Z'),
          // Never exposed
          integrationId: 'integration_1',
          formId: 'form_1'
        },
        {
          id: 'record_1',
          submissionId: 'submission_1',
          status: SUCCEEDED,
          attempt: 1,
          maxAttempts: 3,
          createdAt: new Date('2026-10-23T10:00:00.000Z')
        }
      ]
    }
  }

  const records = await new IntegrationRecordsResolver(integrationService).integrationRecords({
    formId: 'form_1',
    appId: 'webhook'
  })

  assert.deepStrictEqual(calls, [['form_1', 'webhook', 20]])
  assert.deepStrictEqual(records, [
    {
      id: 'record_2',
      submissionId: 'submission_2',
      status: FAILED,
      attempt: 2,
      maxAttempts: 3,
      willRetry: true,
      error: 'Response code 500 (Internal Server Error)',
      createdAt: 1792749605
    },
    {
      id: 'record_1',
      submissionId: 'submission_1',
      status: SUCCEEDED,
      attempt: 1,
      maxAttempts: 3,
      willRetry: false,
      error: undefined,
      createdAt: 1792749600
    }
  ])
}

async function run() {
  await testRecordsSuccessWithAttemptNumber()
  await testSkippedJobsAreNotRecorded()
  await testRecordsFailureThatWillBeRetried()
  await testRecordsFinalFailure()
  await testAuthFailuresAreFinal()
  await testDefaultsToOneAttempt()
  await testRecordingErrorsDoNotFailTheJob()
  await testProcessResultDistinguishesSkippedJobs()
  await testAddRecordShortensLongErrors()
  await testOnlyTheCurrentIntegrationsRecordsAreListed()
  await testDeletingAnIntegrationDeletesItsRecords()
  await testSubmissionsWaitWhileTheIntegrationNeedsReconnecting()
  await testActiveIntegrationsGetOneJobPerSubmission()
  await testASubmissionWaitsOnce()
  await testWaitingIsCapped()
  await testReconnectResendsOldestFirstAndOnlyOnce()
  await testResendDoesNotDuplicateAQueuedJob()
  await testResendFailureKeepsTheSubmissionWaiting()
  await testWaitingAfterAReconnectIsSentStraightAway()
  await testReconnectFailuresWaitInsteadOfFailing()
  await testDeletingDiscardsWaitingSubmissions()
  testWaitingRecordsDoNotExpire()
  await testFormIntegrationsReportWaitingCount()
  await testResolverReturnsRecentRecordsForTheFormApp()
}

if (require.main === module) {
  run().catch(error => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`)
    process.exitCode = 1
  })
}
