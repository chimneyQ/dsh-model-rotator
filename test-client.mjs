
/**
 * Client-bundle contract tests.
 *
 * The settings page is rendered by client.js, the browser half of this plugin.
 * These tests keep the two halves from drifting apart:
 *
 *   1. the module-loader shape the harness requires (id, factory, exports);
 *   2. the fields client.js renders and stages are exactly the volatile fields
 *      the host serves for the 'model-rotator' namespace - a field without a
 *      spec throws "plugin card has no field <name>" inside the real form, and
 *      a spec without a control leaves the setting un-editable;
 *   3. apply() registers exactly one plugins.item card, for this namespace, and
 *      rendering it neither throws nor misses a field.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const profile = 'C:/Users/lenovo/.dsh/profiles/desktop'
const z = createRequire(join(profile, 'package.json'))('@deepseek-ai/schemastery')
// Self-relative: a hardcoded absolute path made this suite test the DEV tree
// instead of the tree it ships from, so the published bytes were never covered.
// dirname(fileURLToPath(import.meta.url)) is the directory this file lives in.
const pluginDir = dirname(fileURLToPath(import.meta.url)).replace(/\\\\/g, '/')
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

const { Config } = await import(pathToFileURL(join(pluginDir, 'index.js')).href)
const form = volatileForm(new z(Config.toJSON()))
const pageFields = Object.keys(form.dict).filter(key => key !== 'weights').sort()

// ---- 1. the module-loader shape --------------------------------------------
const source = readFileSync(join(pluginDir, 'client.js'), 'utf8')
let delivered
const fakeWindow = { __ModuleLoader__: { load: (entry) => { delivered = entry } } }
const prim = {
  SettingsForm: function SettingsForm() {},
  SettingsValueField: function SettingsValueField() {},
  Switch: function Switch() {},
  settingsNumberField: (field) => ({
    field,
    format: (value) => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }),
  SettingsFormModel: class {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = new Map(specs.map(spec => [spec.field, spec]))
      this.edits = []
      this.saves = 0
    }
    bind(project) { this.project = project; return { getSnapshot: () => this.project() } }
    shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false } }
    field(name) {
      const spec = this.specs.get(name)
      if (spec === undefined) throw new Error('plugin card has no field ' + name)
      const snapshot = this.scope.getSnapshot()
      return {
        text: spec.format(snapshot.value?.[name]),
        overridden: snapshot.user !== undefined && Object.hasOwn(snapshot.user, name),
        invalid: false,
      }
    }
    actions() {
      return {
        edit: (field, text) => { this.edits.push(['edit', field, text]) },
        resetField: (field) => { this.edits.push(['reset', field]) },
        save: () => { this.saves += 1 },
        discard: () => {},
      }
    }
    dispose() {}
  },
}
const requested = []
// Hooks are stubbed rather than executed: the point of this suite is the
// registration/render contract, and a real effect would fire the list's fetch.
const fakeReact = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
}
const require_ = (name) => {
  requested.push(name)
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime') {
    const element = (type, props) => ({ type, props })
    return { jsx: element, jsxs: element }
  }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return prim
  throw new Error('client.js required an unexpected module: ' + name)
}
new Function('window', source)(fakeWindow)
check('1a the bundle registers itself with the loader', delivered !== undefined && typeof delivered.factory === 'function')
check('1b the module id is the package name', delivered?.id === 'dsh-model-rotator', String(delivered?.id))
const mod = delivered.factory(require_)
check('1c exports apply and inject', typeof mod.apply === 'function' && Array.isArray(mod.inject))
check('1d inject asks for the shell services', JSON.stringify(mod.inject) === JSON.stringify(['slots', 'locale', 'configForms']), mod.inject.join(','))
check('1e require() pulls only static shell modules', requested.every(name => name === 'react' || name === 'react/jsx-runtime' || name === '@deepseek-ai/dsh-client-ui-primitives'), requested.join(','))

// ---- 2. apply() registers one card while the namespace is served ------------
const dictionaries = {}
const scopeSnapshots = {
  value: Object.fromEntries(pageFields.map(key => [key, form.dict[key].type === 'boolean' ? true : 7])),
  base: {},
  user: { maxCandidates: 7 },
}
const scope = { getSnapshot: () => scopeSnapshots }
const registered = []
let servedNamespaces
let usedNamespace
const ctx = {
  effect: (fn) => { fn() },
  locale: {
    bind: (ns) => (key) => ns + '.' + key,
    register: (ns, dict) => { dictionaries[ns] = dict },
  },
  configForms: {
    get: (ns) => { usedNamespace = ns; return scope },
    // Faithful gate: this Host serves NOTHING, so a gated registration would never
    // run. That is the deployment shape the gate used to hide the page in - silently,
    // with no error and zero cells. The page must register anyway and let the Host's
    // SettingsForm show its own "unavailable" line.
    whileServed: (namespaces, fn) => {
      const served = new Set([])
      if (namespaces.some(n => served.has(n))) fn(served)
      return () => {}
    },
  },
  slots: {
    inject: (name, fn) => fn(),
    register: (definition, Card) => { registered.push({ definition, Card }) },
  },
}
mod.apply(ctx)
check('2a the settings namespace is the plugin id', usedNamespace === 'model-rotator', String(usedNamespace))
check('2b the card registers even while the host serves no namespace', registered.length === 2, String(registered.length))
check('2b2 no registration is wrapped in a served-namespace gate', !/whileServed\s*\(/.test(source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'gate call present in code')
check('2c the form occupies the Settings nav cell and the Plugins card cell', registered.length === 2 && registered.map(r => r.definition.name).sort().join(',') === 'plugins.item,settings.section' && registered.every(r => r.definition.id === 'model-rotator'), JSON.stringify(registered.map(r => r.definition.name + '#' + r.definition.id)))
check('2d each cell carries a label, an order and the dictionary namespace', registered.every(r => typeof r.definition.label() === 'string' && r.definition.locale === mod.NS && Number.isFinite(r.definition.order)), JSON.stringify(registered.map(r => r.definition.order)))
check('2e both dictionaries are registered', Array.isArray(dictionaries[mod.NS]?.zh) === false && dictionaries[mod.NS]?.zh !== undefined && dictionaries[mod.NS]?.en !== undefined, Object.keys(dictionaries).join(','))

// ---- 3. rendering: every page field has a control, and only those -----------
// Both cells render the same component, so the form face is asserted once.
const settingsCell = registered.find(r => r.definition.name === 'settings.section')
// A missing settings cell must be REPORTED, not thrown: a crash here would suppress
// every result collected so far, hiding the assertion that actually failed (2b).
if (settingsCell === undefined) {
  check('2f the settings page is a Navigation cell of its own', false, 'no settings.section cell registered')
  console.log(results.map(([s, l, e]) => `${s}  ${l}${e ? '   [' + e + ']' : ''}`).join('\n'))
  console.log('')
  console.log('FAILED: registration contract broken - cannot continue to the render checks')
  process.exit(1)
}
check('2f the settings page is a Navigation cell of its own', settingsCell !== undefined && settingsCell.definition.order !== registered.find(r => r.definition.name === 'plugins.item').definition.order, String(settingsCell?.definition.order))
const face = settingsCell.definition.inject()
const t = (key) => key
// The slot turns each hooks entry into a "use<PascalCase>" prop, and adds the
// form actions beside it: that is the prop set the card really receives.
const cardProps = {
  t,
  useModelRotatorCard: (select) => select(face.hooks.modelRotatorCard.getSnapshot()),
  edit: face.edit,
  resetField: face.resetField,
  save: face.save,
  discard: face.discard,
}
check('3a the card is fed through a modelRotatorCard hook', JSON.stringify(Object.keys(face.hooks)) === JSON.stringify(['modelRotatorCard']), Object.keys(face.hooks).join(','))
check('3b the card is fed the form actions', typeof face.edit === 'function' && typeof face.resetField === 'function' && typeof face.save === 'function')
check('3c the summary view renders the one-liner', settingsCell.Card({ view: 'summary', ...cardProps }) === 'description')
// The Settings shell renders a section without a view prop: it must still
// produce the form rather than the one-liner.
const tree = settingsCell.Card({ ...cardProps })
const rendered = []
const boolRows = []
const walk = (node) => {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child); return }
  const props = node.props ?? {}
  if (typeof props.id === 'string' && props.id.startsWith('plugin-config-model-rotator-')) {
    rendered.push(props.id.slice('plugin-config-model-rotator-'.length))
  }
  if (props.spec !== undefined && typeof props.spec.field === 'string') boolRows.push(props.spec.field)
  // The walk sees the element, not the rendered component: the roster is
  // registered under its explicit key.
  if (props.key === '__models' || props["data-model-list"] === true) rendered.push('__models')
  if (typeof props.onEdit === 'function') { props.onEdit('1'); rendered.push('edit-wired') }
  walk(props.children)
}
let renderError = ''
try { walk(tree) } catch (error) { renderError = String(error) }
check('3d rendering the page does not throw', renderError === '', renderError)
check('3h the card renders the model roster beside the settings', rendered.includes('__models'), rendered.join(','))
const controls = rendered.filter(name => name !== 'edit-wired').sort()
const booleanFields = boolRows.sort()

const numberFields = controls.filter(name => booleanFields.includes(name) === false && name !== '__models')
check('3e every number setting has a value control', JSON.stringify(numberFields) === JSON.stringify(pageFields.filter(key => form.dict[key].type === 'number')), numberFields.join(','))
check('3f every boolean setting has a switch row', JSON.stringify(booleanFields) === JSON.stringify(pageFields.filter(key => form.dict[key].type === 'boolean')), booleanFields.join(','))
check('3g no control exists outside the served fields', [...numberFields, ...booleanFields].every(name => pageFields.includes(name)), [...numberFields, ...booleanFields].join(','))

// ---- 4. the staged specs cover exactly the served fields --------------------
const specNames = []
const numberSpec = /settingsNumberField\("([A-Za-z]+)"\)/g
const booleanSpec = /field: "([A-Za-z]+)", format: formatBoolean/g
let match
while ((match = numberSpec.exec(source)) !== null) specNames.push(match[1])
while ((match = booleanSpec.exec(source)) !== null) specNames.push(match[1])
specNames.sort()
check('4a the form stages exactly the served fields', JSON.stringify(specNames) === JSON.stringify(pageFields), specNames.join(','))
const numberParse = prim.settingsNumberField('maxCandidates').parse
check('4b a blank number clears the override', JSON.stringify(numberParse('  ')) === JSON.stringify({ kind: 'clear' }))
check('4c a number sets the override', JSON.stringify(numberParse(' 6 ')) === JSON.stringify({ kind: 'set', value: 6 }))
check('4d a non-number blocks the save', numberParse('abc') === undefined)

// The roster's half of the host contract: without these the list would render its
// empty state while the host answered perfectly.
check('4e the roster renders the grouped payload', /data\.groups/.test(source) && /models\.group\./.test(source), '')
check('4f the sections fold independently', /folded\[group\.key\]/.test(source) && /models\.groupHint\./.test(source), '')
check('4g the vision section starts folded', /vision: true/.test(source), '')
// The notice switch must be a real control on the page, not just a schema field.
check('4l the switch notice is on the page', /"noticeSwitch"/.test(source) && /field: "noticeSwitch"/.test(source), '')
// Each provider line folds on its own too, and the every-channel buttons write
// the same map - one key shape answers for both layers.
check('4h every provider line folds', /group\.key \+ "\/" \+ channel\.provider/.test(source) && /channelOpen = folded\[channelKey\]/.test(source), '')
check('4i a folded channel still reports its tally', /models\.counts/.test(source) && /tallyOf/.test(source), '')
// The host and this bundle are versioned together but not *loaded* together, so a
// stale host must not leave the roster blank.
check('4k sections are rebuilt when the host omits them', /Array\.isArray\(data\.groups\)/.test(source) && /Array\.isArray\(data\.channels\)/.test(source), '')
check('4j expand-all and collapse-all write both layers', /foldAll\(false\)/.test(source) && /foldAll\(true\)/.test(source), '')


// ---- 5. the roster actually renders and folds (a real hooks runtime) ----------
// A source regex proves a feature is mentioned; it cannot prove the feature works.
// This drives the component against a small payload with real state, real effects
// and real re-renders, and presses the buttons a reader would press.
{
  const store = []
  let cursor = 0
  let effects = []
  let dirty = false
  const runtime = {
    useState(initial) {
      const i = cursor++
      if (store[i] === undefined) store[i] = typeof initial === 'function' ? initial() : initial
      return [store[i], (next) => {
        const value = typeof next === 'function' ? next(store[i]) : next
        if (Object.is(value, store[i])) return
        store[i] = value
        dirty = true
      }]
    },
    useCallback(fn, deps) {
      const i = cursor++
      const prev = store[i]
      if (prev !== undefined && deps !== undefined && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]))) return prev.fn
      store[i] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const i = cursor++
      const prev = store[i]
      if (prev !== undefined && deps !== undefined && Array.isArray(prev.deps) && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]))) return prev.value
      const value = fn()
      store[i] = { value, deps }
      return value
    },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = store[i]
      if (Array.isArray(prev) && deps !== undefined && deps.length === prev.length && deps.every((d, k) => Object.is(d, prev[k]))) return
      store[i] = deps === undefined ? [] : deps
      effects.push(fn)
    },
  }

  // A payload shaped like the host's: two sections, a twin, and a resting peer.
  const payload = {
    at: 0,
    total: 4,
    inRotation: 3,
    models: [],
    groups: [
      { key: 'chat', models: 3, channels: [
        { provider: 'provA', channel: 'provA', kind: 'chat', sourceChannel: '', ok: 1, off: 0, resting: 1, models: [
          { key: 'provA/alpha', provider: 'provA', model: 'alpha', health: 'cooling', rest: 5, reason: '', lastErrorKind: 'rate-limit', attempts: 1, successes: 0, failures: 1, ttftMs: null, lastError: '', manual: '', inRotation: true, switchable: true },
          { key: 'provA/beta', provider: 'provA', model: 'beta', health: 'ok', rest: 0, reason: '', lastErrorKind: '', attempts: 1, successes: 1, failures: 0, ttftMs: 120, lastError: '', manual: '', inRotation: true, switchable: true },
        ] },
        { provider: 'provB', channel: 'provB', kind: 'chat', sourceChannel: '', ok: 1, off: 0, resting: 0, models: [
          { key: 'provB/gamma', provider: 'provB', model: 'gamma', health: 'ok', rest: 0, reason: '', lastErrorKind: '', attempts: 0, successes: 0, failures: 0, ttftMs: null, lastError: '', manual: '', inRotation: true, switchable: true },
        ] },
      ] },
      { key: 'vision', models: 1, channels: [
        { provider: 'provA-vision', channel: 'provA-vision', kind: 'vision', sourceChannel: 'provA', ok: 0, off: 1, resting: 0, models: [
          { key: 'provA-vision/alpha', provider: 'provA-vision', model: 'alpha', health: 'off', rest: 0, reason: 'vision', lastErrorKind: '', attempts: 0, successes: 0, failures: 0, ttftMs: null, lastError: '', manual: '', inRotation: false, switchable: true },
        ] },
      ] },
    ],
  }
  const dictionaries = {}
  const fetched = []
  globalThis.fetch = (url, init) => {
    fetched.push((init && init.method) || 'GET')
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
  }

  // Load the bundle again with the live runtime.
  let delivered2
  const win2 = { __ModuleLoader__: { load: (e) => { delivered2 = e } } }
  const require2 = (name) => {
    if (name === 'react') return runtime
    if (name === 'react/jsx-runtime') { const el = (type, props) => ({ type, props }); return { jsx: el, jsxs: el } }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return prim
    throw new Error('client.js required an unexpected module: ' + name)
  }
  new Function('window', source)(win2)
  const mod2 = delivered2.factory(require2)

  let Roster2 = null
  const ctx2 = {
    effect: (fn) => fn(),
    locale: { bind: (ns) => (k) => (dictionaries[ns] && dictionaries[ns].zh[k]) || k, register: (ns, d) => { dictionaries[ns] = d } },
    configForms: { get: () => scope, whileServed: (ns, fn) => fn() },
    slots: { inject: (n, fn) => fn(), register: (def, Component) => { if (def.name === 'settings.section') Roster2 = Component } },
  }
  mod2.apply(ctx2)
  const t2 = (key) => (dictionaries[mod2.NS] && dictionaries[mod2.NS].zh[key]) || key
  const props2 = { t: t2, useModelRotatorCard: (select) => select({ available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }), edit() {}, resetField() {}, save() {}, discard() {} }

  const HOSTCOMP = new Set([prim.SettingsForm, prim.SettingsValueField, prim.Switch])
  const expand = (node, out) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) expand(child, out); return }
    if (typeof node.type === 'function' && !HOSTCOMP.has(node.type)) { expand(node.type(node.props || {}), out); return }
    out.push(node)
    expand((node.props || {}).children, out)
  }
  const draw = () => {
    cursor = 0
    effects = []
    const root = Roster2(props2)
    const nodes = []
    expand(root, nodes)
    return { nodes, pending: effects }
  }
  const settle = async () => {
    let state = draw()
    for (let round = 0; round < 20; round++) {
      for (const fn of state.pending) fn()
      await new Promise((r) => setImmediate(r))
      if (!dirty) break
      dirty = false
      state = draw()
    }
    return state.nodes
  }
  const textOf = (node) => {
    const parts = []
    const walk = (n) => {
      if (n === null || n === undefined) return
      if (typeof n !== 'object') { parts.push(String(n)); return }
      if (Array.isArray(n)) { for (const c of n) walk(c); return }
      if (typeof n.type === 'function') { walk(n.type(n.props || {})); return }
      walk((n.props || {}).children)
    }
    walk((node.props || {}).children)
    return parts.join('')
  }
  const btns = (nodes) => nodes.filter((n) => n.type === 'button')
  const byLabel = (nodes, re) => btns(nodes).find((n) => re.test(textOf(n)))
  const click = (node) => node.props.onClick({ preventDefault() {}, stopPropagation() {} })

  let nodes = await settle()
  check('5a the roster renders its sections from the payload', btns(nodes).length > 4 && byLabel(nodes, /对话渠道/) !== undefined, 'buttons=' + btns(nodes).length)
  check('5b it fetches the list exactly once', fetched.length === 1, 'fetches=' + fetched.length)
  check('5c the vision section starts folded', !btns(nodes).some((n) => /-vision/.test(textOf(n))), '')
  const chatLine = btns(nodes).find((n) => /provA/.test(textOf(n)) && /个/.test(textOf(n)))
  // The tally is DERIVED from the rows, not copied from the payload's counters: a
  // stale or wrong host counter must not be able to misreport a channel.
  check('5d a channel line prints its tally', chatLine !== undefined && /可用 1/.test(textOf(chatLine)) && /冷却 1/.test(textOf(chatLine)), chatLine === undefined ? '' : textOf(chatLine))
  click(byLabel(nodes, /识图模式/))
  nodes = await settle()
  const twin = btns(nodes).find((n) => /provA-vision/.test(textOf(n)))
  check('5e a folded section reveals its channels on click', twin !== undefined, twin === undefined ? '' : textOf(twin))
  check('5f a twin names the channel it wraps', twin !== undefined && /provA/.test(textOf(twin).replace(/provA-vision/g, '')), twin === undefined ? '' : textOf(twin))
  click(byLabel(nodes, /全部收起/))
  nodes = await settle()
  check('5g collapse-all closes every channel', !btns(nodes).some((n) => /provA-vision/.test(textOf(n))) && !btns(nodes).some((n) => /^\s*provA\s*$/.test(textOf(n).replace(/^[\u25B2\u25BC\u25B6]\s*/, '').replace(/\s+\d+.*$/, ''))), btns(nodes).map(textOf).slice(0, 3).join(' | '))
  check('5h a closed section still reports its tally', btns(nodes).some((n) => /对话渠道/.test(textOf(n)) && /可用/.test(textOf(n))), '')
  click(byLabel(nodes, /全部展开/))
  nodes = await settle()
  check('5i expand-all reopens every channel', btns(nodes).some((n) => /provA-vision/.test(textOf(n))), '')

  // The channel switch: on every channel line, and it posts a provider-scoped
  // switch - while a model row still posts a model-scoped one.
  const postBodies = []
  const inner = globalThis.fetch
  globalThis.fetch = (url, init) => {
    if (init && init.method === 'POST') postBodies.push(JSON.parse(init.body))
    return inner(url, init)
  }
  const chBtn = btns(nodes).find((n) => /关闭本渠道|启用本渠道/.test(textOf(n)))
  check('5j every channel line carries a switch', chBtn !== undefined, chBtn === undefined ? '' : textOf(chBtn))
  const disableChannel = btns(nodes).filter((n) => /关闭本渠道/.test(textOf(n)))
  const allChannelSwitches = btns(nodes).filter((n) => /关闭本渠道|启用本渠道/.test(textOf(n)))
  // One per *chat* channel on screen. A vision channel carries none: its rows are
  // all kept out by the twin rule, which the channel flag cannot lift, so a button
  // there would write an entry that changes nothing while reading like a promise.
  check('5k one switch per chat channel, labelled by its own state', allChannelSwitches.length === 2 && disableChannel.length === 2, 'all=' + allChannelSwitches.length + ' close=' + disableChannel.length)
  const visionLine = btns(nodes).find((n) => /provA-vision/.test(textOf(n)) && /个/.test(textOf(n)))
  check('5r a vision channel offers no channel switch', visionLine !== undefined && !/本渠道/.test(textOf(visionLine)), visionLine === undefined ? '' : textOf(visionLine))
  click(disableChannel[0])
  await settle()
  check('5l the channel switch posts the provider scope', postBodies.some((b) => b.scope === 'provider' && typeof b.key === 'string' && b.key.indexOf('/') === -1), JSON.stringify(postBodies))
  const rowBtn = btns(nodes).find((n) => /^关闭$/.test(textOf(n)))
  if (rowBtn !== undefined) { click(rowBtn); await settle() }
  check('5m a model row still posts the model scope', postBodies.some((b) => b.scope === 'model'), JSON.stringify(postBodies.slice(-2)))
  // The button's direction, not just its shape: a channel offered as "关闭本渠道"
  // must post enabled=false. Posting the state it already has is a no-op, which is
  // exactly how the button looked broken while the route was working perfectly.
  check('5n closing a channel posts enabled=false', postBodies.some((b) => b.scope === 'provider' && b.enabled === false), JSON.stringify(postBodies))
  // The label follows the channel's own switch rather than the rows: a channel the
  // host reports as closed has to offer the action that reopens it, even while its
  // rows still read as in rotation.
  payload.groups[0].channels[0].switchedOff = true
  nodes = await settle()
  const reopen = btns(nodes).find((n) => /启用本渠道/.test(textOf(n)))
  check('5p a closed channel offers to reopen', reopen !== undefined, btns(nodes).filter((n) => /本渠道/.test(textOf(n))).map(textOf).join(' | '))
  if (reopen !== undefined) { click(reopen); await settle() }
  check('5o reopening a channel posts enabled=true', postBodies.some((b) => b.scope === 'provider' && b.enabled === true), JSON.stringify(postBodies.slice(-2)))
  delete globalThis.fetch
}

// ---- report ------------------------------------------------------------------
let failed = 0
for (const [status, label, extra] of results) {
  if (status === 'FAIL') failed += 1
  console.log(status.padEnd(5), label, extra === '' ? '' : ' [' + extra + ']')
}
console.log('')
console.log(failed === 0 ? 'ALL PASS (' + results.length + ')' : failed + ' FAILED of ' + results.length)
process.exit(failed === 0 ? 0 : 1)