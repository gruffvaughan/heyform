// devbox only (`pnpm dev:devbox`): the webapp's Vite dev server on the port devbox assigns,
// answering to its *.strmnshltr.dev hostname. Inline options override vite.config.mts, which
// stays as upstream has it.
import { createServer } from 'vite'

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
