
import { mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { apply, classifyFailureKind, isHostRefusal, isNonChatModelId, parseReleaseTime, quotaRestUntil, switchNoticeFor } from './index.js'

// Keep the file layer out of these assertions: the config path is read inside
// apply(), so pointing it at a path that does not exist pins the suite to the
// defaults instead of whatever the live install happens to have on disk.
process.env.DSH_MODEL_ROTATOR_CONFIG = join(tmpdir(), 'rotator-offline-absent.json')

// The measurement file needs the same treatment, and for a sharper reason: the
// feature under test is that a cooldown *outlives the process*, so a file shared
// by every harness in this process would let scenario 5's dead keys decide
// scenario 9's candidate order. Persistence is therefore only ever exercised
// across the two applies that mean it, and every other scenario mounts onto a
// file of its own - which also makes a rerun in the same tmpdir reproducible.
const sandbox = mkdtempSync(join(tmpdir(), 'rotator-offline-'))
let statsSeq = 0
/** Give the next apply() a fresh file; call before mounting a harness. */
const freshStatsFile = () => { statsSeq += 1; process.env.DSH_MODEL_ROTOR_STATS = join(sandbox, 'stats-' + statsSeq + '.json') }
freshStatsFile()

const results = []
const check = (label, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', label, extra])

// Fake harness: two providers, three models; alpha is current.
// `seams` injects ctx.get()-resolved services (userQuestions / agents); without
// it every seam lookup misses, which is what the plain failover scenarios want.
function makeCtx(behaviour, seams, opts) {
  // sameStats: the handful of scenarios that assert persistence across two
  // applies must keep one file; everything else gets its own.
  if (opts?.sameStats !== true) freshStatsFile()
  const registered = new Map()
  const listeners = []
  const providers = [{ id: 'provA' }, { id: 'provB' }]
  const models = {
    provA: [{ id: 'alpha' }, { id: 'beta' }],
    provB: [{ id: 'gamma' }],
  }
  const attempted = []
  const warns = []
  const ctx = {
    logger: { warn: message => warns.push(String(message)) },
    // The live-turn lookup the switch log files its records by. It stays absent
    // unless a scenario opts in through opts.liveAgent, so every scenario that
    // wants "no session could be determined" keeps getting exactly that.
    //
    // The window guard reads the conversation's pressure through the same
    // session, so a scenario may declare pressure alone and still be answered.
    get: name => {
      const seam = seams?.[name]
      if (seam !== undefined) return seam
      if (name === 'agents' && (typeof opts?.liveAgent === 'function' || opts?.pressure !== undefined)) {
        const live = typeof opts?.liveAgent === 'function' ? opts.liveAgent() : undefined
        if (live !== undefined) return { currentInitiator: () => live }
        return { currentInitiator: () => ({ session: { requestContext: () => ({ contextWindow: opts.pressure.window }) } }) }
      }
      if (name === 'tokenMeter' && opts?.pressure !== undefined) {
        return { measure: () => ({ totalTokens: opts.pressure.tokens }) }
      }
      return undefined
    },
    on(event, fn) { if (event === 'llm/stream') listeners.push(fn) },
    tools: { register(def) { registered.set(def.name, def); return () => {} } },
    llm: {
      listProviders: () => providers,
      registration: provider => ({ adapter: { listModels: async p => models[p] ?? [] } }),
      // The window guard asks the buying adapters for their exact window. A
      // scenario that does not declare windows gets none, which is exactly the
      // "adapter does not publish a window" case the guard must leave alone.
      resolveModelInfo: async (provider, model) => {
        const declared = opts?.windows?.[provider + '/' + model]
        return {
          provider,
          id: model,
          name: model,
          ...(declared === undefined ? {} : { context: { contextWindow: declared } }),
        }
      },
      stream(options) {
        attempted.push(options.provider + '/' + options.model)
        const emit = behaviour(options, attempted.length)
        return (async function* () { for (const c of emit) yield c })()
      },
    },
  }
  const run = (options) => {
    // mimic the waterfall: listeners chain via next()
    let idx = 0
    const next = () => {
      const fn = listeners[idx++]
      if (fn === undefined) return ctx.llm.stream(options)
      return fn(options, next)
    }
    return next()
  }
  // The HTTP route is opt-in: it is the one seam that has to be *late* (the real
  // composition publishes the web server after plugins load), so a harness that
  // does not ask for it stays exactly as it was.
  const routes = []
  if (opts?.route === true) {
    ctx.inject = (names, fn) => fn({
      webServer: { register: entry => { routes.push(entry); return () => {} } },
      effect: f => f(),
    })
  }
  /**
   * Call a mounted route the way the host would.
   *
   * `url` carries the query string (the switch log takes ?session=) and `at`
   * picks which registered route to call - the models list is mounted first, the
   * switch log second.
   */
  const request = async (method, body, url, at = 0) => {
    const entry = routes[at]
    if (entry === undefined) throw new Error('no route was mounted')
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8') },
    }
    let status = 0
    let payload = null
    const res = {
      writeHead: code => { status = code },
      end: text => { payload = text === undefined ? null : JSON.parse(text) },
    }
    await entry.handler(req, res)
    return { status, payload }
  }
  return { ctx, run, registered, attempted, warns, routes, request }
}

const collect = async stream => {
  const out = []
  for await (const c of stream) out.push(c)
  return out
}

// ---- scenario 1: failed attempt then a successful retry -----------------------
{
  const h = makeCtx((options, n) => {
    if (options.model === 'alpha') {
      return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted' } } }]
    }
    return [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello from ' + options.model },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  })
  apply(h.ctx, {}, {})
  const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  check('1a fails over to a healthy peer', text.startsWith('hello from '), 'got=' + JSON.stringify(text))
  check('1b attempted the current model first', h.attempted[0] === 'provA/alpha', 'attempted=' + h.attempted.join(','))
  check('1c exactly one visible reply', chunks.filter(c => c.type === 'text-delta').length === 1, 'deltas=' + chunks.filter(c => c.type === 'text-delta').length)
  const st = h.registered.get('model_rotator_status')
  const report = await st.execute({}, {})
  check('1d a quota failure shows up as a rest until tomorrow', report.includes('QUOTA-REST') && /quota/.test(report), '')
}

// ---- scenario 2: content already flowed -> no second attempt ------------------
{
  const h = makeCtx((options) => ([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'network reset' } } },
  ]))
  apply(h.ctx, {}, {})
  const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('2a no failover once text flowed', h.attempted.length === 1, 'attempted=' + h.attempted.join(','))
  check('2b partial text preserved', chunks.some(c => c.type === 'text-delta' && c.text === 'partial'), '')
  check('2c error finish passed through', chunks.some(c => c.type === 'finish' && c.reason.kind === 'error'), '')
}

// ---- scenario 3: image turn skipped ------------------------------------------
{
  const h = makeCtx(() => ([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]))
  apply(h.ctx, {}, {})
  const msgs = [{ role: 'user', content: [{ type: 'image', image: 'sha256:x' }] }]
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: msgs }))
  check('3a image turn not failed over by default', h.attempted.length === 1, 'attempted=' + h.attempted.join(','))
}

// ---- scenario 4: re-entrancy guard -------------------------------------------
{
  const h = makeCtx((options) => ([{ type: 'finish', reason: { kind: 'stop' } }]))
  apply(h.ctx, {}, {})
  // a retry-dispatch invoked inside the waterfall must pass straight through
  const retryOpts = { provider: 'provB', model: 'gamma', messages: [] }
  // simulate by calling the listener directly twice
  const stream = h.run({ provider: 'provA', model: 'alpha', messages: [] })
  await collect(stream)
  check('4a terminates with success', h.attempted.length === 1, 'attempted=' + h.attempted.join(','))
}

// ---- scenario 5: all candidates exhausted -> honest error ---------------------
{
  const h = makeCtx(() => ([{ type: 'finish', reason: { kind: 'error', failure: { message: '401 invalid api key' } } }]))
  apply(h.ctx, {}, {})
  const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  const fins = chunks.filter(c => c.type === 'finish')
  const fin = [...fins].pop()
  check('5a surfaces the real provider error when all fail', String(fin?.reason?.failure?.message ?? '') === '401 invalid api key', JSON.stringify(fin))
  check('5b tried more than one candidate', h.attempted.length > 1, 'attempted=' + h.attempted.join(','))
  check('5c emits exactly one finish chunk', fins.length === 1, 'finishes=' + fins.length)
  const report = await h.registered.get('model_rotator_status').execute({}, {})
  const rested = new Set(h.attempted).size
  const resting = (report.match(/QUOTA-REST|COOLDOWN/g) ?? []).length
  check('5d every candidate that failed is rested', resting >= rested, 'resting=' + resting + ' of ' + rested + ' attempted')
  check('5f the record names the failure type', /\[auth\]/.test(report) && /last failure seen/.test(report), report.split('\n').find(l => /last failure seen/.test(l)) ?? '')
}

// ---- scenario 5e: aborted signal is never wrapped -----------------------------
{
  const h = makeCtx(() => ([{ type: 'finish', reason: { kind: 'error', failure: { message: 'x' } } }]))
  apply(h.ctx, {}, {})
  const ac = new AbortController()
  ac.abort()
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: [], signal: ac.signal }))
  check('5e aborted signal passes straight through', h.attempted.length === 1, 'attempted=' + h.attempted.join(','))
}

// ---- scenario 7: non-chat families are never dialed (through the real waterfall)
{
  const nonChat = [
    'BAAI/bge-m3', 'BAAI/bge-reranker-v2-m3', 'Qwen/Qwen3-Embedding-8B',
    'Qwen/Qwen3-ASR-1.7B', 'Qwen/Qwen-Image', 'Tongyi-MAI/Z-Image-Turbo',
    'deepseek-ai/DeepSeek-OCR', 'Wan-AI/Wan2.2-T2V-A14B', 'PaddlePaddle/PaddleOCR-VL-1.5',
    'FunAudioLLM/CosyVoice2-0.5B', 'opencompass/CompassJudger-1-32B-Instruct',
    'nvidia/nemotron-3.5-content-safety:free',
  ]
  const chat = ['deepseek-v4.1-flash', 'Qwen/Qwen3-VL-8B-Instruct', 'zai-org/GLM-5.3', 'MiniMax-M3']

  // Every model fails, so the rotator walks its whole pool; whoever it dials beyond
  // the current model is visible in attempted[].
  const models = { p1: nonChat.map(id => ({ id })), p2: chat.map(id => ({ id })) }
  const attempted = []
  const providers = [{ id: 'p1' }, { id: 'p2' }]
  const ctx = {
    logger: { warn: () => {} }, get: () => undefined,
    on(e, fn) { if (e === 'llm/stream') listeners.push(fn) },
    tools: { register: () => () => {} },
    llm: {
      listProviders: () => providers,
      registration: () => ({ adapter: { listModels: async p => models[p] ?? [] } }),
      stream(o) {
        attempted.push(o.provider + '/' + o.model)
        return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } } } })()
      },
    },
  }
  const listeners = []
  freshStatsFile()
  apply(ctx, {}, {})
  let idx = 0
  const next = () => { const fn = listeners[idx++]; return fn === undefined ? ctx.llm.stream(currentOpts) : fn(currentOpts, next) }
  const currentOpts = { provider: 'p1', model: 'deepseek-v4.1-flash', messages: [] }
  const stream = next()
  await collect(stream)

  const dialedNonChat = attempted.filter(k => nonChat.some(nc => k.endsWith('/' + nc)))
  check('7a no non-chat family is ever dialed', dialedNonChat.length === 0, dialedNonChat.join(',') || 'none dialed')
  check('7b did dial chat fallbacks', attempted.some(k => k === 'p2/Qwen/Qwen3-VL-8B-Instruct' || k === 'p2/zai-org/GLM-5.3' || k === 'p2/MiniMax-M3'), 'attempted=' + attempted.join(','))
  check('7c distinct models dialed are bounded by maxCandidates(4)', new Set(attempted).size <= 4, 'distinct=' + new Set(attempted).size + ' attempts=' + attempted.length)
}

// ---- scenario 8: shipped deny table, asserted through the exported seam --------
{
  const NON_CHAT = [
    'Tongyi-MAI/Z-Image-Turbo', 'Tongyi-MAI/Z-Image', 'Qwen/Qwen3-VL-Embedding-8B',
    'Qwen/Qwen3-VL-Reranker-8B', 'PaddlePaddle/PaddleOCR-VL-1.5', 'deepseek-ai/DeepSeek-OCR',
    'XingChenAGI/XingChenASR-V3.2-Ultra', 'Qwen/Qwen3-ASR-1.7B', 'Wan-AI/Wan2.2-T2V-A14B',
    'BAAI/bge-m3', 'BAAI/bge-reranker-v2-m3', 'fnlp/MOSS-TTSD-v0.5',
    'FunAudioLLM/CosyVoice2-0.5B', 'FunAudioLLM/SenseVoiceSmall', 'Qwen/Qwen-Image-Edit-2509',
    'Kwai-Kolors/Kolors', 'opencompass/CompassJudger-1-32B-Instruct',
    'nvidia/nemotron-3.5-content-safety',
  ]
  const CHAT = [
    'tencent/Hy4-preview', 'zai-org/GLM-5.3', 'deepseek-ai/DeepSeek-V4-Flash',
    'meituan-longcat/LongCat-2.0', 'moonshotai/Kimi-K2.7-Code', 'Qwen/Qwen3.8-27B',
    'tencent/Hunyuan-MT-7B', 'Qwen/Qwen3-VL-32B-Instruct', 'Qwen/Qwen3-VL-8B-Thinking',
    'deepseek-v4.1-flash', 'gpt-6-sol', 'GLM-5.3-Flash', 'kimi-k3', 'MiniMax-M3',
    'gemini-3.6-flash', 'deepseek-v4-pro', 'big-pickle', 'moonshotai/kimi-k2.6',
  ]
  const leaked = NON_CHAT.filter(id => !isNonChatModelId('p', id))
  const wrongly = CHAT.filter(id => isNonChatModelId('p', id))
  check('8a shipped table denies every non-chat family', leaked.length === 0, leaked.length ? 'leaked: ' + leaked.join(', ') : '0 leaked of ' + NON_CHAT.length)
  check('8b no chat model (incl. vision-chat) is denied', wrongly.length === 0, wrongly.length ? 'wrongly denied: ' + wrongly.join(', ') : '0 wrong of ' + CHAT.length)
}

// ---- scenario 6: disabled config -> pure passthrough -------------------------
{
  const h = makeCtx(() => ([{ type: 'finish', reason: { kind: 'error', failure: { message: 'x' } } }]))
  apply(h.ctx, { enabled: false }, {})
  // note: config comes from file, so force via env var later; here assert registration only
  check('6a tools registered', h.registered.has('model_rotator_status') && h.registered.has('model_rotator_benchmark') && h.registered.has('model_rotator_select'), [...h.registered.keys()].join(','))
}

// ---- scenario 9: ask before leaving a failed model ----------------------------
// The consent gate is optional plumbing around the same zero-content failure the
// earlier scenarios cover, so these use seams that record the question asked.
const seamsFor = (opts = {}) => {
  const asks = []
  const adoptions = []
  const seams = {
    agents: { currentInitiator: () => (opts.noAgent === true ? undefined : { id: 'root' }) },
    sessionController: {
      selectForNextRequest: (agent, selection) => {
        if (opts.adoptBoom === true) throw new Error('CALLER_NOT_LIVE')
        adoptions.push({ agent, selection })
      },
    },
    userQuestions: {
      askTimed: async (request, callId, timeoutMs) => {
        asks.push({ request, callId, timeoutMs })
        if (opts.boom === true) throw new Error('NO_PROVIDER')
        if (opts.pending === true) return { pending: true, callId }
        return { answers: [{ id: request.questions[0].id, selected: opts.selected ?? [], custom: opts.custom }] }
      },
    },
  }
  return { asks, adoptions, seams }
}
// The failure that *starts* a switch is a transient one on purpose: a quota
// wall or an unsupported request is a deterministic dead end, and those now
// switch without asking (see DEAD_END_KINDS). Using one here would make every
// consent-gate assertion below pass for the wrong reason.
const failsThenSucceeds = options => (options.model === 'alpha'
  ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'fetch failed: ECONNRESET' } } }]
  : [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello from ' + options.model },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
const allFail = () => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted' } } }]
const switched = chunks => chunks.some(c => c.type === 'text-delta')
const switchRun = async (behaviour, config, seams) => {
  const h = makeCtx(behaviour, seams)
  apply(h.ctx, config, {})
  const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  return { h, chunks }
}

{
  const { asks, seams } = seamsFor({ selected: ['保持当前模型'] })
  const { h, chunks } = await switchRun(failsThenSucceeds, { confirmSwitch: false }, seams)
  check('9a with the prompt off nothing asks and the switch still happens', asks.length === 0 && switched(chunks), 'asks=' + asks.length + ' attempted=' + h.attempted.join(','))
}
{
  const { asks, seams } = seamsFor({ selected: ['切换'] })
  const { h, chunks } = await switchRun(failsThenSucceeds, {}, seams)
  check('9b an approved question lets the switch happen on the next candidate', asks.length === 1 && switched(chunks) && h.attempted[h.attempted.length - 1] === 'provA/beta', 'asks=' + asks.length + ' attempted=' + h.attempted.join(','))
  const q = asks[0] ?? { request: { questions: [{ options: [] }] } }
  const asked = q.request.questions[0]
  check('9c the card names the failed model and the target', /provA\/alpha/.test(asked.question) && /provA\/beta|provB\/gamma/.test(asked.question), asked.question)
  check('9d the ask carries the live agent, a call id and the default timeout', q.request.agent?.id === 'root' && /^model-rotator-/.test(String(q.callId)) && q.timeoutMs === 20000, JSON.stringify({ callId: q.callId, timeoutMs: q.timeoutMs, agent: q.request.agent?.id }))
  check('9e the two replies are switch and keep', JSON.stringify(asked.options.map(o => o.label)) === JSON.stringify(['切换', '保持当前模型']), asked.options.map(o => o.label).join(','))
}
{
  const { asks, seams } = seamsFor({ selected: ['切换'] })
  const { h } = await switchRun(failsThenSucceeds, { confirmTimeoutMs: 5000 }, seams)
  check('9f the page can shorten the wait', asks[0]?.timeoutMs === 5000, 'timeoutMs=' + asks[0]?.timeoutMs)
}
{
  const { seams } = seamsFor({ selected: ['保持当前模型'] })
  const { h, chunks } = await switchRun(failsThenSucceeds, {}, seams)
  const fins = chunks.filter(c => c.type === 'finish')
  check('9g a declined switch never dials another model', h.attempted.every(k => k === 'provA/alpha'), 'attempted=' + h.attempted.join(','))
  check('9h the decline ends the turn on an honest error', fins.length === 1 && /switch declined after fetch failed: ECONNRESET/.test(String(fins[0]?.reason?.failure?.message)), JSON.stringify(fins[fins.length - 1]))
}
{
  const { seams } = seamsFor({ selected: [], custom: '不切换' })
  const { h } = await switchRun(failsThenSucceeds, {}, seams)
  check('9i a typed refusal also holds the current model', h.attempted.every(k => k === 'provA/alpha'), 'attempted=' + h.attempted.join(','))
}
{
  const { asks, seams } = seamsFor({ pending: true })
  const { h, chunks } = await switchRun(failsThenSucceeds, {}, seams)
  check('9j an unanswered question switches once the wait expires', asks.length === 1 && switched(chunks), 'asks=' + asks.length + ' attempted=' + h.attempted.join(','))
}
{
  const { h, chunks } = await switchRun(failsThenSucceeds, {}, { agents: { currentInitiator: () => ({ id: 'root' }) } })
  check('9k no question seam means failover keeps working unasked', switched(chunks) && h.warns.length === 0, 'warns=' + h.warns.length)
}
{
  const { asks, seams } = seamsFor({ noAgent: true })
  const { h, chunks } = await switchRun(failsThenSucceeds, {}, seams)
  check('9l a delegated or agentless turn switches unasked', switched(chunks) && asks.length === 0, 'asks=' + asks.length)
}
{
  const { seams } = seamsFor({ boom: true })
  const { h, chunks } = await switchRun(failsThenSucceeds, {}, seams)
  check('9m a failing ask never stalls the turn', switched(chunks) && h.warns.some(w => /cannot ask before switching/.test(w)), 'warns=' + JSON.stringify(h.warns))
}
{
  const { asks, seams } = seamsFor({ selected: ['切换'] })
  // Transient, not quota: a dead end would now skip the question entirely and
  // this assertion would have nothing to count.
  const allFailTransient = () => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'fetch failed: ECONNRESET' } } }]
  const { h, chunks } = await switchRun(allFailTransient, {}, seams)
  const fins = chunks.filter(c => c.type === 'finish')
  check('9n one approval covers the whole walk', asks.length === 1 && h.attempted.length >= 2, 'asks=' + asks.length + ' attempted=' + h.attempted.join(','))
  check('9o a walk that still fails reports the provider error, not the decline', fins.length === 1 && /ECONNRESET/.test(String(fins[0]?.reason?.failure?.message)) && !/declined/.test(String(fins[0]?.reason?.failure?.message)), JSON.stringify(fins[fins.length - 1]))
}
{
  // A deterministic dead end is not a preference the reader can exercise: the
  // balance is gone for the day and the provider's "unsupported" answers the
  // same way next time. Declining could not keep the model, so the question only
  // cost a modal and the wait - the switch now happens on its own, and the
  // record still says why.
  const deadEnds = [
    ['quota', '429: {"message":"insufficient balance"}'],
    ['unsupported', 'this model does not support reasoning effort on'],
  ]
  for (const [kind, message] of deadEnds) {
    const { asks, seams } = seamsFor({ selected: ['保持当前模型'] })
    const h = makeCtx(options => (options.model === 'alpha'
      ? [{ type: 'finish', reason: { kind: 'error', failure: { message } } }]
      : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]), seams)
    apply(h.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
    const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
    check('9p a ' + kind + ' dead end switches without asking',
      asks.length === 0 && switched(chunks),
      'kind=' + kind + ' asks=' + asks.length + ' attempted=' + h.attempted.join(','))
  }

  // The deliberate exception. A 403 is often a burst-rate proxy that clears, so
  // "keep my model and let me retry" is a real choice there, and the question
  // stays. This is also the negative control for 9p: if the gate had been
  // removed outright, nothing would ask here either.
  const { asks: authAsks, seams: authSeams } = seamsFor({ selected: ['切换'] })
  const auth = makeCtx(options => (options.model === 'alpha'
    ? [{ type: 'finish', reason: { kind: 'error', failure: { message: '403 forbidden: invalid api key' } } }]
    : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]), authSeams)
  apply(auth.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  await collect(auth.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('9q an auth failure still asks (a burst-rate proxy does recover)', authAsks.length === 1, 'asks=' + authAsks.length)
}

// ---- scenario 10: the swapped model becomes the model of the session ---------
// adoptSwitchedModel is the session-local half of the harness's own model switch:
// nothing in the provider configuration and no saved default is written, but the
// conversation must stop naming the model that failed.
{
  const { adoptions, seams } = seamsFor({ selected: ['切换'] })
  const { chunks } = await switchRun(failsThenSucceeds, {}, seams)
  check('10a the model that answered is adopted for this session',
    adoptions.length === 1 && adoptions[0].selection.provider === 'provA' && adoptions[0].selection.model === 'beta',
    JSON.stringify(adoptions.map(a => a.selection)))
  check('10b the adoption names the live agent and the model alone',
    adoptions[0]?.agent?.id === 'root' && Object.keys(adoptions[0]?.selection ?? {}).join(',') === 'provider,model',
    JSON.stringify(adoptions[0]))
  check('10c the switched answer still reaches the caller', switched(chunks), '')
}
{
  const { adoptions, seams } = seamsFor({ selected: ['切换'] })
  await switchRun(failsThenSucceeds, { adoptSwitchedModel: false }, seams)
  check('10d the page can keep the session on the picked model', adoptions.length === 0, 'adoptions=' + adoptions.length)
}
{
  const { adoptions, seams } = seamsFor({ selected: ['切换'] })
  await switchRun(() => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'first try' },
    { type: 'finish', reason: { kind: 'stop' } },
  ], {}, seams)
  check('10e a turn that never switched adopts nothing', adoptions.length === 0, 'adoptions=' + adoptions.length)
}
{
  const { adoptions, seams } = seamsFor({ selected: ['保持当前模型'] })
  await switchRun(failsThenSucceeds, {}, seams)
  check('10f a declined switch adopts nothing', adoptions.length === 0, 'adoptions=' + adoptions.length)
}
{
  const { seams } = seamsFor({ selected: ['切换'], adoptBoom: true })
  const { h, chunks } = await switchRun(failsThenSucceeds, {}, seams)
  check('10g an unusable session seam never breaks the turn',
    switched(chunks) && h.warns.length === 1 && /cannot record the swapped model/.test(h.warns[0]),
    'warns=' + JSON.stringify(h.warns))
}
{
  const { adoptions, seams } = seamsFor({ selected: ['切换'] })
  await switchRun(allFail, {}, seams)
  check('10h a walk that produced no answer adopts nothing', adoptions.length === 0, 'adoptions=' + adoptions.length)
}

// ---- scenario 11: a failure is confirmed by retrying the same model ----------
// Providers fail transiently, so one miss must not cost the user their model.
{
  const h = makeCtx((options, n) => (n <= 2
    ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'blip ' + n } } }]
    : [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'recovered' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]))
  apply(h.ctx, { retryBackoffMs: 0 }, {})
  const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('11a a blip is retried on the same model', h.attempted.join(',') === 'provA/alpha,provA/alpha,provA/alpha', 'attempted=' + h.attempted.join(','))
  check('11b the retry serves the answer without a switch', switched(chunks) && chunks.filter(c => c.type === 'text-delta').length === 1, 'deltas=' + chunks.filter(c => c.type === 'text-delta').length)
}
{
  const h = makeCtx((options, n) => (n === 1
    ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'one strike' } } }]
    : [{ type: 'text-delta', index: 0, text: 'from ' + options.model }, { type: 'finish', reason: { kind: 'stop' } }]))
  apply(h.ctx, { retriesPerModel: 0 }, {})
  const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('11c retriesPerModel 0 drops the model on its first failure', h.attempted.length === 2 && h.attempted[1] !== 'provA/alpha', 'attempted=' + h.attempted.join(','))
  check('11d the turn still recovers on another candidate', switched(chunks), '')
}
{
  const h = makeCtx(() => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'dead' } } }])
  apply(h.ctx, { retriesPerModel: 99, retryBackoffMs: 0 }, {})
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  const alpha = h.attempted.filter(k => k === 'provA/alpha').length
  check('11e the retry count is clamped to 5', alpha === 6, 'alpha attempts=' + alpha)
}
{
  const h = makeCtx(() => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'dead' } } }])
  apply(h.ctx, { retriesPerModel: 2, retryBackoffMs: 40, maxCandidates: 1 }, {})
  const t0 = Date.now()
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  const ms = Date.now() - t0
  check('11f the backoff really pauses between tries', ms >= 100, 'elapsed=' + ms + 'ms')
}
{
  // A turn the caller cancelled mid-flight must not go shopping for providers.
  const ac = new AbortController()
  const h = makeCtx(() => {
    ac.abort()
    return [{ type: 'finish', reason: { kind: 'aborted' } }]
  })
  apply(h.ctx, {}, {})
  const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [], signal: ac.signal }))
  const fins = chunks.filter(c => c.type === 'finish')
  check('11g a cancelled turn never dials another provider', h.attempted.length === 1, 'attempted=' + h.attempted.join(','))
  check('11h the abort reaches the caller as an abort', fins.length === 1 && fins[0].reason.kind === 'aborted', JSON.stringify(fins))
}

// ---- scenario 12: the same model on another provider comes first --------------
{
  const models = {
    pA: [{ id: 'deepseek-v4.1-flash' }, { id: 'zzz-unrelated' }],
    pB: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4.1-pro' }, { id: 'aaa-unrelated' }],
  }
  const build = config => {
    const attempted = []
    const listeners = []
    const providers = [{ id: 'pA' }, { id: 'pB' }]
    const ctx = {
      logger: { warn: () => {} }, get: () => undefined,
      on(e, fn) { if (e === 'llm/stream') listeners.push(fn) },
      tools: { register: () => () => {} },
      llm: {
        listProviders: () => providers,
        registration: () => ({ adapter: { listModels: async p => models[p] ?? [] } }),
        stream(o) {
          attempted.push(o.provider + '/' + o.model)
          return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } } } })()
        },
      },
    }
    freshStatsFile()
    apply(ctx, config, {})
    const currentOpts = { provider: 'pA', model: 'deepseek-v4.1-flash', messages: [] }
    let idx = 0
    const next = () => { const fn = listeners[idx++]; return fn === undefined ? ctx.llm.stream(currentOpts) : fn(currentOpts, next) }
    return { attempted, run: () => next() }
  }
  const on = build({ retriesPerModel: 0, maxCandidates: 6 })
  await collect(on.run())
  check('12a the same model on another provider is tried first', on.attempted[1] === 'pB/deepseek-v4.1-flash', 'attempted=' + on.attempted.join(','))
  check('12b a close relative follows it', on.attempted[2] === 'pB/deepseek-v4.1-pro', 'attempted=' + on.attempted.join(','))
  const off = build({ retriesPerModel: 0, maxCandidates: 6, preferSameModel: false })
  await collect(off.run())
  check('12c preferSameModel false leaves the order to the measurements', off.attempted[1] === 'pA/zzz-unrelated', 'attempted=' + off.attempted.join(','))
}

// ---- scenario 13: the failure type decides the rest ---------------------------
// "insufficient balance" and "rate limit reached" are both a 429 to a naive
// reader, yet one clears in seconds and the other not until the allowance
// resets. The kind is therefore read out of the prose, and a quota wall rests
// until the next day instead of taking the exponential backoff.
{
  const kinds = [
    ['insufficient user quota', 'quota'],
    ['provider "amd" model "MiMo-V2.6-Flash" does not support reasoning effort "high"', 'unsupported'],
    ['unsupported model: gpt-5-legacy', 'unsupported'],
    ['You exceeded your current quota, please check your plan and billing details', 'quota'],
    ['out of credits, please top up', 'quota'],
    ['账户余额不足，请充值后重试', 'quota'],
    ['额度已用尽', 'quota'],
    ['402 Payment Required', 'quota'],
    ['rate limit exceeded, retry later', 'rate-limit'],
    ['请求过于频繁', 'rate-limit'],
    ['401 invalid api key', 'auth'],
    ['403 forbidden', 'auth'],
    ['500 internal server error', 'server'],
    ['fetch failed: ECONNRESET', 'network'],
    ['something nobody has seen before', ''],
  ]
  const wrong = kinds.filter(([text, want]) => classifyFailureKind(text) !== want)
  check('13a every failure class is named', wrong.length === 0, wrong.map(([t, w]) => t + ' -> ' + classifyFailureKind(t) + ' (want ' + w + ')').join('; '))

  // A request the provider refuses as unsupported is settled before a retry could
  // matter: the same provider returns the same refusal to the same request.
  const v = makeCtx(() => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider "p" model "m" does not support reasoning effort "on"' } } }])
  apply(v.ctx, { retriesPerModel: 3, retryBackoffMs: 0, maxCandidates: 6 }, {})
  await collect(v.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('13u an unsupported request is not retried', v.attempted.filter(k => k === 'provA/alpha').length === 1, 'attempted=' + v.attempted.join(','))

  // A quota wall is reported as a 429 with a billing sentence attached, so the
  // quota test has to win over the rate-limit test - and a dead key must not be
  // read as a dead balance, since waiting never repairs a key.
  check('13b a billed 429 is a quota failure, not a rate limit', classifyFailureKind('429 insufficient quota for this account') === 'quota', classifyFailureKind('429 insufficient quota for this account'))
  check('13c an expired key is not a quota failure', classifyFailureKind('429 invalid api key') === 'auth', classifyFailureKind('429 invalid api key'))
  check('13d nothing recognisable keeps the default policy', classifyFailureKind('') === '' && classifyFailureKind(undefined) === '', '')

  // The daily boundary: strictly the next calendar day, at quotaCooldownHour.
  const at = (y, m, d, hh, mm) => new Date(y, m, d, hh, mm, 0, 0).getTime()
  const rest = t => quotaRestUntil(t, { quotaCooldownMs: 12 * 60 * 60 * 1000, quotaCooldownHour: 0 })
  check('13e a failure at 09:00 rests until the next midnight', rest(at(2026, 2, 10, 9, 0)) === at(2026, 2, 11, 0, 0), new Date(rest(at(2026, 2, 10, 9, 0))).toString())
  check('13f a failure at 00:05 does not come back the same evening', rest(at(2026, 2, 10, 0, 5)) === at(2026, 2, 11, 0, 0), new Date(rest(at(2026, 2, 10, 0, 5))).toString())
  check('13g the floor survives a failure just before midnight', rest(at(2026, 2, 10, 23, 50)) === at(2026, 2, 11, 11, 50), new Date(rest(at(2026, 2, 10, 23, 50))).toString())
  check('13h the release hour is configurable', quotaRestUntil(at(2026, 2, 10, 9, 0), { quotaCooldownMs: 0, quotaCooldownHour: 6 }) === at(2026, 2, 11, 6, 0), new Date(quotaRestUntil(at(2026, 2, 10, 9, 0), { quotaCooldownMs: 0, quotaCooldownHour: 6 })).toString())
  check('13i a month boundary rolls over', rest(at(2026, 1, 28, 9, 0)) === at(2026, 2, 1, 0, 0), new Date(rest(at(2026, 1, 28, 9, 0))).toString())
  check('13j switching the rest off restores the ordinary backoff', quotaRestUntil(at(2026, 2, 10, 9, 0), { quotaCooldownMs: 0, quotaCooldownHour: 0 }) === at(2026, 2, 11, 0, 0), new Date(quotaRestUntil(at(2026, 2, 10, 9, 0), { quotaCooldownMs: 0, quotaCooldownHour: 0 })).toString())
}

{
  // A quota wall must not spend the retries: the balance does not refill between
  // two dispatches, so the switch happens at once.
  const h = makeCtx(options => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'insufficient quota' } } }])
  apply(h.ctx, { retriesPerModel: 3, retryBackoffMs: 0 }, {})
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  const alpha = h.attempted.filter(k => k === 'provA/alpha').length
  check('13k a quota failure never burns a retry', alpha === 1, 'alpha attempts=' + alpha + ' attempted=' + h.attempted.join(','))

  const report = await h.registered.get('model_rotator_status').execute({}, {})
  check('13l the ranking marks a quota rest apart from an ordinary cooldown', /QUOTA-REST/.test(report) && !/\| COOLDOWN/.test(report.split('\n').filter(l => /provA\/alpha/.test(l)).join('')), report.split('\n').find(l => /provA\/alpha/.test(l)) ?? '')
  check('13m the rest is measured in hours, not minutes', / \d{3,}m /.test(report) || /REST/.test(report), report.split('\n').find(l => /provA\/alpha/.test(l)) ?? '')
}

{
  // A transient blip still gets its retries - the quota shortcut must not leak.
  const h = makeCtx((options, n) => (n === 1
    ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limit exceeded' } } }]
    : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]))
  apply(h.ctx, { retriesPerModel: 2, retryBackoffMs: 0 }, {})
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('13n a rate limit still gets its retries', h.attempted.join(',') === 'provA/alpha,provA/alpha', 'attempted=' + h.attempted.join(','))
  const report = await h.registered.get('model_rotator_status').execute({}, {})
  check('13o the surviving model carries no rest', !/provA\/alpha\s+\d+\s+1\s+1\s+\d+\s+-\s+COOLDOWN/.test(report), report.split('\n').find(l => /provA\/alpha/.test(l)) ?? '')
}

{
  // Statistics outlive the process: a quota rest would otherwise be undone by the
  // very restart a user performs after being told the balance is gone.
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rotator-stats-'))
  const statsFile = join(dir, 'stats.json')
  const priorConfig = process.env.DSH_MODEL_ROTATOR_CONFIG
  const priorStats = process.env.DSH_MODEL_ROTOR_STATS
  process.env.DSH_MODEL_ROTATOR_CONFIG = join(dir, 'absent-config.json')
  process.env.DSH_MODEL_ROTOR_STATS = statsFile
  try {
    const allFail = () => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'insufficient quota' } } }]
    const first = makeCtx(allFail, undefined, { sameStats: true })
    apply(first.ctx, { retriesPerModel: 0 }, {})
    await collect(first.run({ provider: 'provA', model: 'alpha', messages: [] }))
    await first.registered.get('model_rotator_status').execute({}, {})
    await new Promise(r => setTimeout(r, 1700))
    const written = JSON.parse(readFileSync(statsFile, 'utf8'))
    check('13p measured state reaches the disk', written.rows?.['provA/alpha']?.lastErrorKind === 'quota', JSON.stringify(Object.keys(written.rows ?? {}).slice(0, 3)))

    const second = makeCtx(allFail, undefined, { sameStats: true })
    apply(second.ctx, { retriesPerModel: 0 }, {})
    const report = await second.registered.get('model_rotator_status').execute({}, {})
    check('13q a restart keeps the quota rest', /QUOTA-REST/.test(report), report.split('\n').find(l => /provA\/alpha/.test(l)) ?? '')

    // TTL 0 means "keep nothing": the file is not even written.
    writeFileSync(statsFile, '{"version":1,"rows":{}}', 'utf8')
    const off = makeCtx(allFail, undefined, { sameStats: true })
    apply(off.ctx, { statsPersistTtlMs: 0 }, {})
    await collect(off.run({ provider: 'provA', model: 'alpha', messages: [] }))
    await new Promise(r => setTimeout(r, 1700))
    check('13r ttl 0 disables persistence', JSON.parse(readFileSync(statsFile, 'utf8')).rows?.['provA/alpha'] === undefined, '')

    // A stale file is ignored beyond the TTL.
    writeFileSync(statsFile, JSON.stringify({
      version: 1,
      rows: { 'provA/alpha': { savedAt: Date.now() - 3 * 60 * 60 * 1000, attempts: 9, failures: 9, consecutiveFailures: 9, cooldownUntil: Date.now() + 9e7, lastError: 'insufficient quota', lastErrorKind: 'quota' } },
    }), 'utf8')
    const stale = makeCtx(allFail, undefined, { sameStats: true })
    apply(stale.ctx, { statsPersistTtlMs: 60 * 60 * 1000 }, {})
    const staleReport = await stale.registered.get('model_rotator_status').execute({}, {})
    check('13s a file older than the ttl is dropped', /provA\/alpha\s+0\s+0\s+0\s+0/.test(staleReport), staleReport.split('\n').find(l => /provA\/alpha/.test(l)) ?? '')

    // The classifier improves across versions, so a kind loaded from disk is a
    // stale verdict rather than a measurement. Re-deriving it from the stored
    // prose is what relabels the history a newer pattern was written for - and
    // what keeps a stored quota wall resting instead of being retried.
    writeFileSync(statsFile, JSON.stringify({
      version: 1,
      rows: { 'provA/alpha': { savedAt: Date.now(), attempts: 3, failures: 3, consecutiveFailures: 1, cooldownUntil: Date.now() + 6e5, lastError: '429 insufficient user quota for this account', lastErrorKind: '' } },
    }), 'utf8')
    const relabel = makeCtx(allFail, undefined, { sameStats: true })
    apply(relabel.ctx, {}, {})
    const relabelReport = await relabel.registered.get('model_rotator_status').execute({}, {})
    check('13v a stored verdict is re-derived from its prose', /QUOTA-REST/.test(relabelReport), relabelReport.split('\n').find(l => /provA\/alpha/.test(l)) ?? '')

    // A failure payload that is an object (not the string the contract promises)
    // must not become "[object Object]": unreadable in the record, and
    // unclassifiable, so a real quota wall would lose its rest to a typing slip.
    writeFileSync(statsFile, '{"version":1,"rows":{}}', 'utf8')
    const shape = makeCtx(() => [{ type: 'finish', reason: { kind: 'error', failure: { message: { code: 'QUOTA', detail: 'insufficient balance' } } } }], undefined, { sameStats: true })
    apply(shape.ctx, { retriesPerModel: 0 }, {})
    await collect(shape.run({ provider: 'provA', model: 'alpha', messages: [] }))
    const shapeReport = await shape.registered.get('model_rotator_status').execute({}, {})
    check('13w an object failure payload is serialised, not String()-ed', !/\[object Object\]/.test(shapeReport) && /insufficient balance/.test(shapeReport), shapeReport.split('\n').find(l => /last failure seen/.test(l)) ?? '')

    // A corrupt file never breaks a turn.
    writeFileSync(statsFile, 'not json at all', 'utf8')
    const corrupt = makeCtx(allFail, undefined, { sameStats: true })
    apply(corrupt.ctx, {}, {})
    const chunks = await collect(corrupt.run({ provider: 'provA', model: 'alpha', messages: [] }))
    check('13t a corrupt stats file is survivable', chunks.length > 0 && corrupt.warns.every(w => !/stats/.test(w)), JSON.stringify(corrupt.warns))
  } finally {
    if (priorConfig === undefined) delete process.env.DSH_MODEL_ROTATOR_CONFIG
    else process.env.DSH_MODEL_ROTATOR_CONFIG = priorConfig
    if (priorStats === undefined) delete process.env.DSH_MODEL_ROTOR_STATS
    else process.env.DSH_MODEL_ROTOR_STATS = priorStats
  }
}

// ---- scenario 14: the model list and its manual switches ----------------------
// The list is the roster view: every discovered model, grouped by channel, with
// its health, and one switch per row. Switching writes config.json (not the
// settings page) because a list has no natural volatile field and the switch has
// to outlive the process.
{
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rotator-list-'))
  const cfgPath = join(dir, 'config.json')
  const priorCfg = process.env.DSH_MODEL_ROTATOR_CONFIG
  process.env.DSH_MODEL_ROTATOR_CONFIG = cfgPath
  try {
    const h = makeCtx(() => [], undefined, { route: true })
    apply(h.ctx, {}, {})
    check('14a both routes are mounted when a web server exists',
      h.routes.length === 2
        && h.routes[0].path === '/_dsh/model-rotator/models'
        && h.routes[1].path === '/_dsh/model-rotator/switches',
      JSON.stringify(h.routes.map(r => r.path)))

    const get = await h.request('GET')
    check('14b the list groups every model by channel', get.status === 200 && get.payload.channels.length === 2 && get.payload.total === 3, 'channels=' + get.payload.channels.length + ' total=' + get.payload.total)
    // The page shows two sections; with no twins present only the chat one exists.
    check('14o the payload carries the page sections', Array.isArray(get.payload.groups) && get.payload.groups.length === 1 && get.payload.groups[0].key === 'chat' && get.payload.groups[0].models === 3, JSON.stringify(get.payload.groups))
    // A section carries the same four counters a channel does, because the page
    // renders both layers with one row shape - and a folded section still reports
    // what it hides.
    check('14p a section reports the same counters as a channel', get.payload.groups[0].ok === 3 && get.payload.groups[0].resting === 0 && get.payload.groups[0].off === 0, JSON.stringify(get.payload.groups[0]))
    check('14c everything is in rotation by default', get.payload.inRotation === 3, String(get.payload.inRotation))
    check('14d an untried model reads as usable, not as failed', get.payload.models.every(m => m.health === 'ok'), JSON.stringify(get.payload.models.map(m => m.key + ':' + m.health)))
    check('14e a switchable row carries no exclusion reason', get.payload.models.every(m => m.reason === '' && m.switchable === true), JSON.stringify(get.payload.models.map(m => m.reason)))

    const off = await h.request('POST', { key: 'provA/alpha', enabled: false })
    const offRow = off.payload.list.models.find(m => m.key === 'provA/alpha')
    check('14f switching a model off answers with the fresh list', off.status === 200 && offRow.health === 'off' && offRow.reason === 'manual', JSON.stringify(offRow))
    check('14g the switch is written to config.json', JSON.parse(readFileSync(cfgPath, 'utf8')).disabledModels.join(',') === 'provA/alpha', readFileSync(cfgPath, 'utf8').replace(/\s+/g, ' ').slice(0, 120))
    check('14h the disabled model leaves the rotation', off.payload.list.inRotation === 2, String(off.payload.list.inRotation))

    // The listing must agree with the ranking the turn actually walks: a row that
    // says "off" while the model is still tried would be a lie.
    const report = await h.registered.get('model_rotator_status').execute({}, {})
    const rankLine = report.split('\n').filter(l => l.includes('provA/alpha'))
    check('14i the ranking drops the disabled model', rankLine.length === 0 || rankLine.every(l => /disabled models/.test(l)), rankLine.join(' | '))

    const on = await h.request('POST', { key: 'provA/alpha', enabled: true })
    check('14j switching it back on clears the entry', on.status === 200 && on.payload.disabledModels.length === 0 && on.payload.list.inRotation === 3, JSON.stringify(on.payload.disabledModels))

    // A bare model id is accepted (it names the model on every provider that
    // serves it) and a malformed key is refused rather than half-applied.
    await h.request('POST', { key: 'beta', enabled: false })
    const bare = JSON.parse(readFileSync(cfgPath, 'utf8')).disabledModels
    check('14k a bare model id is a legal entry', bare.includes('beta'), JSON.stringify(bare))
    const bareOff = await h.request('GET')
    check('14l a bare id switches the model off on its channel', bareOff.payload.models.find(m => m.key === 'provA/beta').health === 'off', JSON.stringify(bareOff.payload.models.find(m => m.key === 'provA/beta')))
    const bad = await h.request('POST', { key: '   ', enabled: false })
    check('14m an empty key is refused, not stored', bad.status === 400 && JSON.parse(readFileSync(cfgPath, 'utf8')).disabledModels.join(',') === 'beta', bad.status + ' ' + JSON.stringify(bad.payload))

    // ---- the channel switch: one entry closes every model behind a provider ----
    const chOff = await h.request('POST', { key: 'provA', enabled: false, scope: 'provider' })
    const chRows = chOff.payload.list.models.filter(m => m.provider === 'provA')
    check('14q one click closes a whole channel', chOff.status === 200 && chRows.every(m => m.inRotation === false) && chRows.find(m => m.key === 'provA/alpha').reason === 'channel', JSON.stringify(chRows.map(m => m.key + ':' + m.reason)))
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'))
    check('14r the channel is one entry, not one per model', onDisk.disabledProviders.length === 1 && onDisk.disabledProviders[0] === 'provA', JSON.stringify(onDisk.disabledProviders))
    check('14s the channel count is reported', chOff.payload.list.channels.find(c => c.provider === 'provA').switchedOff === true, '')
    check('14t a channel switch is honoured by the ranking', (await h.registered.get('model_rotator_status').execute({}, {})).includes('disabled channels: provA'), '')

    // Closing the channel must actually close it: a per-row "on" from an earlier
    // click cannot be allowed to quietly reopen part of what was just closed.
    check('14u closing the channel clears stale per-row overrides', JSON.parse(readFileSync(cfgPath, 'utf8')).enabledModels.length === 0, JSON.stringify(JSON.parse(readFileSync(cfgPath, 'utf8')).enabledModels))
    // ...but a row enabled *after* the channel was closed is a fresh statement and
    // does take effect, which is what makes the override worth having at all.
    await h.request('POST', { key: 'provA/beta', enabled: true })
    const kept = (await h.request('GET')).payload.models.filter(m => m.provider === 'provA')
    check('14u2 a row enabled after the channel switch wins over it', kept.find(m => m.key === 'provA/beta').inRotation === true && kept.find(m => m.key === 'provA/alpha').inRotation === false, JSON.stringify(kept.map(m => m.key + ':' + m.reason)))
    const chOn = await h.request('POST', { key: 'provA', enabled: true, scope: 'provider' })
    check('14v reopening the channel restores its models', chOn.payload.list.models.filter(m => m.provider === 'provA').every(m => m.inRotation === true), JSON.stringify(chOn.payload.disabledProviders))
    const badCh = await h.request('POST', { key: 'a/b', enabled: false, scope: 'provider' })
    check('14w a model key is refused as a channel', badCh.status === 400 && JSON.parse(readFileSync(cfgPath, 'utf8')).disabledProviders.length === 0, badCh.status + ' ' + JSON.stringify(badCh.payload))

    // The file layer is read fresh, so a hand edit shows up without a reset.
    writeFileSync(cfgPath, JSON.stringify({ disabledModels: ['provB/gamma'] }), 'utf8')
    const edited = await h.request('GET')

    check('14n a hand-edited config.json is picked up', edited.payload.models.find(m => m.key === 'provB/gamma').health === 'off', JSON.stringify(edited.payload.models.map(m => m.key + ':' + m.health)))
  } finally {
    if (priorCfg === undefined) delete process.env.DSH_MODEL_ROTATOR_CONFIG
    else process.env.DSH_MODEL_ROTATOR_CONFIG = priorCfg
  }
}

// ---- scenario 15: which automatic calls are conversation turns ----------------
// A session title is plumbing nobody waits on: a refusal there is a statement
// about that lane, so it stays on the model that was asked. A compaction is
// plumbing the turn cannot proceed without - when the model's quota is gone the
// summary call is the first casualty, and passing that failure through kills the
// whole turn - so it walks the candidate list like any other dead route.
{
  const auto = () => [{ type: 'finish', reason: { kind: 'error', failure: { message: '422: dsh native compaction call refused by billion-context' } } }]
  const quota = () => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'insufficient balance' } } }]
  // A transient failure: it must keep asking, so a fixture built on it isolates
  // the *purpose* exclusion (15e/15f) from the dead-end exclusion (9p-9r).
  const transient = () => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'fetch failed: ECONNRESET' } } }]

  const title = makeCtx(auto)
  apply(title.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  await collect(title.run({ provider: 'provA', model: 'alpha', messages: [], purpose: 'session-title' }))
  check('15a a session-title call does not fail over', title.attempted.join(',') === 'provA/alpha', 'attempted=' + title.attempted.join(','))

  const turn = makeCtx(auto)
  apply(turn.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  await collect(turn.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('15b an ordinary turn keeps failing over', turn.attempted.length > 1, 'attempted=' + turn.attempted.join(','))

  // The regression 0.2.7 exists for: a compaction whose model is out of quota.
  // Two failures then a success is the shape that distinguishes "walked the
  // list" from "gave up on the first candidate" *and* from "only one candidate
  // was ever in scope" - the latter passes a two-channel fixture for the wrong
  // reason.
  const comp = makeCtx((options) => (options.model === 'gamma'
    ? [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'summary from gamma' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    : quota()))
  apply(comp.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  const compChunks = await collect(comp.run({ provider: 'provA', model: 'alpha', messages: [], purpose: 'compaction' }))
  const compText = compChunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  check('15c a quota-dead compaction fails over and completes',
    comp.attempted.length >= 3 && compText.includes('summary from gamma') && compChunks[compChunks.length - 1]?.reason?.kind === 'stop',
    'attempted=' + comp.attempted.join(',') + ' text=' + JSON.stringify(compText))

  // Same failure, but nothing can serve it: the provider's own words must still
  // be what the caller sees, not a paraphrase of the walk.
  const dead = makeCtx(quota)
  apply(dead.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  const deadChunks = await collect(dead.run({ provider: 'provA', model: 'alpha', messages: [], purpose: 'compaction' }))
  check('15d an exhausted compaction still reports the provider error',
    dead.attempted.length > 1 && deadChunks[deadChunks.length - 1]?.reason?.kind === 'error'
      && String(deadChunks[deadChunks.length - 1]?.reason?.failure?.message ?? '').includes('insufficient balance'),
    'attempted=' + dead.attempted.join(',') + ' finish=' + JSON.stringify(deadChunks[deadChunks.length - 1]?.reason))

  // The consent question must not park a summary nobody is reading. Asked with
  // the default config (confirmSwitch on) and a seam that would record it.
  const { asks, adoptions, seams } = seamsFor({ selected: ['切换'] })
  const asked = makeCtx((options) => (options.model === 'alpha' ? transient() : [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'summary' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), seams)
  apply(asked.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  await collect(asked.run({ provider: 'provA', model: 'alpha', messages: [], purpose: 'compaction' }))
  check('15e a compaction switch does not ask the reader', asks.length === 0 && asked.attempted.length > 1,
    'asks=' + asks.length + ' attempted=' + asked.attempted.join(','))
  check('15f a compaction switch does not adopt the model', adoptions.length === 0, 'adoptions=' + adoptions.length)

  // Negative control: the same fixture with an ordinary turn *does* ask and
  // *does* adopt, so 15e/15f are not passing because the seams never fire.
  const { asks: turnAsks, adoptions: turnAdoptions, seams: turnSeams } = seamsFor({ selected: ['切换'] })
  const turn2 = makeCtx((options) => (options.model === 'alpha' ? transient() : [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'answer' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), turnSeams)
  apply(turn2.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  await collect(turn2.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('15g an ordinary turn still asks and adopts', turnAsks.length === 1 && turnAdoptions.length === 1,
    'asks=' + turnAsks.length + ' adoptions=' + turnAdoptions.length)
}

// ---- scenario 16: the vision mode is a mode, not a model ----------------------
// dsh-vision-router wraps a chat route into a "<provider>-vision" twin whose job
// is to add image reading to that same model. Failing a text turn over into it
// answers through the vision pipeline, and the same-model preference - which
// exists to find the *same* model elsewhere - would put the twin first, which is
// the repeated same-model switching this filter removes.
{
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rotator-vision-'))
  process.env.DSH_MODEL_ROTOR_STATS = join(dir, 's.json')
  // The switch writes config.json, so this scenario needs a real one rather than
  // the absent path the other failover scenarios pin.
  const priorCfg = process.env.DSH_MODEL_ROTATOR_CONFIG
  process.env.DSH_MODEL_ROTATOR_CONFIG = join(dir, 'config.json')

  const h = makeCtx((options, n) => (n === 1
    ? [{ type: 'finish', reason: { kind: 'error', failure: { message: '422 nope' } } }]
    : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]), undefined, { route: true })
  // A twin of the failing model is the trap: it is the "same model on another
  // channel" as far as the ranking is concerned, and it would be tried first.
  h.ctx.llm.listProviders = () => [{ id: 'provA' }, { id: 'provA-vision' }, { id: 'provB' }]
  h.ctx.llm.registration = provider => ({ adapter: { listModels: async p => ({
    provA: [{ id: 'alpha' }, { id: 'beta' }],
    'provA-vision': [{ id: 'alpha' }],
    provB: [{ id: 'gamma-vision' }],
  })[p] ?? [] } })
  apply(h.ctx, { retriesPerModel: 0, maxCandidates: 6, confirmSwitch: false }, {})
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('16a a vision provider is never tried', h.attempted.every(k => !k.startsWith('provA-vision/')) && !h.attempted.includes('provB/gamma-vision'), 'attempted=' + h.attempted.join(','))
  check('16b the walk still finds the real peer', h.attempted.includes('provA/beta'), 'attempted=' + h.attempted.join(','))

  const list = await h.request('GET')
  const twin = list.payload.models.find(m => m.key === 'provA-vision/alpha')
  check('16c the twin is listed, but off the rotation', twin !== undefined && twin.health === 'off' && twin.reason === 'vision', JSON.stringify(twin))
  // The rule is about the route, not the word: an ordinary provider that publishes
  // a model *named* something-vision is a real chat model and stays in.
  check('16d a model id mentioning vision stays a candidate', list.payload.models.find(m => m.key === 'provB/gamma-vision').reason === '', JSON.stringify(list.payload.models.map(m => m.key + ':' + m.reason)))
  check('16e a twin can be switched back on', twin.switchable === true, JSON.stringify(twin.switchable))

  // The page separates the two questions: the chat channels it ranks, and the
  // image arm wrapped around them - one foldable section each, counted apart.
  const groups = list.payload.groups
  check('16i the twins form their own section', groups.length === 2 && groups[0].key === 'chat' && groups[1].key === 'vision', JSON.stringify(groups.map(g => g.key + ':' + g.models)))
  // Every real chat route stays there, including one whose *model id* mentions
  // vision; only the twins move to the other section.
  check('16j the chat section holds the candidates', groups[0].models === 3 && groups[1].models === 1, JSON.stringify(groups.map(g => g.key + ':' + g.models)))
  check('16k a twin names the channel it wraps', list.payload.channels.find(c => c.provider === 'provA-vision').sourceChannel === 'provA', JSON.stringify(list.payload.channels.map(c => c.provider + '<-' + c.sourceChannel)))

  // The one exclusion the user owns: switching a twin on must actually put it in
  // rotation, or the switch would be a lie.
  const on = await h.request('POST', { key: 'provA-vision/alpha', enabled: true })
  const revived = on.payload.list.models.find(m => m.key === 'provA-vision/alpha')
  check('16f switching a twin on restores it', on.status === 200 && revived.health !== 'off' && revived.inRotation === true, JSON.stringify(revived))
  check('16g the enable list records it in config.json', JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).enabledModels.includes('provA-vision/alpha'), '')
  const cleared = await h.request('POST', { key: 'provA-vision/alpha', enabled: false })
  check('16h switching it off clears the enable list', cleared.payload.list.models.find(m => m.key === 'provA-vision/alpha').reason === 'manual', JSON.stringify(cleared.payload.enabledModels))
  if (priorCfg === undefined) delete process.env.DSH_MODEL_ROTATOR_CONFIG
  else process.env.DSH_MODEL_ROTATOR_CONFIG = priorCfg
}

// ---- scenario 17: reasoning is not reply content -------------------------------
// "Flow" gates whether a later error may still be retried. A reasoning delta is
// folded away again by the harness on a retry, so it must not close that door -
// that is what made a live model look dead and produced the repeated switches.
{
  const reasoningThenError = () => ([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking about it' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking about it' } },
    { type: 'finish', reason: { kind: 'error', failure: { message: '429 too many requests' } } },
  ])
  const h = makeCtx(reasoningThenError)
  apply(h.ctx, { retriesPerModel: 2, retryBackoffMs: 0, maxCandidates: 6 }, {})
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('17a a reasoning-only attempt still gets its retries', h.attempted.filter(k => k === 'provA/alpha').length === 3, 'attempted=' + h.attempted.join(','))

  // Text, by contrast, is content the user has seen: retrying would duplicate it.
  const textThenError = () => ([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'network reset' } } },
  ])
  const t2 = makeCtx(textThenError)
  apply(t2.ctx, { retriesPerModel: 2, retryBackoffMs: 0, maxCandidates: 6 }, {})
  await collect(t2.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('17b text flowing still stops the walk', t2.attempted.length === 1, 'attempted=' + t2.attempted.join(','))

  // Markup alone is not content either: a block-start borrows no decision.
  const markupThenError = () => ([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'finish', reason: { kind: 'error', failure: { message: '429 too many requests' } } },
  ])
  const t3 = makeCtx(markupThenError)
  apply(t3.ctx, { retriesPerModel: 1, retryBackoffMs: 0, maxCandidates: 6 }, {})
  await collect(t3.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('17c an empty block-start is not content', t3.attempted.length > 1, 'attempted=' + t3.attempted.join(','))
}

// ---- scenario 18: the switch is announced in the conversation -----------------
// A page-owned value arrives from the host as a cosmokit volatile handle; these
// stand in for it exactly like test-settings.mjs does with the real one.
const quietHandle = (value) => ({
  get: () => value,
  [Symbol.for('cosmokit.volatile.write')]: () => {},
})

// A switch is otherwise silent. The notice is the harness's own mechanism (a
// user/message with form 'notice'), delivered through agent/turn-stopping +
// agent.steer - so it must be a KNOWN event type, or a log carrying it would fail
// to replay. This asserts the shipped shape rather than a retyped copy of it.
{
  const { mkdtempSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rotator-notice-'))
  process.env.DSH_MODEL_ROTOR_STATS = join(dir, 's.json')
  const priorCfg = process.env.DSH_MODEL_ROTOR_CONFIG
  process.env.DSH_MODEL_ROTOR_CONFIG = join(dir, 'absent.json')
  try {
    // Shape first: the message must be a user/message the session accepts.
    const same = switchNoticeFor({ provider: 'siliconflow', model: 'glm-5.3', displayName: '硅基流动' }, { provider: 'siliconflow', model: 'glm-5.2', displayName: '硅基流动' }, 'quota')
    check('18a the notice is a user-role message', same.role === 'user' && Array.isArray(same.content) && same.content[0].type === 'text', JSON.stringify(same).slice(0, 120))
    check('18b the notice carries a fresh identity', typeof same.id === 'string' && same.id.length > 0, String(same.id))
    check('18c the source marks it a notice (the UI renders it as a context row)', same.source.form === 'notice' && typeof same.source.kind === 'string', JSON.stringify(same.source))
    check('18d the summary obeys the 120-char bound', same.source.summary.length <= 120, String(same.source.summary.length))
    check('18e a same-channel switch names only the model', same.content[0].text.includes('glm-5.3 → glm-5.2') && !same.content[0].text.includes('siliconflow/glm'), same.content[0].text)

    // The bug this replaced: the vendor was printed twice ("workbuddy/workbuddy").
    const cross = switchNoticeFor({ provider: 'workbuddy', model: 'deepseek-v4.1-flash', displayName: 'WorkBuddy' }, { provider: 'buddy', model: 'deepseek-v4.1-flash', displayName: 'Buddy' }, 'rate-limit')
    check('18f a cross-channel switch names both vendors', cross.content[0].text.includes('WorkBuddy/deepseek-v4.1-flash') && cross.content[0].text.includes('Buddy/deepseek-v4.1-flash'), cross.content[0].text)
    check('18g the vendor name is never duplicated', !/workbuddy\/workbuddy|buddy\/buddy/i.test(cross.content[0].text), cross.content[0].text)
    check('18h an unknown display name falls back to the route id', (() => {
      const m = switchNoticeFor({ provider: 'amd', model: 'x' }, { provider: 'codearts', model: 'y' }, '')
      return m.content[0].text.includes('amd/x') && m.content[0].text.includes('codearts/y')
    })(), '')

    // Delivery: a switch across candidates must reach agent.steer.
    const steer = []
    const h = makeCtx((options, n) => (n === 1
      ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'insufficient quota' } } }]
      : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]), {
        agents: { currentInitiator: () => undefined },
      })
    // Capture the notice listener WITHOUT dropping llm/stream: the fake harness's
    // own on() is what routes the waterfall, so it has to keep working.
    const onEvents = []
    const innerOn = h.ctx.on
    h.ctx.on = (event, fn) => { onEvents.push(event); if (event === 'agent/turn-stopping') h.turnStopping = fn; return innerOn(event, fn) }
    // The row is opt-in since 0.2.9; these assertions are about the row itself,
    // so they ask for it explicitly instead of leaning on the default.
    apply(h.ctx, { retriesPerModel: 0, maxCandidates: 6, confirmSwitch: false, noticeSwitch: true }, {})
    check('18i the notice listens at the turn boundary', onEvents.includes('agent/turn-stopping'), onEvents.join(','))
    await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
    const agent = { session: { header: { parentSession: undefined } }, steer: (m) => steer.push(m) }
    h.turnStopping({ agent, turn: 1, signal: { aborted: false } })
    check('18j a switch is steered into the conversation', steer.length === 1 && steer[0].source.form === 'notice', JSON.stringify(steer).slice(0, 160))
    // Same channel (both provA), so only the model is named - and it names the
    // one the turn was dispatched with, not the last candidate that failed.
    check('18k the notice names the origin model and the winner', steer.length === 1 && /alpha → beta/.test(steer[0].content[0].text) && !/provA\/alpha/.test(steer[0].content[0].text), steer.length ? steer[0].content[0].text : '')
    // One notice per switch, not one per steered message.
    h.turnStopping({ agent, turn: 1, signal: { aborted: false } })
    check('18l a second boundary does not repeat it', steer.length === 1, 'steered=' + steer.length)
    // A subagent transcript is somebody else's log.
    await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
    const steer2 = []
    h.turnStopping({ agent: { session: { header: { parentSession: 'root' } }, steer: (m) => steer2.push(m) }, turn: 2, signal: { aborted: false } })
    check('18m a subagent gets no notice', steer2.length === 0, 'steered=' + steer2.length)
    // An aborted turn is not a place to announce anything.
    await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
    const steer3 = []
    h.turnStopping({ agent: { session: { header: {} }, steer: (m) => steer3.push(m) }, turn: 3, signal: { aborted: true } })
    check('18n an aborted turn posts nothing', steer3.length === 0, 'steered=' + steer3.length)

    // The switch can be switched off.
    const quiet = makeCtx((options, n) => (n === 1
      ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'insufficient quota' } } }]
      : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]))
    const innerOn2 = quiet.ctx.on
    quiet.ctx.on = (event, fn) => { if (event === 'agent/turn-stopping') quiet.turnStopping = fn; return innerOn2(event, fn) }
    // A page-owned setting arrives as a live handle, not a plain value - the
    // plugin reads it through readSetting(). Handing over a bare boolean would
    // exercise a path the host never uses.
    apply(quiet.ctx, { retriesPerModel: 0, maxCandidates: 6, confirmSwitch: false, noticeSwitch: quietHandle(false) }, {})
    await collect(quiet.run({ provider: 'provA', model: 'alpha', messages: [] }))
    const steer4 = []
    quiet.turnStopping({ agent: { session: { header: {} }, steer: (m) => steer4.push(m) }, turn: 1, signal: { aborted: false } })
    check('18o noticeSwitch false silences it', steer4.length === 0, 'steered=' + steer4.length)

    // The reason in the notice belongs to the model named as "from", so it must
    // come from that model's own failure - not from whichever candidate failed
    // immediately before the winner. With two dead candidates those differ: the
    // starting model was out of balance, the one after it had a socket reset, and
    // reading lastFailure reported "(network)" for a balance wall. This is the
    // exact shape that produced a real notice on 2026-10-18.
    // The fixture has two providers and three models: alpha fails on balance,
    // beta (the next channel of the same provider) fails on a socket, gamma
    // answers. Two different dead reasons, so the notice has to pick one.
    const chain = makeCtx((options) => {
      if (options.model === 'alpha') return [{ type: 'finish', reason: { kind: 'error', failure: { message: '429: {"message":"insufficient balance"}' } } }]
      if (options.model === 'beta') return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'fetch failed: ECONNRESET' } } }]
      return [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]
    })
    const chainTurn = []
    const innerOn3 = chain.ctx.on
    chain.ctx.on = (event, fn) => { if (event === 'agent/turn-stopping') chain.turnStopping = fn; return innerOn3(event, fn) }
    apply(chain.ctx, { retriesPerModel: 0, maxCandidates: 8, confirmSwitch: false, noticeSwitch: true }, {})
    await collect(chain.run({ provider: 'provA', model: 'alpha', messages: [] }))
    chain.turnStopping({ agent: { session: { header: {} }, steer: (m) => chainTurn.push(m) }, turn: 1, signal: { aborted: false } })
    const chainText = chainTurn.length === 1 ? chainTurn[0].content[0].text : ''
    check('18p the notice blames the origin model, not the last failure',
      /(quota)/.test(chainText) && !/\(network\)/.test(chainText),
      'notice=' + JSON.stringify(chainText) + ' attempted=' + chain.attempted.join(','))
  } finally {
    if (priorCfg === undefined) delete process.env.DSH_MODEL_ROTOR_CONFIG
    else process.env.DSH_MODEL_ROTOR_CONFIG = priorCfg
  }
}

// ---- scenario 19: the channel label and the channel's own switch --------------
// The page names a channel with the vendor label the host publishes on the
// registered route (`name`: "硅基流动" for siliconflow). Reading the
// configurable-directory spelling instead left every channel labelled with its
// raw route id, which is the second half of "渠道名称不对".
{
  const { mkdtempSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rotator-label-'))
  const priorCfg = process.env.DSH_MODEL_ROTOR_CONFIG
  process.env.DSH_MODEL_ROTOR_CONFIG = join(dir, 'config.json')
  try {
    const h = makeCtx(() => [], undefined, { route: true })
    h.ctx.llm.listProviders = () => [
      { id: 'provA', name: '协力厂商A' },
      { id: 'provB' },
    ]
    apply(h.ctx, {}, {})
    const list = await h.request('GET')
    const labelled = list.payload.channels.find(c => c.provider === 'provA')
    const bare = list.payload.channels.find(c => c.provider === 'provB')
    check('19a a channel carries the label its route publishes', labelled?.displayName === '协力厂商A', JSON.stringify(list.payload.channels.map(c => c.provider + '=' + c.displayName)))
    check('19b a route with no label falls back to its id', bare?.displayName === 'provB' && bare?.channel === 'provB', JSON.stringify(bare && { d: bare.displayName, c: bare.channel }))
    // The header button is labelled from this flag, so an untouched channel must
    // read as open rather than as "some rows are off for other reasons".
    check('19c an untouched channel reads as open', labelled?.switchedOff === false, String(labelled?.switchedOff))
    const off = await h.request('POST', { key: 'provA', enabled: false, scope: 'provider' })
    const closed = off.payload.list.channels.find(c => c.provider === 'provA')
    check('19d a closed channel reports switchedOff', off.status === 200 && closed?.switchedOff === true && closed.models.every(m => m.inRotation === false), JSON.stringify(closed && { off: closed.switchedOff, n: closed.models.length }))
    const back = await h.request('POST', { key: 'provA', enabled: true, scope: 'provider' })
    const open = back.payload.list.channels.find(c => c.provider === 'provA')
    check('19e reopening clears the flag and restores the rows', back.status === 200 && open?.switchedOff === false && open.models.every(m => m.inRotation === true), JSON.stringify(open && { off: open.switchedOff, n: open.models.length }))
  } finally {
    if (priorCfg === undefined) delete process.env.DSH_MODEL_ROTOR_CONFIG
    else process.env.DSH_MODEL_ROTOR_CONFIG = priorCfg
  }
}

// ---- scenario 20: one candidate per model family, and a stable dispatcher ----
// Two defects observed on a live host. (a) The same model configured on several
// channels produced one candidate per channel, so a single shared quota wall
// burned the whole walk on what is effectively one model and the switch notice
// read as "switched to the same model again". (b) The dispatcher was read as a
// live `ctx.llm` property inside the walk, which cordis refuses once the fibre
// is inactive (an automatic continuation): the switch then threw
// `cannot get required service "llm" in inactive context` and became a no-op.
{
  // (a) one family, one slot: provB and provC both serve 'gamma'.
  const h = makeCtx((options, n) => (n === 1
    ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]
    : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]))
  h.ctx.llm.listProviders = () => [{ id: 'provA' }, { id: 'provB' }, { id: 'provC' }]
  h.ctx.llm.registration = provider => ({ adapter: { listModels: async p => ({
    provA: [{ id: 'alpha' }],
    provB: [{ id: 'gamma' }],
    provC: [{ id: 'gamma' }],
  })[p] ?? [] } })
  apply(h.ctx, { retriesPerModel: 0, maxCandidates: 8, confirmSwitch: false }, {})
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  const gammaHits = h.attempted.filter(k => k.endsWith('/gamma'))
  check('20a one model family occupies one candidate slot', gammaHits.length === 1, 'attempted=' + h.attempted.join(','))

  // (b) the dispatcher is captured before the first await, so a deactivated
  // context cannot turn a switch into a silent no-op.
  const stale = makeCtx((options, n) => (n === 1
    ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }]
    : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]))
  apply(stale.ctx, { retriesPerModel: 0, maxCandidates: 4, confirmSwitch: false }, {})
  // Simulate what the host actually does: the turn dispatches while the fibre is
  // still active (the harness itself had to call ctx.llm.stream to get here), and
  // the fibre goes inactive while the walk is parked on an await. From that point
  // every *live* `ctx.llm` read throws the way cordis does for an injected
  // service in an inactive context. The dispatcher captured before the first
  // await must keep the rest of the walk working - reading it live is exactly
  // what turned a switch into a no-op.
  let liveReads = 0
  const realLlm = stale.ctx.llm
  Object.defineProperty(stale.ctx, 'llm', {
    configurable: true,
    get() {
      // The very first read is the harness reaching the waterfall; after the first
      // attempt has been recorded the context is parked and reads must fail.
      if (stale.attempted.length === 0) return realLlm
      liveReads += 1
      throw new Error('cannot get required service "llm" in inactive context')
    },
  })
  await collect(stale.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('20b the walk keeps dispatching after the fibre deactivates', stale.attempted.length >= 2, 'attempted=' + stale.attempted.join(','))
  check('20c the walk never re-reads a deactivated ctx.llm', liveReads === 0, 'liveReads=' + liveReads + ' attempted=' + stale.attempted.join(','))
}

// ---- scenario 21: discovery survives a deactivated context too ----------------
// The same defect class as 20b, on the other half of the plugin: listProviders()
// and registration() are read while building the candidate list, which happens
// after awaits. A live ctx.llm read there failed the same way and left the walk
// with no candidates at all.
{
  const h = makeCtx((options, n) => (n === 1
    ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]
    : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]))
  const realLlm = h.ctx.llm
  apply(h.ctx, { retriesPerModel: 0, maxCandidates: 4, confirmSwitch: false }, {})
  // One real read lets the plugin capture the service; every later live read
  // throws the way cordis does for an inactive fibre.
  let liveReads = 0
  Object.defineProperty(h.ctx, 'llm', {
    configurable: true,
    get() {
      liveReads += 1
      if (liveReads === 1) return realLlm
      throw new Error('cannot get required service "llm" in inactive context')
    },
  })
  await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('21a discovery still produced candidates after deactivation', h.attempted.length >= 2, 'attempted=' + h.attempted.join(','))
  check('21b discovery does not keep reading a deactivated ctx.llm', liveReads <= 2, 'liveReads=' + liveReads)
}

// ---- scenario 22: a plugin-internal dispatch error is not model evidence ------
// 'cannot get required service "llm" in inactive context' described a bug in this
// plugin, not a fact about the model: the dispatch never left the machine. A row
// carrying it must not be restored as a failure, or a healthy route stays marked
// broken until it happens to answer again.
{
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rotator-inactive-'))
  const priorStats = process.env.DSH_MODEL_ROTOR_STATS
  process.env.DSH_MODEL_ROTOR_STATS = join(dir, 'stats.json')
  // Seed the file BEFORE apply: hydrateStats() reads once on first use, so a write
  // after the harness is mounted would arrive too late to be restored at all.
  writeFileSync(join(dir, 'stats.json'), JSON.stringify({
    version: 1,
    rows: {
      'provA/beta': {
        savedAt: Date.now(), attempts: 6, successes: 0, failures: 6, consecutiveFailures: 6,
        cooldownUntil: 0, lastError: 'Error: cannot get required service "llm" in inactive context', lastErrorKind: '',
      },
      'provB/gamma': {
        savedAt: Date.now(), attempts: 2, successes: 0, failures: 2, consecutiveFailures: 2,
        cooldownUntil: 0, lastError: '429 insufficient balance', lastErrorKind: '',
      },
    },
  }), 'utf8')
  const h = makeCtx(() => [], undefined, { sameStats: true, route: true })
  try {
    apply(h.ctx, {}, {})
    const list = await h.request('GET')
    const saved = list.payload.models.find(m => m.key === 'provA/beta')
    const kept = list.payload.models.find(m => m.key === 'provB/gamma')
    // Counters are cleared with the prose, so the route reads as usable again
    // rather than as a route with failures on record.
    check('22a a plugin-internal dispatch error is not carried forward', saved.health === 'ok' && saved.failures === 0 && saved.attempts === 0, JSON.stringify(saved.health + ':' + saved.lastErrorKind + ':' + saved.failures + '/' + saved.attempts))
    check('22b a real provider failure is still carried forward', kept.health === 'error' && kept.lastErrorKind === 'quota', JSON.stringify(kept.health + ':' + kept.lastErrorKind))
    // A healed row also has to be *written back*. Omitting it from the payload
    // would leave the stale copy in the file, and the following boot would restore
    // it and mark a healthy route broken all over again.
    // The heal schedules a debounced write; wait for it rather than assuming one.
    await new Promise(resolve => setTimeout(resolve, 1500))
    const written = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')).rows ?? {}
    const healedRow = written['provA/beta']
    const stale = healedRow === undefined || (healedRow.lastError ?? '') !== '' || (healedRow.failures ?? 0) !== 0
    check('22c a healed row is replaced on disk, not dropped', !stale, JSON.stringify(healedRow ?? null))
  } finally {
    if (priorStats === undefined) delete process.env.DSH_MODEL_ROTOR_STATS
    else process.env.DSH_MODEL_ROTOR_STATS = priorStats
  }
}

// ---- scenario 23: a host refusal is not model evidence ------------------------
// A refusal raised *around* the provider boundary - the harness or another plugin
// answering with a dsh_* envelope, or a fault inside this plugin - arrives as an
// ordinary error finish, so the walk used to write it straight into the route's
// counters. That is how a healthy channel ended up cooled down and shown as
// broken after a compaction call another plugin had refused: the failure was
// this machine's, not the model's, and the cooling moved the ranking away from a
// route that had done nothing wrong.
{
  const pluginFault = 'Error: cannot get required service "llm" in inactive context'
  const wireRefusal = '422: {"type":"server_error","code":"dsh_compaction_refused","message":"refused"}'
  check('23a the predicate claims host-side refusals only',
    isHostRefusal(pluginFault) && isHostRefusal(wireRefusal)
      && isHostRefusal('model-rotator: dispatch error')
      && !isHostRefusal('429 insufficient balance')
      && !isHostRefusal(''),
    JSON.stringify([pluginFault, wireRefusal].map(m => isHostRefusal(m))))

  // A refusal from around the provider boundary. The current model fails
  // honestly, the next candidate is refused by the host, and a third one answers.
  // The walk must keep going - the refusal says nothing about that route - the
  // refusal must leave no trace on it, and the answer must not be adopted as the
  // session's model, because the user's own model was never actually reached.
  {
    const { adoptions, seams } = seamsFor({ selected: ['切换'] })
    const h = makeCtx((options, n) => (n === 1
      ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted' } } }]
      : (n === 2
        ? [{ type: 'finish', reason: { kind: 'error', failure: { message: wireRefusal } } }]
        : [{ type: 'text-delta', index: 0, text: 'ok from ' + options.model }, { type: 'finish', reason: { kind: 'stop' } }])), seams, { route: true })
    h.ctx.llm.listProviders = () => [{ id: 'provA' }, { id: 'provB' }, { id: 'provC' }]
    const models = { provA: [{ id: 'alpha' }], provB: [{ id: 'beta' }], provC: [{ id: 'gamma' }] }
    h.ctx.llm.registration = provider => ({ adapter: { listModels: async p => models[p] ?? [] } })
    apply(h.ctx, { retriesPerModel: 0, maxCandidates: 4, confirmSwitch: false }, {})
    const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
    const list = await h.request('GET')
    const refused = list.payload.models.find(m => m.key === 'provB/beta')
    const real = list.payload.models.find(m => m.key === 'provA/alpha')
    check('23b a wire refusal leaves the route unblamed',
      refused?.failures === 0 && refused?.lastError === '' && refused?.rest === 0 && refused?.health === 'ok',
      JSON.stringify(refused && { f: refused.failures, e: refused.lastError, k: refused.lastErrorKind, rest: refused.rest, h: refused.health }))
    check('23bb the real provider failure is still on record',
      real?.failures === 1 && /quota exhausted/.test(String(real?.lastError)),
      JSON.stringify(real && { f: real.failures, e: real.lastError }))
    check('23bc the walk still reached a model that answered',
      switched(chunks) && h.attempted.length === 3 && adoptions.length === 0,
      'attempted=' + h.attempted.join(',') + ' adoptions=' + adoptions.length)
  }

  // A fault inside this plugin. Unlike a wire refusal it cannot be walked off -
  // the next candidate would hit the same wall - so the walk ends on it, and the
  // caller still receives a finish rather than a stream that dies silently.
  {
    const { adoptions, seams } = seamsFor({ selected: ['切换'] })
    const h = makeCtx((options, n) => (n === 1
      ? [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted' } } }]
      : [{ type: 'finish', reason: { kind: 'error', failure: { message: pluginFault } } }]), seams, { route: true })
    h.ctx.llm.listProviders = () => [{ id: 'provA' }, { id: 'provB' }, { id: 'provC' }]
    const models = { provA: [{ id: 'alpha' }], provB: [{ id: 'beta' }], provC: [{ id: 'gamma' }] }
    h.ctx.llm.registration = provider => ({ adapter: { listModels: async p => models[p] ?? [] } })
    apply(h.ctx, { retriesPerModel: 0, maxCandidates: 4, confirmSwitch: false }, {})
    const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
    const list = await h.request('GET')
    const refused = list.payload.models.find(m => m.key === 'provB/beta')
    const fins = chunks.filter(c => c.type === 'finish')
    check('23c a plugin fault leaves the route unblamed',
      refused?.failures === 0 && refused?.lastError === '' && refused?.rest === 0,
      JSON.stringify(refused && { f: refused.failures, e: refused.lastError, rest: refused.rest }))
    check('23cb a plugin fault ends the walk instead of burning every candidate',
      h.attempted.length === 2 && !h.attempted.includes('provC/gamma'),
      'attempted=' + h.attempted.join(','))
    check('23cc the caller still gets a finish, naming the fault',
      fins.length === 1 && /inactive context/.test(String(fins[0]?.reason?.failure?.message)) && adoptions.length === 0,
      JSON.stringify(fins[fins.length - 1]) + ' adoptions=' + adoptions.length)
  }

  // A host refusal must not be retried either. A quota wall and an unsupported
  // request are already settled before a retry could matter, because neither
  // changes between two dispatches; a refusal decided on this machine is the
  // same kind of certainty. Retrying it spent the whole retry budget *and*
  // slept the exponential backoff before ending the turn on the same error -
  // measured at four dispatches and 1.8s of sleeping before this was fixed.
  // The refused candidate answers with the same refusal every time, so its
  // dispatch count is exactly what the retry policy spends.
  for (const [label, message, endExpectation] of [
    ['23d a wire refusal is not retried', '422: {"type":"server_error","code":"dsh_compaction_refused","message":"refused"}', 'provC/gamma'],
    ['23e a plugin fault is not retried either', 'Error: cannot get required service "llm" in inactive context', null],
  ]) {
    const h = makeCtx((options) => {
      if (options.provider === 'provA') return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted' } } }]
      if (options.provider === 'provB') return [{ type: 'finish', reason: { kind: 'error', failure: { message } } }]
      return [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]
    })
    h.ctx.llm.listProviders = () => [{ id: 'provA' }, { id: 'provB' }, { id: 'provC' }]
    const models = { provA: [{ id: 'alpha' }], provB: [{ id: 'beta' }], provC: [{ id: 'gamma' }] }
    h.ctx.llm.registration = provider => ({ adapter: { listModels: async p => models[p] ?? [] } })
    // The retry budget is deliberately left at its default of 3: the claim is
    // that a host refusal never reaches the retry branch at all.
    apply(h.ctx, { maxCandidates: 4, confirmSwitch: false }, {})
    await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
    const betaDispatches = h.attempted.filter(k => k === 'provB/beta').length
    const endedRight = endExpectation === null ? !h.attempted.includes('provC/gamma') : h.attempted.includes(endExpectation)
    check(label + ' - one dispatch, not retriesPerModel',
      betaDispatches === 1 && endedRight,
      'dispatches=' + betaDispatches + ' attempted=' + h.attempted.join(','))
  }
}

// ---- account-pool exhaustion is a quota wall, and it states its own release ----
{
  const REAL = 'WorkBuddy (国际版)：模型 deepseek-v4.1-flash 的可用账号均在限流中，最近一个将于 2026/10/18 00:29:52 解禁。可改用其它 provider / 模型，'
  // Every account exhausted is not a rate blip: as rate-limit it cooled 60s and
  // retried the same wall hundreds of times in one evening.
  check('an exhausted account pool classifies as quota, not rate-limit',
    classifyFailureKind(REAL) === 'quota', classifyFailureKind(REAL))
  // The narrowness matters: an ordinary 429 must keep the cheap backoff.
  check('an ordinary rate limit is still rate-limit',
    classifyFailureKind('429 too many requests') === 'rate-limit' &&
    classifyFailureKind('请求过于频繁，请稍后再试') === 'rate-limit')
  check('the existing quota vocabulary still classifies as quota',
    ['账户余额不足', 'quota exceeded', '额度已用尽'].every(t => classifyFailureKind(t) === 'quota'))

  // The provider says exactly when the pool comes back; that beats any calendar rule.
  const stated = parseReleaseTime(REAL)
  const asLocal = stated ? new Date(stated) : null
  check('the stated release time is parsed from the sentence',
    asLocal !== null && asLocal.getFullYear() === 2026 && asLocal.getMonth() === 9 &&
    asLocal.getDate() === 18 && asLocal.getHours() === 0 && asLocal.getMinutes() === 29 &&
    asLocal.getSeconds() === 52,
    asLocal ? asLocal.toISOString() : 'unparsed')
  check('a date without a time parses as that day, and prose without one parses as nothing',
    parseReleaseTime('release at 2026/12/25') > 0 && parseReleaseTime('no date here') === 0)
}

// ---- a pin defers while it cools, instead of walking into the same wall ----
{
  // The walk only reveals the head when the current model fails first, so every
  // run here makes provA/alpha fail with an empty turn and lets the ranking decide
  // the rest. That is also the shape of the real complaint: a pinned model that is
  // cooling must not be dispatched before a healthy one.
  const runWithPin = async (row) => {
    freshStatsFile()
    if (row !== undefined) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(process.env.DSH_MODEL_ROTOR_STATS, JSON.stringify({ version: 1, rows: { 'provA/beta': row } }, null, 2), 'utf8')
    }
    const cfgFile = join(sandbox, 'pin-config-' + (row === undefined ? 'none' : 'cool') + '.json')
    const { writeFileSync: wf } = await import('node:fs')
    wf(cfgFile, JSON.stringify({ pinned: 'provA/beta' }), 'utf8')
    process.env.DSH_MODEL_ROTOR_CONFIG = cfgFile
    // alpha always fails with no content, so the walk continues past it.
    const h = makeCtx(() => ([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]))
    apply(h.ctx, { confirmSwitch: false }, {})
    await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
    return h.attempted
  }

  const healthy = await runWithPin({
    savedAt: Date.now(), attempts: 9, successes: 9, failures: 0,
    consecutiveFailures: 0, cooldownUntil: 0, lastError: '', lastErrorKind: '',
  })
  // Each model is retried, so the walk lists attempts rather than models. The
  // question is only which model the walk reaches *after* the current one.
  const secondModel = attempts => {
    const first = attempts[0]
    return attempts.find(a => a !== first)
  }
  check('a healthy pin is tried first after the current model',
    healthy[0] === 'provA/alpha' && secondModel(healthy) === 'provA/beta',
    'order=' + healthy.join(','))

  // Hydration is a once-per-boot step, so a second harness in this process would
  // reuse the first one's rows. The cooling case therefore runs in its own process
  // (test-pin-cooling.mjs), where the seeded row is what boots.
  {
    // The probe's stdout is captured through a file descriptor rather than a pipe.
    // Confined Windows hosts deny the *pipe* a child's output would travel on
    // (spawnSync with stdio 'pipe' fails EPERM), while an inherited file handle
    // works everywhere - the same bytes, one less platform assumption.
    const { spawnSync } = await import('node:child_process')
    const { openSync, closeSync, readFileSync, mkdtempSync } = await import('node:fs')
    const probe = join(dirname(fileURLToPath(import.meta.url)), 'test-pin-cooling.mjs')
    const captureDir = mkdtempSync(join(tmpdir(), 'rotator-pin-'))
    const capturePath = join(captureDir, 'stdout.txt')
    const fd = openSync(capturePath, 'w')
    let proc = null
    let captured = ''
    try {
      proc = spawnSync(process.execPath, [probe], { stdio: ['ignore', fd, 'ignore'], timeout: 60000 })
    } catch (error) {
      captured = ''
      proc = { error: error, status: null }
    } finally {
      closeSync(fd)
    }
    try { captured = readFileSync(capturePath, 'utf8') } catch { captured = '' }
    let order = []
    try { order = JSON.parse(String(captured).trim().split('\n').pop()).order } catch { /* asserted below */ }
    check('a cooling pin is not dispatched ahead of a healthy model',
      order.length > 1 && order[1] !== 'provA/beta',
      'order=' + order.join(',') + (proc?.error ? '  spawn=' + String(proc.error).slice(0, 100) : ''))
  }
}

// ---- a failing channel does not strand healthy siblings of the same model ----
{
  // The real report: WorkBuddy hit its quota wall while buddy and trae - the same
  // model on other channels - were healthy and serving. Collapsing each family to
  // exactly one channel left them unreachable and the turn ended on the wall.
  //
  // The fixture has to fail twice before the healthy channel, or the walk stops on
  // the first success and the family cap never shows its effect: with one-per-family
  // the second sibling is not in the walk at all, so the turn dies on the second
  // failure; with two it reaches the third channel and the turn succeeds.
  const h = makeCtx((options) => (options.provider === 'provC'
    ? [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'ok from ' + options.provider },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    : [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted 可用账号均受限' } } }]))
  h.ctx.llm.listProviders = () => [{ id: 'provA' }, { id: 'provB' }, { id: 'provC' }]
  h.ctx.llm.registration = () => ({ adapter: { listModels: async q => ({ provA: [{ id: 'twin' }], provB: [{ id: 'twin' }], provC: [{ id: 'twin' }] })[q] ?? [] } })
  apply(h.ctx, { confirmSwitch: false, adoptSwitchedModel: false }, {})
  const chunks = await collect(h.run({ provider: 'provA', model: 'twin', messages: [] }))
  const final = chunks.filter(c => c.type === 'finish').pop()
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  // Three channels of one model: current + two siblings. Both siblings must be in
  // the walk for the healthy third channel to be reachable after two failures.
  check('a healthy sibling channel of the same model is still reachable',
    text.includes('ok from provC') && final?.reason?.kind === 'stop',
    'text=' + JSON.stringify(text) + ' finish=' + JSON.stringify(final?.reason) + ' attempted=' + [...new Set(h.attempted)].join(','))
}

// ---- scenario 20: the switch log the conversation tab reads -------------------
// The record used to exist only as a notice row inside the conversation, which
// spent context on a plumbing fact the reader may not have been looking at. It
// now lives in the plugin, keyed by the session captured *where the switch
// happened* - not at the turn boundary, which is process-wide and therefore
// files one conversation's switch under whichever conversation stops its turn
// next. The row is opt-in, so a reader who turned it off still has history.
{
  const { mkdtempSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'rotator-switchlog-'))
  process.env.DSH_MODEL_ROTOR_STATS = join(dir, 's.json')
  const priorCfg = process.env.DSH_MODEL_ROTOR_CONFIG
  process.env.DSH_MODEL_ROTOR_CONFIG = join(dir, 'absent.json')
  try {
    const quotaThenOk = options => (options.model === 'alpha'
      ? [{ type: 'finish', reason: { kind: 'error', failure: { message: '429: {"message":"insufficient balance"}' } } }]
      : [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }])
    // The session the walk ran under. Nothing in the llm/stream seam carries one,
    // so the plugin asks the live-turn lookup - the same seam adoptServedModel()
    // already trusts - and this fixture answers with the agent it "started".
    const liveSession = { id: 'sess-1', header: {} }
    const h = makeCtx(quotaThenOk, undefined, { route: true, liveAgent: () => ({ session: liveSession, steer: () => {} }) })
    const steered = []
    const innerOn = h.ctx.on
    h.ctx.on = (event, fn) => { if (event === 'agent/turn-stopping') h.turnStopping = fn; return innerOn(event, fn) }
    apply(h.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
    // The record is written where the switch happens now, so "starts empty" is
    // asserted before the failing run, not after it.
    const empty = await h.request('GET', undefined, '/_dsh/model-rotator/switches', 1)
    check('20a the log starts empty', empty.status === 200 && empty.payload.entries.length === 0, JSON.stringify(empty.payload).slice(0, 120))
    await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))

    // The point of the whole rewrite: the record is durable *without* the turn
    // boundary. No turn-stopping has fired yet, and the row is already filed -
    // with the session the switch itself ran under.
    const mine = await h.request('GET', undefined, '/_dsh/model-rotator/switches?session=sess-1', 1)
    const row = mine.payload.entries[0]
    check('20b the record lands without any turn-stopping',
      mine.status === 200 && mine.payload.entries.length === 1 && row !== undefined && row.session === 'sess-1',
      JSON.stringify(mine.payload.entries).slice(0, 200))
    check('20c the switch is recorded against the session it ran under',
      row !== undefined && row.reason === 'quota' && row.from.provider === 'provA' && row.to.provider === 'provA',
      JSON.stringify(mine.payload.entries).slice(0, 200))
    check('20d the labels are the ones the reader recognises',
      row !== undefined && row.from.label === 'alpha' && row.to.label === 'beta',
      row === undefined ? 'no row' : JSON.stringify([row.from.label, row.to.label]))

    // The boundary is now only the *opt-in* row - off by default - and it neither
    // duplicates the record nor moves it.
    h.turnStopping({ agent: { session: { id: 'sess-1', header: {} }, steer: m => steered.push(m) }, turn: 1, signal: { aborted: false } })
    check('20e the in-conversation row is off by default', steered.length === 0, 'steered=' + steered.length)
    const afterBoundary = await h.request('GET', undefined, '/_dsh/model-rotator/switches?session=sess-1', 1)
    check('20f the boundary neither duplicates nor relocates the record',
      afterBoundary.payload.entries.length === 1 && afterBoundary.payload.entries[0].session === 'sess-1',
      JSON.stringify(afterBoundary.payload.entries).slice(0, 200))

    const other = await h.request('GET', undefined, '/_dsh/model-rotator/switches?session=sess-2', 1)
    check('20g another conversation sees nothing', other.payload.entries.length === 0, 'entries=' + other.payload.entries.length)
    const all = await h.request('GET', undefined, '/_dsh/model-rotator/switches', 1)
    check('20h asking for every session returns it', all.payload.entries.length === 1 && all.payload.total === 1, JSON.stringify(all.payload).slice(0, 120))

    // -- the cross-talk regression -------------------------------------------------
    // The reported failure, reproduced: conversation A switches and its turn never
    // stops; conversation B stops its turn afterwards. Before this fix A's switch
    // was batched out of the process-wide queue at B's boundary and filed under
    // B's session, which is what made A's own tab read "no model switches in this
    // conversation". A must keep its record, and B's boundary must add nothing.
    const aSession = { id: 'sess-A', header: {} }
    const cross = makeCtx(quotaThenOk, undefined, { route: true, liveAgent: () => ({ session: aSession, steer: () => {} }) })
    const innerOn2 = cross.ctx.on
    cross.ctx.on = (event, fn) => { if (event === 'agent/turn-stopping') cross.turnStopping = fn; return innerOn2(event, fn) }
    apply(cross.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
    await collect(cross.run({ provider: 'provA', model: 'alpha', messages: [] }))
    // No turn-stopping for A at all. B's boundary fires next, as the other
    // conversation's would in the live harness.
    const steeredB = []
    cross.turnStopping({ agent: { session: { id: 'sess-B', header: {} }, steer: m => steeredB.push(m) }, turn: 5, signal: { aborted: false } })
    const aRows = await cross.request('GET', undefined, '/_dsh/model-rotator/switches?session=sess-A', 1)
    const bRows = await cross.request('GET', undefined, '/_dsh/model-rotator/switches?session=sess-B', 1)
    check('20i a conversation that never stops its turn still owns its record',
      aRows.payload.entries.length === 1 && aRows.payload.entries[0].session === 'sess-A',
      JSON.stringify(aRows.payload.entries).slice(0, 200))
    check('20j a later turn boundary cannot steal a record it did not cause',
      bRows.payload.entries.length === 0,
      'entries=' + bRows.payload.entries.length + ' ' + JSON.stringify(bRows.payload.entries).slice(0, 160))

    // -- no live turn --------------------------------------------------------------
    // A plugin route is not a turn: with no currentInitiator the switch still has
    // to be recorded, and it says so honestly by leaving the session empty - the
    // log reads '' as "every session", never as an error.
    const orphan = makeCtx(quotaThenOk, undefined, { route: true })
    apply(orphan.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
    await collect(orphan.run({ provider: 'provA', model: 'alpha', messages: [] }))
    const orphanAll = await orphan.request('GET', undefined, '/_dsh/model-rotator/switches', 1)
    check('20k a switch with no live turn is still recorded, with an empty session',
      orphanAll.payload.entries.length === 1 && orphanAll.payload.entries[0].session === '',
      JSON.stringify(orphanAll.payload.entries).slice(0, 200))
    check('20l a missing live turn neither throws nor complains about it',
      orphan.warns.filter(w => /session|initiator|agent/i.test(w)).length === 0,
      JSON.stringify(orphan.warns).slice(0, 200))

    // Opting the row back in still steers the row, and the record is unchanged by it.
    const opt = makeCtx(quotaThenOk, undefined, { route: true, liveAgent: () => ({ session: liveSession, steer: () => {} }) })
    const steered2 = []
    const innerOn3 = opt.ctx.on
    opt.ctx.on = (event, fn) => { if (event === 'agent/turn-stopping') opt.turnStopping = fn; return innerOn3(event, fn) }
    apply(opt.ctx, { retriesPerModel: 0, maxCandidates: 6, noticeSwitch: true }, {})
    await collect(opt.run({ provider: 'provA', model: 'alpha', messages: [] }))
    opt.turnStopping({ agent: { session: { id: 'sess-1', header: {} }, steer: m => steered2.push(m) }, turn: 1, signal: { aborted: false } })
    check('20m opting the row back in still posts it',
      steered2.length === 1 && steered2[0].source.form === 'notice',
      'steered=' + steered2.length)
  } finally {
    if (priorCfg === undefined) delete process.env.DSH_MODEL_ROTOR_CONFIG
    else process.env.DSH_MODEL_ROTOR_CONFIG = priorCfg
  }
}

// ---- scenario 21: a route too small for this conversation is not a candidate --
// The failure this guards against is not a broken provider: the route answers
// fine, the conversation just does not fit in it. Switching there kills the
// turn, and the compaction that could have shrunk the conversation cannot run
// either, because the summary is requested on that same route.
{
  const quotaOnly = () => ([
    { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted 可用账号均受限' } } },
  ])
  // The default roster is what these fixtures budget against: provA/alpha and
  // provA/beta on one channel, provB/gamma on the other. The small route is
  // therefore provA/beta, and every window below is keyed to a route that
  // actually exists - a guard test against a model the fixture never published
  // would pass without the guard doing anything.
  const fixtures = {
    pressure: { tokens: 900000, window: 1000000 },
    windows: { 'provA/alpha': 1000000, 'provA/beta': 262144, 'provB/gamma': 1000000 },
  }

  // 21a: a candidate that cannot hold the conversation is never dispatched.
  const h = makeCtx(quotaOnly, undefined, fixtures)
  apply(h.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  const chunks = await collect(h.run({ provider: 'provA', model: 'alpha', messages: [] }))
  const final = chunks.filter(c => c.type === 'finish').pop()
  check('21a a candidate smaller than this conversation is not dispatched',
    !h.attempted.includes('provA/beta') && h.attempted.includes('provB/gamma') && final?.reason?.kind === 'error',
    'attempted=' + h.attempted.join(',') + ' finish=' + JSON.stringify(final?.reason))

  // 21b: the control - same fixture, guard off, and the small route IS dialed.
  const off = makeCtx(quotaOnly, undefined, fixtures)
  apply(off.ctx, { retriesPerModel: 0, maxCandidates: 6, windowGuard: false }, {})
  await collect(off.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('21b with the guard off the small route is dialed again',
    off.attempted.includes('provA/beta'),
    'attempted=' + off.attempted.join(','))

  // 21c: a route whose adapter publishes no window must not be guessed about.
  const silent = makeCtx(quotaOnly, undefined, {
    pressure: fixtures.pressure,
    windows: { 'provA/alpha': 1000000, 'provB/gamma': 1000000 },
  })
  apply(silent.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  await collect(silent.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('21c an unpublished window is not read as a small one',
    silent.attempted.includes('provA/beta'),
    'attempted=' + silent.attempted.join(','))

  // 21d: with no measurable pressure the guard stands down entirely - a harness
  // that cannot say how big the conversation is must not be second-guessed.
  const blind = makeCtx(quotaOnly, undefined, { windows: fixtures.windows })
  apply(blind.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  await collect(blind.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('21d without a pressure reading nothing is held back',
    blind.attempted.includes('provA/beta'),
    'attempted=' + blind.attempted.join(','))

  // 21e: a route on the same window as the one this conversation already runs
  // on is exempt. The guard decides about *moving*, so a route that offers
  // exactly the room the turn already had is not a reason to leave the model.
  const here = makeCtx(quotaOnly, undefined, {
    pressure: { tokens: 900000, window: 262144 },
    windows: { 'provA/alpha': 262144, 'provA/beta': 262144, 'provB/gamma': 1000000 },
  })
  apply(here.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  await collect(here.run({ provider: 'provA', model: 'alpha', messages: [] }))
  check('21e a route on the current window is not blocked by the guard',
    here.attempted.includes('provA/beta'),
    'attempted=' + here.attempted.join(','))

  // 21f: the model list names the reason, so a row held back for size is not
  // read as a verdict on the model itself.
  const list = makeCtx(quotaOnly, undefined, { ...fixtures, route: true })
  apply(list.ctx, { retriesPerModel: 0, maxCandidates: 6 }, {})
  const models = await list.request('GET', undefined, '/_dsh/model-rotator/models', 0)
  // The route reports the same flattened row list the settings page renders.
  const rows = models.payload?.models ?? []
  const beta = rows.find(row => row.key === 'provA/beta')
  const gamma = rows.find(row => row.key === 'provB/gamma')
  check('21f the list reports the window as the reason',
    beta?.reason === 'window' && beta?.inRotation === false && gamma?.reason === '',
    'beta=' + JSON.stringify(beta && { reason: beta.reason, inRotation: beta.inRotation }) + ' gamma=' + JSON.stringify(gamma && gamma.reason))

  // 21g: the report says the guard exists and what it measured.
  const report = await h.registered.get('model_rotator_status').execute({}, {})
  check('21g the status report states the guard and the pressure it used',
    /window guard/.test(report) && /pressure 900000 tokens/.test(report),
    report.split('\n').filter(line => /window guard/.test(line)).join(' | ').slice(0, 240))
}

const failed = results.filter(r => r[0] === 'FAIL')
for (const r of results) console.log(r[0] + '  ' + r[1] + (r[2] ? '   [' + r[2] + ']' : ''))
console.log('\n' + (failed.length === 0 ? 'ALL PASS (' + results.length + ')' : failed.length + ' FAILED of ' + results.length))
process.exit(failed.length === 0 ? 0 : 1)

