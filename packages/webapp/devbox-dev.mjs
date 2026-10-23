// devbox only (`pnpm dev:devbox`): the webapp's Vite dev server on the port devbox assigns,
// answering to its *.strmnshltr.dev hostname and proxying to this checkout's server. Inline
// options override vite.config.mts, which stays as upstream has it; Vite's loadEnv lets the
// process environment win over .env.local.
import { createServer } from 'vite'

import { webappEnv } from '../../scripts/devbox-env.mjs'

Object.assign(process.env, webappEnv())

const server = await createServer({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT),
    strictPort: true,
    allowedHosts: ['.strmnshltr.dev']
  }
})
await server.listen()
server.printUrls()
