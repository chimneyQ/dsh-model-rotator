
/**
 * Settings-page contract tests.
 *
 * Two things are asserted here, and both are about the host's rules rather than
 * this plugin's opinion of them:
 *
 *   1. the exported Config survives the host's volatileForm() walk and yields
 *      exactly the intended page fields (a non-volatile sibling is dropped);
 *   2. the page layer outranks config.json for page-owned keys, while a key the
 *      page does not own still comes from the file.
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const profile = 'C:/Users/lenovo/.dsh/profiles/desktop'
const req = createRequire(join(profile, 'package.json'))
const z = req('@deepseek-ai/schemastery')
const ck = req('@deepseek-ai/cosmokit')

const results = []
const check = (label, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', label, extra])

// ---- the host's volatileForm(), copied from the shipped implementation -------
function plainSchema(schema) {
  const copy = new z(schema.toJSON())
  const strip = node => {
    if (node === null || typeof node !== 'object') return
    if (node.meta !== undefined) delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) strip(child)
  }
  strip(copy)
  return copy
}
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}

const tmp = mkdtempSync(join(tmpdir(), 'rotator-settings-'))
const cfgPath = join(tmp, 'config.json')
process.env.DSH_MODEL_ROTATOR_CONFIG = cfgPath

const { apply, Config } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'index.js')).href)

// ---- 1. the schema the host will read ---------------------------------------
check('1a Config is exported (page exists at all)', Config !== undefined && typeof Config.toJSON === 'function')
const form = volatileForm(new z(Config.toJSON()))
check('1b volatileForm keeps the schema', form !== undefined)
const kept = Object.keys(form?.dict ?? {}).sort()
check('1c exactly the intended top-level fields', JSON.stringify(kept) === JSON.stringify(['adoptSwitchedModel', 'allowImageFailover', 'confirmSwitch', 'confirmTimeoutMs', 'cooldownBaseMs', 'enabled', 'maxCandidates', 'maxCooldownMs', 'noticeSwitch', 'preferSameModel', 'quotaCooldownHour', 'quotaCooldownMs', 'retriesPerModel', 'retryBackoffMs', 'statsPersistTtlMs', 'weights']), kept.join(','))
const weightKeys = Object.keys(form?.dict?.weights?.dict ?? {}).sort()
check('1d weights exposes its two leaves as fields', JSON.stringify(weightKeys) === JSON.stringify(['connectivity', 'speed']), weightKeys.join(','))
check('1e the walk leaves each kept leaf a usable schema', form?.dict?.weights?.dict?.connectivity?.type === 'number' && form?.dict?.enabled?.type === 'boolean', 'leaf=' + String(form?.dict?.weights?.dict?.connectivity?.type))
check('1g the consent fields survive as boolean and number', form?.dict?.confirmSwitch?.type === 'boolean' && form?.dict?.confirmTimeoutMs?.type === 'number', 'switch=' + String(form?.dict?.confirmSwitch?.type) + ' timeout=' + String(form?.dict?.confirmTimeoutMs?.type))
check('1h the session-adoption field is a boolean switch', form?.dict?.adoptSwitchedModel?.type === 'boolean', 'adopt=' + String(form?.dict?.adoptSwitchedModel?.type))
check('1i the switch-notice field is a boolean switch', form?.dict?.noticeSwitch?.type === 'boolean', 'notice=' + String(form?.dict?.noticeSwitch?.type))

// control: a plain sibling must be dropped by the same walk
{
  const control = z.object({ shown: z.boolean().default(true).volatile(), hidden: z.number().default(1) })
  const keptControl = Object.keys(volatileForm(control)?.dict ?? {})
  check('1f volatileForm drops a non-volatile sibling', JSON.stringify(keptControl) === JSON.stringify(['shown']), keptControl.join(','))
}

// ---- 2. live handles: page beats file, file fills what the page omits --------
const handle = value => ck.createVolatile(value)
const listeners = []
const ctx = {
  logger: { warn: () => {} },
  get: () => undefined,
  on(event, fn) { if (event === 'llm/stream') listeners.push(fn) },
  tools: { register: () => () => {} },
  llm: {
    listProviders: () => [],
    registration: () => ({ adapter: { listModels: async () => [] } }),
    stream() { return (async function* () {})() },
  },
}

// The file layer: enabled true, a custom cooldown the page does not own, and a
// maxCandidates the page is about to override.
writeFileSync(cfgPath, JSON.stringify({ enabled: true, maxCandidates: 2, cooldownBaseMs: 123456 }), 'utf8')

// The page layer, exactly as the host would hand it over: live handles.
const pageConfig = {
  enabled: handle(false),
  maxCandidates: handle(6),
  weights: { connectivity: handle(0.9), speed: handle(0.1) },
}

apply(ctx, pageConfig, {})
const status = await (async () => {
  // Registering a tool returns nothing here, so read the effect through a fresh
  // apply on a ctx that captures the definition.
  let def
  const ctx2 = { ...ctx, tools: { register: d => { if (d.name === 'model_rotator_status') def = d; return () => {} } } }
  apply(ctx2, pageConfig, {})
  return await def.execute({}, {})
})()

check('2a page value wins over the file (enabled false)', /enabled\s*:\s*false/.test(status), status.split('\n')[1] ?? '')
check('2b page value wins over the file (maxCandidates 6)', /maxCandidates\s*:\s*6/.test(status), status.split('\n').find(l => l.includes('maxCandidates')) ?? '')
check('2c file value survives for a key the page omits', /cooldown base\/cap: 123456ms/.test(status), status.split('\n').find(l => l.includes('cooldown')) ?? '')
check('2d status reports the page as live', /settings page\s*:\s*live/.test(status), '')
check('2e status flags the file keys the page shadows', /also sets enabled, maxCandidates/.test(status), status.split('\n').find(l => l.includes('note')) ?? 'none')

// ---- the effective-config block names the layer that won ----------------------
check('5a status shows an effective-config block', /in force right now/.test(status), '')
check('5b a page-owned key is attributed to the page', /^\s*enabled\s*:\s*false\s*\[settings page\]$/m.test(status), status.split('\n').find(l => l.includes('enabled')) ?? '')
check('5c a file-only key is attributed to config.json', /^\s*cooldownBaseMs\s*:\s*123456\s*\[config\.json\]$/m.test(status), status.split('\n').find(l => l.includes('cooldownBaseMs')) ?? '')
check('5d a key nobody set is attributed to the defaults', /^\s*confirmTimeoutMs\s*:\s*20000\s*\[default\]$/m.test(status), status.split('\n').find(l => l.includes('confirmTimeoutMs')) ?? '')
check('5e the page value shown is the value that drives the plugin', /^\s*maxCandidates\s*:\s*6\s*\[settings page\]$/m.test(status), '')
check('5f confirmSwitch reports the ask-first policy', /switch confirm\s*:\s*ask first/.test(status), status.split('\n').find(l => l.includes('switch confirm')) ?? '')
check('5i the session-adoption policy is reported', /adopt on switch\s*:\s*yes/.test(status), status.split('\n').find(l => l.includes('adopt on switch')) ?? '')
check('5k the failure-verdict policy is reported', /failure verdict\s*:\s*the model gets 2 more tries/.test(status), status.split('\n').find(l => l.includes('failure verdict')) ?? '')
check('5l the switch order policy is reported', /switch order\s*:\s*the same model on another provider first/.test(status), status.split('\n').find(l => l.includes('switch order')) ?? '')
check('5m the quota rest policy is reported', /quota rest\s*:\s*until the next day at 00:00 local, at least 720min/.test(status), status.split('\n').find(l => l.includes('quota rest')) ?? '')
check('5n a quota field is attributed to the defaults', /^\s*quotaCooldownHour\s*:\s*0\s*\[default\]$/m.test(status), status.split('\n').find(l => l.includes('quotaCooldownHour')) ?? '')
check('5o the persistence horizon is attributed to the defaults', /^\s*statsPersistTtlMs\s*:\s*86400000\s*\[default\]$/m.test(status), status.split('\n').find(l => l.includes('statsPersistTtlMs')) ?? '')
check('5j status names the model in use and the session seam', /model in use now\s*:\s*\(no live session\)/.test(status) && /session switch\s*:\s*unavailable/.test(status), status.split('\n').filter(l => /in use now|session switch/.test(l)).join(' | '))

// ---- 3. a file write never parks a page-owned key ---------------------------
{
  const tools = {}
  const ctx3 = { ...ctx, tools: { register: d => { tools[d.name] = d; return () => {} } } }
  apply(ctx3, pageConfig, {})
  // Start from a file that carries no page-owned key at all, so any that shows
  // up afterwards must have come from this write.
  writeFileSync(cfgPath, JSON.stringify({ pinned: '' }), 'utf8')
  await tools.model_rotator_select.execute({ target: 'p/m' }, {})
  const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'))
  check('3a pin is written to the file', onDisk.pinned === 'p/m', JSON.stringify(onDisk.pinned))
  const owned = ['enabled', 'allowImageFailover', 'maxCandidates', 'cooldownBaseMs', 'maxCooldownMs', 'quotaCooldownMs', 'quotaCooldownHour', 'statsPersistTtlMs', 'confirmSwitch', 'confirmTimeoutMs', 'adoptSwitchedModel', 'retriesPerModel', 'retryBackoffMs', 'preferSameModel']
  check('3b a write never adds a page-owned key', owned.every(k => onDisk[k] === undefined) && onDisk.weights === undefined, JSON.stringify(onDisk))
}

// ---- 4. no page at all: the file alone still drives everything --------------
{
  // Block 3 rewrote the file; restore the fixture this block is about.
  writeFileSync(cfgPath, JSON.stringify({ enabled: true, maxCandidates: 2, cooldownBaseMs: 123456 }), 'utf8')
  let def
  const ctx4 = { ...ctx, tools: { register: d => { if (d.name === 'model_rotator_status') def = d; return () => {} } } }
  apply(ctx4, {}, {})
  const status4 = await def.execute({}, {})
  check('4a with no page config the file drives enabled', /enabled\s*:\s*true/.test(status4), status4.split('\n')[1] ?? '')
  check('4b with no page config the file drives maxCandidates', /maxCandidates\s*:\s*2/.test(status4), '')
  check('4c no shadow note when the page sets nothing', !/note\s*:/.test(status4), '')
  check('5g with no page the file wins its own key', /^\s*cooldownBaseMs\s*:\s*123456\s*\[config\.json\]$/m.test(status4), status4.split('\n').find(l => l.includes('cooldownBaseMs')) ?? '')
  check('5h with no page a page key falls back to the file', /^\s*enabled\s*:\s*true\s*\[config\.json\]$/m.test(status4), status4.split('\n').find(l => l.includes('enabled')) ?? '')
}

rmSync(tmp, { recursive: true, force: true })

const failed = results.filter(r => r[0] === 'FAIL')
for (const r of results) console.log(r[0] + '  ' + r[1] + (r[2] ? '   [' + r[2] + ']' : ''))
console.log('\n' + (failed.length === 0 ? 'ALL PASS (' + results.length + ')' : failed.length + ' FAILED of ' + results.length))
process.exit(failed.length === 0 ? 0 : 1)
