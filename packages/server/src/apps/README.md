# Integration apps

Each integration is one file in this folder that default-exports an app built with `defineApp()`
from `./types`. The definition drives both sides:

- the webapp renders the app's settings form from `settings`, with no app-specific UI;
- the server validates saved settings against `settings`, then calls the app's `validate` hook;
- the integration queue calls `run` for every new submission while the integration is active,
  with credentials for the app's `auth`.

## Adding an app

1. Create `src/apps/<id>.ts` and default-export `defineApp({ ... })`.
2. Re-export it from `src/apps/index.ts` under its id: `export { default as <id> } from './<id>'`.
3. Add its logo to `packages/webapp/public/static/` and set `icon` to `/static/<file>`.
4. Optionally translate it in the webapp locales under `form.integrations.apps.<id>` (see below).

The webhook (`webhook.ts`) is the smallest complete example:

```ts
import { assertSafeOutboundRequest, assertSafeOutboundUrl } from '@utils'

import { defineApp } from './types'

export default defineApp({
  id: 'webhook',
  name: 'Webhook',
  description:
    "With webhooks integration, you can send every submission straight to any URL as soon as it's submitted.",
  icon: '/static/webhook.png',
  settings: [
    {
      type: 'url',
      name: 'endpointUrl',
      label: 'Endpoint URL',
      placeholder: 'https://webhook.example.com',
      required: true
    }
  ],
  validate: async config => {
    await assertSafeOutboundUrl(config.endpointUrl)
  },
  run: async ({ config, submission, form }) => {
    // POST the submission to config.endpointUrl
  }
})
```

## Definition

| Field         | Description                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`          | Unique id, stored on each integration. Never change it once released.                                          |
| `name`        | Display name.                                                                                                  |
| `description` | One sentence shown in the integrations list and settings modal.                                                |
| `icon`        | Path of the logo served by the server, e.g. `/static/webhook.png`.                                             |
| `auth`        | How HeyForm authenticates with the app's service: `none` (default), `apiKey` or `oauth2`. See below.           |
| `settings`    | Fields the form owner fills in. See below.                                                                     |
| `queue`       | Optional retry and timeout options for the app's delivery jobs. See below.                                     |
| `validate`    | Optional. Receives the config after the generic checks; throw a `BadRequestException` to reject it.            |
| `run`         | Receives `{ config, submission, form, auth }` for each submission. Throwing fails the job, which Bull retries. |

## Settings

Every setting has `type`, `name` (its key in the config), `label`, and optionally `description`,
`placeholder`, `required` and `defaultValue`.

| `type`     | Renders as      | Stored value | Extra props                              |
| ---------- | --------------- | ------------ | ---------------------------------------- |
| `text`     | Input           | string       |                                          |
| `url`      | Input           | string       | Must be an `http://` or `https://` URL.  |
| `textarea` | Multi-line text | string       |                                          |
| `select`   | Select          | string       | `options: { label, value }[]`, required. |
| `switch`   | Switch          | boolean      | Missing values are stored as `false`.    |

When settings are saved, the server:

1. rejects a missing or blank `required` value, after applying `defaultValue`;
2. checks each value's type, URL format and that a select value is one of its `options`;
3. drops any key that isn't a declared setting;
4. calls the app's `validate` with the cleaned config, then stores that config.

## Auth

HeyForm stores the credentials, encrypted with `FORM_ENCRYPTION_KEY`, and passes `run` a
ready-to-use `auth` value. Credentials are never sent to the browser, and app code never stores,
decrypts or refreshes them.

| `auth`                                     | The form owner                                                       | `run` receives                    |
| ------------------------------------------ | -------------------------------------------------------------------- | --------------------------------- |
| `{ type: 'none' }`                         | does nothing extra.                                                  | `{ type: 'none' }`                |
| `{ type: 'apiKey', label?, description? }` | pastes a key above the settings. At most its last 4 characters show. | `{ type: 'apiKey', apiKey }`      |
| `{ type: 'oauth2', provider, scopes }`     | connects an account before filling in the settings.                  | `{ type: 'oauth2', accessToken }` |

`defineApp` types `auth` in `run` from the definition, so an `oauth2` app can use
`auth.accessToken` directly:

```ts
export default defineApp({
  id: 'example',
  // ...
  auth: {
    type: 'oauth2',
    provider: 'google',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  },
  run: async ({ auth, config, submission }) => {
    await got.post('https://api.example.com/rows', {
      headers: { authorization: `Bearer ${auth.accessToken}` },
      json: { submissionId: submission.id, sheet: config.sheet }
    })
  }
})
```

### OAuth2

`provider` is the id of a provider in `oauth2-providers.ts` (only `google` so far). To add one,
give its authorize and token URLs there. Each install registers its own OAuth app with the provider:

- set `<PROVIDER>_INTEGRATION_CLIENT_ID` and `<PROVIDER>_INTEGRATION_CLIENT_SECRET`, e.g.
  `GOOGLE_INTEGRATION_CLIENT_ID`;
- register `${APP_HOMEPAGE_URL}/api/integrations/oauth/callback` as the redirect URI.

Until both variables are set, apps using that provider are hidden.

The connection belongs to the form's integration: connecting creates the integration (pending until
its settings are saved), and deleting the integration deletes the tokens. When a job runs, HeyForm
refreshes the access token if it has expired (there's no scheduled refresh). If the provider rejects
the refresh token (`invalid_grant`, e.g. access was revoked), the integration is marked as needing
reconnection and the job stops retrying. Network errors and provider outages are retried like any
other failure.

While an integration needs reconnecting, its submissions wait (see [Delivery log](#delivery-log))
and are sent once the form owner reconnects the account. A saved API key that can no longer be
decrypted (e.g. after `FORM_ENCRYPTION_KEY` changed) is treated the same way: entering the key again
reconnects it.

## Queue

Each submission becomes one job on the integration queue, which retries failures with the global
`BULL_JOB_ATTEMPTS`, `BULL_JOB_BACKOFF_*` and `BULL_JOB_TIMEOUT` settings. An app can override them:

```ts
queue: {
  attempts: 5, // total tries, including the first
  backoff: { type: 'exponential', delay: 2000 }, // or a fixed delay in ms
  timeout: 30_000 // ms per try
}
```

Credential errors that a retry can't fix (no API key saved, a revoked OAuth grant) fail the job
without further attempts.

## Delivery log

Every attempt is recorded in `IntegrationRecordModel`: whether it succeeded, the attempt number,
whether the queue will retry, and the error message of a failure (shortened to 500 characters).
The form owner sees the 20 most recent records in the integration's settings. Records are kept for
30 days and deleted with the integration.

A submission that can't be sent because the integration needs reconnecting gets a waiting record
instead: either it arrived while the integration needed reconnecting, or its job found the grant
revoked. Waiting records don't expire. When the integration becomes active again (the account is
reconnected, a new API key is saved, or the integration is turned back on), each waiting submission
is queued again, oldest first, and its record is removed. Each record is claimed once and jobs use
`<integrationId>-<submissionId>` as their Bull job id, so a reconnect handled twice doesn't send a
submission twice. An integration holds at most 1,000 waiting submissions (`MAX_WAITING_RECORDS`);
later ones are recorded as failed. Deleting the integration discards them.

The error message of whatever `run` throws is shown to the form owner, so keep secrets and
submission data out of it.

## Translations

The webapp looks labels up under `form.integrations.apps.<id>` and falls back to the English in the
definition, so translations are optional:

```json
{
  "description": "...",
  "auth": { "label": "...", "description": "..." },
  "settings": {
    "<name>": {
      "label": "...",
      "description": "...",
      "options": { "<value>": "..." }
    }
  }
}
```

Keep option values to letters, digits, `-` and `_`, since they become part of the translation key.
