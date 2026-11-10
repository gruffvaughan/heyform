import assert from 'assert'
import mongoose from 'mongoose'

import { ProjectSchema } from '../src/model'
import { JoinTeamResolver } from '../src/resolver/team/join-team.resolver'
import { ProjectService } from '../src/service/project.service'

// Builds documents with the real schema, so its defaults apply as they would on create
const Project = mongoose.model('DefaultProjectTestProject', ProjectSchema)

const teamCreatedAt = new Date('2026-01-01T00:00:00.000Z')
const team = { id: 'team_1', name: 'Workspace', ownerId: 'owner_1', createdAt: teamCreatedAt }
const joiner = { id: 'user_1', name: 'Joiner', email: 'joiner@example.com' }

function later(ms: number) {
  return new Date(teamCreatedAt.getTime() + ms)
}

const DAY = 24 * 60 * 60 * 1000

// The few query operators ProjectService uses, matched against stored fields
function matches(row: Record<string, any>, conditions: Record<string, any>) {
  return Object.entries(conditions).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      return Object.entries(condition).every(([operator, value]) => {
        switch (operator) {
          case '$exists':
            return (row[key] !== undefined) === value
          case '$lte':
            return row[key] <= value
          default:
            throw new Error(`Unsupported operator ${operator}`)
        }
      })
    }

    return row[key] === condition
  })
}

function createModel(build: (doc: Record<string, any>) => Record<string, any>) {
  const rows: Record<string, any>[] = []

  const findOne = (conditions: Record<string, any>) => {
    const found = () => rows.filter(row => matches(row, conditions))

    return {
      sort: async (order: Record<string, 1 | -1>) => {
        const [key, direction] = Object.entries(order)[0]
        return found().sort((a, b) => (a[key] - b[key]) * direction)[0] ?? null
      },
      then: (resolve: (row: any) => void, reject: (error: any) => void) =>
        Promise.resolve(found()[0] ?? null).then(resolve, reject)
    }
  }

  return {
    rows,
    findOne,
    create: async (doc: Record<string, any>) => {
      const row = build(doc)
      rows.push(row)
      return row
    }
  }
}

function setup() {
  let clock = teamCreatedAt

  const projects = createModel(doc => {
    const row = new Project(doc).toObject() as Record<string, any>
    return { ...row, id: row._id, createdAt: clock }
  })
  const projectMembers = createModel(doc => ({ ...doc, id: `${doc.projectId}:${doc.memberId}` }))
  const projectService = new ProjectService(projects as any, projectMembers as any)

  const resolver = new JoinTeamResolver(
    {
      findById: async () => team,
      findJoinableByInvite: async () => team,
      findMemberById: async () => null,
      createMember: async () => 'team_member_1'
    } as any,
    { findById: async () => ({ email: 'owner@example.com' }) } as any,
    { joinWorkspaceAlert: () => undefined } as any,
    projectService
  )

  return {
    projectService,
    projects: projects.rows,

    // Creates a project the way the app does, at a time relative to the team's creation
    at: (ms: number) => {
      clock = later(ms)
    },

    // A project stored before isDefault existed
    addLegacyProject: (id: string, createdAt: Date) => {
      projects.rows.push({
        _id: id,
        id,
        teamId: team.id,
        name: id,
        ownerId: team.ownerId,
        createdAt
      })
    },

    deleteProject: (id: string) => {
      projects.rows.splice(
        projects.rows.findIndex(row => row.id === id),
        1
      )
    },

    join: () => resolver.joinTeam(joiner as any, { teamId: team.id, inviteCode: 'code_1' } as any),

    joinerProjects: () =>
      projectMembers.rows.filter(row => row.memberId === joiner.id).map(row => row.projectId)
  }
}

function projectNamed(projects: Record<string, any>[], name: string) {
  return projects.find(project => project.name === name)!
}

async function testNewTeamsProjectIsTheDefault() {
  const { projectService, projects, at } = setup()

  await projectService.createByNewTeam(team.id, team.ownerId, 'First')
  at(DAY)
  await projectService.create({ teamId: team.id, name: 'Second', ownerId: team.ownerId })

  assert.strictEqual(projectNamed(projects, 'First').isDefault, true)
  assert.strictEqual(projectNamed(projects, 'Second').isDefault, false)
}

async function testJoinerLandsInTheDefaultProject() {
  const { projectService, projects, at, join, joinerProjects } = setup()

  await projectService.createByNewTeam(team.id, team.ownerId, 'First')
  at(DAY)
  await projectService.create({ teamId: team.id, name: 'Second', ownerId: team.ownerId })

  assert.strictEqual(await join(), true)
  assert.deepStrictEqual(joinerProjects(), [projectNamed(projects, 'First').id])
}

// The next-oldest project may be one the owner keeps to a few members. Even one made a second after
// the workspace isn't taken for the default.
async function testNoDefaultAfterTheDefaultProjectIsDeleted() {
  const { projectService, projects, at, deleteProject, join, joinerProjects } = setup()

  await projectService.createByNewTeam(team.id, team.ownerId, 'First')
  at(1000)
  await projectService.create({ teamId: team.id, name: 'Confidential', ownerId: team.ownerId })
  at(DAY)
  await projectService.create({ teamId: team.id, name: 'Later', ownerId: team.ownerId })
  deleteProject(projectNamed(projects, 'First').id)

  assert.strictEqual(await join(), true)
  assert.deepStrictEqual(joinerProjects(), [])
}

// A workspace from before isDefault: its first project, made in the same request as the team
async function testLegacyTeamUsesTheProjectCreatedWithIt() {
  const { projectService, at, addLegacyProject, join, joinerProjects } = setup()

  addLegacyProject('legacy_first', later(50))
  addLegacyProject('legacy_second', later(DAY))
  at(2 * DAY)
  await projectService.create({ teamId: team.id, name: 'New', ownerId: team.ownerId })

  assert.strictEqual(await join(), true)
  assert.deepStrictEqual(joinerProjects(), ['legacy_first'])
}

// Including a project the owner made half a minute after the workspace
async function testLegacyTeamWhoseFirstProjectWasDeletedHasNoDefault() {
  const { addLegacyProject, join, joinerProjects } = setup()

  addLegacyProject('legacy_confidential', later(30 * 1000))
  addLegacyProject('legacy_second', later(DAY))
  addLegacyProject('legacy_third', later(2 * DAY))

  assert.strictEqual(await join(), true)
  assert.deepStrictEqual(joinerProjects(), [])
}

async function run() {
  await testNewTeamsProjectIsTheDefault()
  await testJoinerLandsInTheDefaultProject()
  await testNoDefaultAfterTheDefaultProjectIsDeleted()
  await testLegacyTeamUsesTheProjectCreatedWithIt()
  await testLegacyTeamWhoseFirstProjectWasDeletedHasNoDefault()
}

if (require.main === module) {
  run().catch(error => {
    // eslint-disable-next-line no-console
    console.error(error)
    process.exitCode = 1
  })
}
