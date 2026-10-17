import { createRequire } from 'node:module'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Standalone probe: does a cooling pin defer to the ranking?
// Run in its own process so hydration reads the seeded row, which is the whole
// point - hydration is a once-per-boot step, so a second harness in the parent
// process would reuse the first one's rows and prove nothing.
const HERE = dirname(fileURLToPath(import.meta.url))
const sandbox = mkdtempSync(join(tmpdir(), 'pin-cool-'))
const cfgFile = join(sandbox, 'cfg.json')
const statsFile = join(sandbox, 'stats.json')

writeFileSync(cfgFile, JSON.stringify({ pinned: 'provA/beta' }), 'utf8')
writeFileSync(statsFile, JSON.stringify({
  version: 1,
  rows: {
    'provA/beta': {
      savedAt: Date.now(), attempts: 9, successes: 2, failures: 7,
      consecutiveFailures: 7, cooldownUntil: Date.now() + 3600000,
      lastError: 'quota', lastErrorKind: 'quota',
    },
  },
}), 'utf8')

process.env.DSH_MODEL_ROTATOR_CONFIG = cfgFile
process.env.DSH_MODEL_ROTOR_STATS = statsFile

const mod = await import('file:///' + join(HERE, 'index.js').replace(/\\/g, '/'))
const attempted = []
const listeners = []
const ctx = {
  logger: { warn: () => {} },
  get: () => undefined,
  on(event, fn) { if (event === 'llm/stream') listeners.push(fn) },
  tools: { register: () => () => {} },
  llm: {
    listProviders: () => [{ id: 'provA' }, { id: 'provB' }],
    registration: () => ({ adapter: { listModels: async q => ({ provA: [{ id: 'alpha' }, { id: 'beta' }], provB: [{ id: 'gamma' }] })[q] ?? [] } }),
    stream(o) {
      attempted.push(o.provider + '/' + o.model)
      return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } } })()
    },
  },
}

mod.apply(ctx, { confirmSwitch: false }, {})
let idx = 0
const options = { provider: 'provA', model: 'alpha', messages: [] }
const next = () => {
  const fn = listeners[idx++]
  return fn === undefined ? ctx.llm.stream(options) : fn(options, next)
}
for await (const _ of await next()) { /* drain */ }

console.log(JSON.stringify({ order: [...new Set(attempted)] }))
