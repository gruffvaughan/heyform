// devbox only (`pnpm dev:devbox`): what the webapp and the server need from devbox, so every
// checkout, the main one or a worktree, runs its own pair with no hand-written overrides.
// `devbox run` sets PORT, HOST, DEVBOX_CHECKOUT, DEVBOX_URL_WEB and DEVBOX_PORT_SERVER, and in a
// worktree loads the main checkout's .env.local files; these values replace theirs.
//
// Redis: Bull keeps its queues in REDIS_DB + 1, so two servers on one DB take each other's jobs.
// The main checkout keeps its .env.local's REDIS_DB (0, so Bull uses 1). A worktree takes the
// pair 2 + 2k (cache) and 3 + 2k (Bull) from its devbox lease, k = ((block - 4500) / 10) % 7:
// lease blocks 4500, 4510, ..., 4560 get 2, 4, ..., 14, and 4570 starts again at 2. KeyDB has 16
// DBs, so worktrees whose blocks are a multiple of 70 apart share a pair; the server won't start
// while another worktree on its pair runs one.
//
// The webapp imports webappEnv(). The server runs `node scripts/devbox-env.mjs`, which checks the
// pair and prints the server's variables as shell exports.
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function need(env, name) {
  if (!env[name]) throw new Error(`${name} isn't set: run this through \`devbox run\`.`)
  return env[name]
}

const webUrl = env => new URL(need(env, 'DEVBOX_URL_WEB'))

// A worktree's .git is a file pointing at the main repository's.
const inWorktree = env => statSync(join(need(env, 'DEVBOX_CHECKOUT'), '.git')).isFile()

// devbox leases each worktree a block of ten ports from 4500 up.
const redisDb = port => 2 + 2 * (Math.floor((Number(port) - 4500) / 10) % 7)

export function webappEnv(env = process.env) {
  const web = webUrl(env)
  return {
    VITE_PROXY_TARGET: `http://127.0.0.1:${need(env, 'DEVBOX_PORT_SERVER')}`,
    VITE_HOMEPAGE_URL: web.origin,
    VITE_DASHBOARD_URL: web.origin,
    VITE_COOKIE_DOMAIN: web.hostname,
    VITE_COOKIE_DOMAIN_REWRITE: web.hostname
  }
}

export function serverEnv(env = process.env) {
  const web = webUrl(env)
  return {
    APP_LISTEN_HOSTNAME: need(env, 'HOST'),
    APP_LISTEN_PORT: need(env, 'PORT'),
    APP_HOMEPAGE_URL: web.origin,
    COOKIE_DOMAIN: web.hostname,
    CORS_ALLOWED_ORIGINS: web.origin,
    ...(inWorktree(env) ? { REDIS_DB: String(redisDb(need(env, 'DEVBOX_PORT_SERVER'))) } : {})
  }
}

// Another worktree of this project whose server runs on the same Redis pair, from `devbox list`.
function pairTakenBy(env, db) {
  let projects
  try {
    projects = JSON.parse(execFileSync('devbox', ['list', '--json'], { encoding: 'utf8' })).projects
  } catch (e) {
    console.error(`devbox-env: couldn't check the Redis DB with \`devbox list\`: ${e.message}`)
    return null
  }
  const project = projects.find(p => p.slug === env.DEVBOX_PROJECT)
  return (project?.worktrees ?? []).find(
    w =>
      w.path !== env.DEVBOX_CHECKOUT &&
      w.services.some(s => s.name === 'server' && s.state === 'running' && redisDb(s.port) === db)
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const vars = serverEnv()
  if (vars.REDIS_DB) {
    const db = Number(vars.REDIS_DB)
    const other = pairTakenBy(process.env, db)
    if (other) {
      console.error(
        `devbox-env: worktree ${other.path} runs a server on Redis DBs ${db} and ${db + 1}, ` +
          `which this one would share. Stop it first.`
      )
      process.exit(1)
    }
  }
  const quote = v => `'${String(v).replace(/'/g, `'\\''`)}'`
  for (const [k, v] of Object.entries(vars)) console.log(`export ${k}=${quote(v)}`)
}
