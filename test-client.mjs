
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
check('4h every provider line folds', /group\.key \+ "\/" \+ channel\.provider/.test(source) && /channelOpen = (?:searching \|\| )?folded\[channelKey\]/.test(source), '')

// ---- 4m-4q. the model search box -------------------------------------------
// The roster is ~900 rows, so a reader hunting one name needs a filter. These
// assert the wiring (a source regex) and, further down, the behaviour against
// the real hooks runtime: a filter that renders but never narrows the rows is
// worse than no filter, because it says it did something.
check('4m the search box is rendered with its own state', /const \[query, setQuery\] = React\.useState/.test(source) && /type: "search"/.test(source), '')
check('4n the query ranks rows on "provider/model", token by token', /const rankOf = \(row\) =>/.test(source) && /split\(\/\\s\+\/\)\.map\(normSearch\)/.test(source) && /const tier = token\.length === 1 && !solo/.test(source), '')
check('4n5 a lone character is word-anchored inside a multi-term query', /const solo = tokens\.length === 1/.test(source) && /const startsWord = \(raw, token\) =>/.test(source), '')
check('4n2 matching is normalised before comparing', /const normSearch = \(value\) =>/.test(source) && /replace\(SEPARATORS, ""\)/.test(source), '')
check('4n3 a subsequence fallback exists and is length-guarded', /const isSubsequence = \(s, q\) =>/.test(source) && /token\.length >= 2 && isSubsequence/.test(source), '')
check('4n4 a weaker token sorts the row lower, and matches rank above fallbacks', /weakest/.test(source) && /b\.rank - a\.rank/.test(source), '')
check('4o a match forces the folds open', /const searching = query\.trim\(\) !== ""/.test(source) && /const shown = searching \|\| folded/.test(source), '')
check('4p a channel with no match is dropped', /const matched = group\.channels\.filter/.test(source), '')
check('4q the hit counter and empty state are wired', /models\.searchHits/.test(source) && /models\.searchNone/.test(source), '')
check('4r every search key is present in both dictionaries', (() => {
  const keys = ['models.search', 'models.searchClear', 'models.searchHits', 'models.searchNone']
  return keys.every((k) => {
    const zh = new RegExp('"' + k + '":').test(source)
    const enBlock = source.slice(source.indexOf('const en = {'))
    return zh && new RegExp('"' + k + '":').test(enBlock)
  })
})(), '')
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
    // The host sends the flat roster alongside the grouped view; the counter reads
    // it. Left empty here it exercised the section-walk fallback instead, so both
    // shapes are covered: this one is filled, and 5v2 below empties it again.
    models: [
      { key: 'provA/alpha', provider: 'provA', model: 'alpha', health: 'cooling', inRotation: true, switchable: true },
      { key: 'provA/beta', provider: 'provA', model: 'beta', health: 'ok', inRotation: true, switchable: true },
      { key: 'provB/gamma', provider: 'provB', model: 'gamma', health: 'ok', inRotation: true, switchable: true },
      { key: 'provA-vision/alpha', provider: 'provA-vision', model: 'alpha', health: 'off', inRotation: false, switchable: true },
      // A pair that separates the two tiers: "deepseek-flash" matches the token
      // "dsflash" only as a subsequence, while "ds-flash" matches it normalised.
      { key: 'provC/deepseek-flash', provider: 'provC', model: 'deepseek-flash', health: 'ok', inRotation: true, switchable: true },
      { key: 'provC/ds-flash', provider: 'provC', model: 'ds-flash', health: 'ok', inRotation: true, switchable: true },
      { key: 'provC/zzz-none', provider: 'provC', model: 'zzz-none', health: 'ok', inRotation: true, switchable: true },
    ],
    groups: [
      { key: 'chat', models: 3, channels: [
        { provider: 'provA', channel: 'provA', kind: 'chat', sourceChannel: '', ok: 1, off: 0, resting: 1, models: [
          { key: 'provA/alpha', provider: 'provA', model: 'alpha', health: 'cooling', rest: 5, reason: '', lastErrorKind: 'rate-limit', attempts: 1, successes: 0, failures: 1, ttftMs: null, lastError: '', manual: '', inRotation: true, switchable: true },
          { key: 'provA/beta', provider: 'provA', model: 'beta', health: 'ok', rest: 0, reason: '', lastErrorKind: '', attempts: 1, successes: 1, failures: 0, ttftMs: 120, lastError: '', manual: '', inRotation: true, switchable: true },
        ] },
        { provider: 'provB', channel: 'provB', kind: 'chat', sourceChannel: '', ok: 1, off: 0, resting: 0, models: [
          { key: 'provB/gamma', provider: 'provB', model: 'gamma', health: 'ok', rest: 0, reason: '', lastErrorKind: '', attempts: 0, successes: 0, failures: 0, ttftMs: null, lastError: '', manual: '', inRotation: true, switchable: true },
        ] },
        { provider: 'provC', channel: 'provC', kind: 'chat', sourceChannel: '', ok: 3, off: 0, resting: 0, models: [
          { key: 'provC/deepseek-flash', provider: 'provC', model: 'deepseek-flash', health: 'ok', rest: 0, reason: '', lastErrorKind: '', attempts: 1, successes: 1, failures: 0, ttftMs: 100, lastError: '', manual: '', inRotation: true, switchable: true },
          { key: 'provC/ds-flash', provider: 'provC', model: 'ds-flash', health: 'ok', rest: 0, reason: '', lastErrorKind: '', attempts: 1, successes: 1, failures: 0, ttftMs: 100, lastError: '', manual: '', inRotation: true, switchable: true },
          { key: 'provC/zzz-none', provider: 'provC', model: 'zzz-none', health: 'ok', rest: 0, reason: '', lastErrorKind: '', attempts: 1, successes: 1, failures: 0, ttftMs: 100, lastError: '', manual: '', inRotation: true, switchable: true },
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
  check('5k one switch per chat channel, labelled by its own state', allChannelSwitches.length === 3 && disableChannel.length === 3, 'all=' + allChannelSwitches.length + ' close=' + disableChannel.length)
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

  // ---- 5r-5z. the search box narrows the roster (real typing, real re-render) --
  // A filter is only worth having if the rows actually change. This types into the
  // box and re-renders, so a box that renders but does not filter fails here.
  const findInput = (nodes) => nodes.find((n) => n.type === 'input' && n.props && n.props.type === 'search')
  // A model-name cell is the monospace span inside a row (see modelNameStyle);
  // selecting on that is what keeps this from also collecting the section titles.
  const typedModelNames = (nodes) => nodes
    .filter((n) => n.type === 'span' && n.props && n.props.style && n.props.style.fontFamily === 'monospace')
    .map((n) => textOf(n))
  // Reset the channel switch so the payload is the open, unfiltered roster again.
  delete payload.groups[0].channels[0].switchedOff
  let fnodes = await settle()

  const box = findInput(fnodes)
  check('5r the roster renders a search input', box !== undefined, fnodes.filter((n) => n.type === 'input').length + ' input(s)')
  check('5s the box is empty by default and the full roster shows', box !== undefined && box.props.value === '', box ? JSON.stringify(box.props.value) : 'no box')

  // The unfiltered baseline the filtered count is compared against.
  const rowCountAt = (nodes) => nodes.filter((n) => n.type === 'div' && n.props && n.props.style && n.props.style.display === 'flex' && n.props.style.borderTop !== undefined && n.props.style.gap === '10px').length
  const fullRowCount = rowCountAt(fnodes)

  if (box !== undefined) {
    // Type "gamma": only provB/gamma may survive.
    box.props.onChange({ target: { value: 'gamma' } })
    fnodes = await settle()
    const names = typedModelNames(fnodes)
    // A row is the monospace name span; counting them is what makes this fail when
    // the filter is bypassed. The unfiltered roster rendered 4 rows, so a passing
    // filter must render exactly 1 here.
    // A model row is the flex div the ModelList builds per row (modelRowStyle).
    // Counting those is what notices a bypassed filter; counting spans also caught
    // the channel tally, which is monospace too.
    const rowCount = (nodes) => nodes.filter((n) => n.type === 'div' && n.props && n.props.style && n.props.style.display === 'flex' && n.props.style.borderTop !== undefined && n.props.style.gap === '10px').length
    check('5t a query hides rows that do not match', names.some((n) => /gamma/.test(n)) && !names.some((n) => /beta/.test(n)) && rowCountAt(fnodes) === 1 && fullRowCount > 1, 'rows=' + rowCountAt(fnodes) + '/' + fullRowCount + ' ' + JSON.stringify(names.slice(0, 6)))
    // The section must still be visible so the hit is reachable even though chat
    // starts open and vision starts folded - the filter opens them.
    const chatHead = byLabel(fnodes, /对话渠道|chat/i)
    check('5u a matching section stays on screen', chatHead !== undefined, fnodes.filter((n) => n.type === 'button').length + ' buttons')
    // The hit counter must say 1 of N.
    // The dictionary line is "命中 {n} / {total} 个模型"; only provB/gamma matches.
    // The line is "命中 {n} / {total} 个模型". n must be the narrowed count (1),
    // and total must be the payload's 4 - a total of 0 was a real bug (the counter
    // read a binding that had not been assigned yet on first paint).
    const counter = fnodes.map(textOf).find((x) => /命中\s*1\s*\/\s*4/.test(x))
    check('5v the hit counter reports the narrowed count', counter !== undefined, JSON.stringify(fnodes.map(textOf).filter((x) => /命中|match/.test(x)).slice(0, 2)))
    // A query matching nothing must say so rather than render an empty list.
    box.props.onChange({ target: { value: 'zzz-no-such-model-9f3a' } })
    fnodes = await settle()
    check('5w a query with no match reports it', fnodes.some((n) => /没有匹配|No model/.test(textOf(n))), fnodes.map(textOf).filter((x) => /匹配|match/.test(x)).join(' | '))
    // A channel that partially matches proves the row filter is doing work: provA
    // owns alpha AND beta, so searching "beta" must leave one row in that channel,
    // not two. Coverage here is what the channel-level drop cannot mask.
    box.props.onChange({ target: { value: 'beta' } })
    fnodes = await settle()
    check('5v2 a partially matching channel renders only the matching rows', rowCountAt(fnodes) === 1, 'rows=' + rowCountAt(fnodes))

    // Two words are two tokens, not one substring: "provA gamma" must match the row
    // whose provider and model are exactly those, and must NOT match on the joined
    // string alone. Before this the box matched the query whole, so a space anywhere
    // matched nothing at all.
    box.props.onChange({ target: { value: 'provB gamma' } })
    fnodes = await settle()
    check('5v3 a multi-word query requires every token', rowCountAt(fnodes) === 1 && typedModelNames(fnodes).some((n) => /gamma/.test(n)), 'rows=' + rowCountAt(fnodes) + ' ' + JSON.stringify(typedModelNames(fnodes).slice(0, 4)))
    box.props.onChange({ target: { value: 'provB alpha' } })
    fnodes = await settle()
    check('5v4 a multi-word query with one unmatched token matches nothing', rowCountAt(fnodes) === 0, 'rows=' + rowCountAt(fnodes))
    box.props.onChange({ target: { value: '  gamma  ' } })
    fnodes = await settle()
    check('5v5 surrounding whitespace does not change the result', rowCountAt(fnodes) === 1, 'rows=' + rowCountAt(fnodes))
    box.props.onChange({ target: { value: 'GAMMA provB' } })
    fnodes = await settle()
    check('5v6 token order does not matter and case is folded', rowCountAt(fnodes) === 1, 'rows=' + rowCountAt(fnodes))

    // ---- 5w1-5w5. normalisation, tiering and the guarded fallback --------------
    // "dsflash" has no separator-free substring of "deepseek-flash"? It does after
    // normalisation: deepseekflash contains dsflash. Both provC rows match, and the
    // normalised one must sort first.
    box.props.onChange({ target: { value: 'dsflash' } })
    fnodes = await settle()
    const dsRows = typedModelNames(fnodes).filter((n) => /flash/.test(n) && !/gamma|beta|alpha/.test(n))
    check('5w1 a separator-free query reaches a hyphenated name', dsRows.length >= 2, JSON.stringify(dsRows.slice(0, 4)))
    check('5w2 the precise match outranks the fallback', dsRows[0] === 'ds-flash', JSON.stringify(dsRows.slice(0, 4)))

    // The subsequence fallback still reaches a row no substring would: after
    // normalisation "provcdeepseekflash" holds d..p..k in order, so "dpk" - a
    // genuine abbreviation - matches a name that contains "dpk" nowhere.
    box.props.onChange({ target: { value: 'dpk' } })
    fnodes = await settle()
    check('5w3 the fallback reaches a row no substring matches', typedModelNames(fnodes).some((n) => /deepseek-flash/.test(n)), JSON.stringify(typedModelNames(fnodes).slice(0, 4)))

    // A one-character query must NOT use the fallback: it would match the roster at
    // random. "q" is a subsequence of several fixture names and a substring of
    // none, so substring-only leaves the list empty - which is the assertion.
    box.props.onChange({ target: { value: 'q' } })
    fnodes = await settle()
    check('5w4 a single character does not trigger the fallback', rowCountAt(fnodes) === 0, 'rows=' + rowCountAt(fnodes))

    // And an unmatched query still matches nothing.
    box.props.onChange({ target: { value: 'qqqq' } })
    fnodes = await settle()
    check('5w5 a query with no match at any tier reports nothing', rowCountAt(fnodes) === 0, 'rows=' + rowCountAt(fnodes))

    // A one-character term inside a multi-word query must be word-anchored, or the
    // AND is fiction: measured on the live roster, 25 of 36 characters match more
    // than 200 of 950 names, so "a b" still returned 264 rows before this rule.
    // provC has "ds-flash" (a word starting with d) and "deepseek-flash" (no word
    // starts with d), so a query of "z d" separates them.
    // "a a" is the probe that actually separates the two rules in this fixture.
    // "a" is a plain substring of five names (alpha, beta, gamma, deepseek-flash,
    // ds-flash) and a word start in exactly one (alpha), so a substring rule answers
    // with five rows and word-anchoring with one. An earlier "zzz d" probe did NOT
    // separate them - d is both a substring and a word start in the same rows - and
    // it passed against the broken build.
    box.props.onChange({ target: { value: 'a a' } })
    fnodes = await settle()
    // Two rows, not one: the fixture carries an alpha in BOTH sections (provA/alpha
    // and the vision twin provA-vision/alpha), and a query forces the vision section
    // open. Both are alpha, which is the point - a substring rule would also drag in
    // beta, gamma and the two flash names through a bare "a".
    const alphaRows = typedModelNames(fnodes).filter((n) => /alpha/.test(n))
    check('5w6 a one-character term inside a multi-word query is word-anchored', rowCountAt(fnodes) === 2 && alphaRows.length === 2, 'rows=' + rowCountAt(fnodes) + ' ' + JSON.stringify(typedModelNames(fnodes).slice(0, 6)))
    // And a lone one-character query still behaves as a plain substring search.
    box.props.onChange({ target: { value: 'g' } })
    fnodes = await settle()
    check('5w7 a lone character is still a plain substring search', typedModelNames(fnodes).some((n) => /gamma/.test(n)), JSON.stringify(typedModelNames(fnodes).slice(0, 3)))
    box.props.onChange({ target: { value: '' } })
    fnodes = await settle()

    // Now the same query with the flat roster removed: the counter must fall back to
    // walking the sections, or it reports "no match" while matching rows are shown.
    const savedModels = payload.models
    payload.models = []
    box.props.onChange({ target: { value: 'gamma' } })
    fnodes = await settle()
    check('5w2 the counter falls back when the host sends no flat roster', fnodes.map(textOf).some((x) => /命中\s*1\s*\/\s*4/.test(x)), JSON.stringify(fnodes.map(textOf).filter((x) => /命中|match|匹配/.test(x)).slice(0, 2)))
    payload.models = savedModels
    box.props.onChange({ target: { value: 'zzz-no-such-model-9f3a' } })
    fnodes = await settle()
    // Clearing the box brings the whole roster back.
    box.props.onChange({ target: { value: '' } })
    fnodes = await settle()
    const backNames = typedModelNames(fnodes)
    check('5x clearing the query restores every row', backNames.some((n) => /gamma/.test(n)) && backNames.some((n) => /beta/.test(n)) && backNames.some((n) => /alpha/.test(n)), JSON.stringify(backNames.slice(0, 6)))
    // Match is case-insensitive.
    box.props.onChange({ target: { value: 'GAMMA' } })
    fnodes = await settle()
    check('5y the match is case-insensitive', typedModelNames(fnodes).some((n) => /gamma/.test(n)), JSON.stringify(typedModelNames(fnodes).slice(0, 4)))
    // And the clear button exists once something is typed.
    box.props.onChange({ target: { value: 'gamma' } })
    fnodes = await settle()
    const clearBtn = fnodes.find((n) => n.type === 'button' && /清除|Clear/.test(textOf(n)))
    check('5z a typed query offers a clear button', clearBtn !== undefined, '')
    if (clearBtn !== undefined) {
      clearBtn.props.onClick()
      fnodes = await settle()
      check('5z2 the clear button empties the box', findInput(fnodes).props.value === '', JSON.stringify(findInput(fnodes).props.value))
    }
  }
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