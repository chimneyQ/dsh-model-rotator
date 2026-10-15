
/**
 * dsh-model-rotator - model auto-ranking and transparent failover for DSH.
 *
 * What this solves
 * ----------------
 * A quota wall, an expired credential, a per-IP rate limit or a transient 5xx
 * all arrive as "this turn died", even when other configured models on this
 * machine were idle and would have answered. This plugin ranks every enabled
 * model by measured connectivity / TTFT / throughput plus an active failure
 * cooldown, then walks that ranking inside the *same* turn: the first
 * candidate that produces output wins, and the user sees an ordinary reply.
 *
 * Where it hooks
 * --------------
 * llm/stream is a listener waterfall on the harness LLM service: every
 * ctx.llm.stream() funnels all registered listeners in order. We append one
 * listener that wraps the turn:
 *
 *   1. attempt 1 runs the harness path untouched (next()), so every other
 *      plugin's wrapper semantics are preserved exactly;
 *   2. an attempt that fails having produced NO content is abandoned, its
 *      upstream stream is closed, and the next candidate is dispatched as a
 *      fresh ctx.llm.stream({ ...options, provider, model }) call.
 *
 * Re-entrancy: each options object we create for a retry is recorded in a
 * WeakSet before dispatch, so our own listener passes it straight through to
 * the real adapters instead of recursing.
 *
 * Why the switch only happens while nothing has been emitted
 * ---------------------------------------------------------
 * Once any chunk other than usage/finish has been yielded, the reply is
 * already reaching the assembler and a second attempt would duplicate visible
 * text. A failed attempt normally emits a single finish chunk and nothing
 * else, so the zero-content window is exactly the retryable window. That is
 * the deliberate boundary: correctness first, failover second.
 *
 * Asking before switching
 * ----------------------
 * Switching models mid-turn is visible - the reply suddenly arrives from a
 * model the user did not choose - so the plugin can ask first. The question is
 * routed through ctx.userQuestions (the harness's own human-interaction seam),
 * which puts a card in the conversation and settles as either an answer or a
 * timeout: confirm switches, timeout switches, an explicit decline ends the
 * turn on the original failure. The seam needs the exact live root agent of the
 * turn, which currentInitiator() supplies because the agent loop runs its whole
 * turn inside an initiator boundary. When the seam is missing, or the caller is
 * a delegated child agent with no human answerer, the switch proceeds
 * unconfirmed rather than stalling.
 *
 * Red line honoured
 * -----------------
 * This plugin never reads, writes or rewrites model/provider configuration.
 * It does not touch cordis.patch.yml, agent-default-model, llm-pi-ai or any
 * provider registration; it only observes the stream waterfall at runtime and
 * reports what it measured.
 *
 * Settings page
 * -------------
 * The nine fields marked .volatile() in the exported Config appear on the DSH
 * settings page for this plugin. They are live: the host pushes a page edit
 * into the same handles apply() received, so the change applies on the next
 * turn with no restart. Those fields are page-owned - config.json still
 * supplies everything else (the exclusion lists and the pin), and the status
 * tool says so when a file sets a page-owned key. schemastery is loaded through
 * an explicit anchor because a bare import cannot resolve from this package's
 * real path; see loadSchemastery().
 *
 * @module dsh-model-rotator
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'model-rotator'
export const inject = ['tools', 'llm']

/**
 * Defaults for the fields the settings page exposes.
 *
 * Single source of truth: defaultConfig() reads them and the Config schema is
 * built from them, so the page's untouched value and the runtime fallback can
 * never drift apart.
 */
const SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  allowImageFailover: false,
  maxCandidates: 4,
  cooldownBaseMs: 60000,
  maxCooldownMs: 30 * 60000,
  weights: Object.freeze({ connectivity: 0.5, speed: 0.3 }),
  confirmSwitch: true,
  confirmTimeoutMs: 20000,
  adoptSwitchedModel: true,
  retriesPerModel: 2,
  retryBackoffMs: 300,
  preferSameModel: true,
  noticeSwitch: true,
  disabledModels: [],
  quotaCooldownMs: 12 * 60 * 60 * 1000,
  quotaCooldownHour: 0,
  statsPersistTtlMs: 24 * 60 * 60 * 1000,
})

/**
 * Load schemastery, the schema library the harness settings service consumes.
 *
 * A bare import of @deepseek-ai/schemastery cannot be used here: the host loads
 * this package through a junction in the profile node_modules, and Node resolves
 * a module's own URL through the real path (this checkout, on D:), so the bare
 * specifier is looked up from the wrong tree and throws ERR_MODULE_NOT_FOUND.
 *
 * A plain `import z from '@deepseek-ai/schemastery'` cannot be used here. The
 * host loads this package through a junction in the profile's node_modules, and
 * Node resolves a module's own URL through the real path (this checkout, on
 * D:), so the bare specifier is looked up from the wrong tree and throws
 * ERR_MODULE_NOT_FOUND. A throw at load time inside a plugin takes the whole web
 * boot down with it, so the package is resolved through an explicit anchor
 * instead: the profile's own package.json, found under DSH_HOME.
 *
 * Every candidate failing is not fatal. Config then stays undefined, the host
 * skips the settings page (describe() ignores an entry with no schema), and the
 * plugin keeps working from model-rotator/config.json alone. When that happens a
 * best-effort breadcrumb lands in schema-probe.json beside the config file, so
 * the status tool can report the real reason instead of a guess.
 */
const SCHEMA_PROBE = []

/** Record one failed resolution attempt: error code plus the first message line. */
function noteFailure(where, error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
    ? error.code + ' '
    : ''
  const message = String(error !== null && typeof error === 'object' ? error.message : error).split('\n')[0]
  SCHEMA_PROBE.push(where + ' -> ' + code + message)
}

/**
 * The CJS build exports the z factory itself - a function object carrying
 * object/boolean/number as properties - so a check against "object" alone
 * would reject it.
 */
function isSchemaFactory(loaded) {
  return loaded !== null
    && (typeof loaded === 'object' || typeof loaded === 'function')
    && typeof loaded.object === 'function'
}

/** Absolute directories that may hold this plugin, and so its vendor/ copy. */
function pluginDirCandidates(dshHome) {
  const dirs = []
  try {
    const here = fileURLToPath(import.meta.url)
    if (typeof here === 'string' && here.length > 0) dirs.push(dirname(here))
  } catch (error) {
    noteFailure('import.meta.url', error)
  }
  const override = process.env.DSH_MODEL_ROTATOR_DIR
  if (typeof override === 'string' && override.length > 0) dirs.push(override)
  try {
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      dirs.push(join(dshHome, 'profiles', profile, 'node_modules', 'dsh-model-rotator'))
    }
  } catch (error) {
    noteFailure('profiles scan', error)
  }
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index)
}

function loadSchemastery() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const anchors = []
  try {
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      anchors.push(join(dshHome, 'profiles', profile, 'package.json'))
    }
  } catch (error) {
    noteFailure('profiles scan', error)
  }
  try {
    if (typeof import.meta.url === 'string' && import.meta.url.length > 0) anchors.push(import.meta.url)
  } catch (error) {
    noteFailure('import.meta.url', error)
  }

  // 1. The host's own copy, reached through a profile anchor, so the schema
  //    stays on whatever version the host itself installed.
  for (const anchor of anchors) {
    try {
      const loaded = createRequire(anchor)('@deepseek-ai/schemastery')
      if (isSchemaFactory(loaded)) return loaded
      SCHEMA_PROBE.push(anchor + ' -> resolved but is not the schema factory')
    } catch (error) {
      noteFailure(anchor, error)
    }
  }

  // 2. The copy vendored beside this file, required by absolute path. An
  //    absolute target needs no node_modules walk, so it still resolves when
  //    the anchor itself is the problem. The host does not share our schema
  //    objects anyway: volatileForm() rebuilds each volatile leaf from
  //    toJSON() with its own instance, so a second copy is safe here.
  for (const dir of pluginDirCandidates(dshHome)) {
    const target = join(dir, 'vendor', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs')
    for (const anchor of anchors.length > 0 ? anchors : [join(dir, 'package.json')]) {
      try {
        const loaded = createRequire(anchor)(target)
        if (isSchemaFactory(loaded)) return loaded
      } catch (error) {
        noteFailure(anchor + ' => ' + target, error)
      }
    }
  }
  return undefined
}

/**
 * Breadcrumb for the one failure that cannot be observed from inside the host:
 * schemastery did not load, so Config is undefined and the settings page is
 * skipped. Best effort by design - diagnostics must never break the load.
 */
function reportSchemaProbe() {
  try {
    const override = process.env.DSH_MODEL_ROTATOR_CONFIG
    const dir = typeof override === 'string' && override.length > 0
      ? dirname(override)
      : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'model-rotator')
    mkdirSync(dir, { recursive: true })
    const payload = { at: new Date().toISOString(), candidates: SCHEMA_PROBE }
    writeFileSync(join(dir, 'schema-probe.json'), JSON.stringify(payload, null, 2) + '\n')
  } catch {
    // A diagnostics failure is not worth a failed load.
  }
}

const z = loadSchemastery()
if (z === undefined) reportSchemaProbe()

/** The fields the settings page owns; config.json supplies everything else. */
const PAGE_KEYS = [
  'enabled',
  'allowImageFailover',
  'maxCandidates',
  'cooldownBaseMs',
  'maxCooldownMs',
  'quotaCooldownMs',
  'quotaCooldownHour',
  'statsPersistTtlMs',
  'confirmSwitch',
  'confirmTimeoutMs',
  'adoptSwitchedModel',
  'retriesPerModel',
  'retryBackoffMs',
  'preferSameModel',
  'noticeSwitch',
]

/** Combo routes (virtual catalog rows) are never a candidate body. */
const COMBO_PREFIX = 'combo:'

/**
 * Where the browser half reads the model list and writes its switches.
 *
 * The prefix is the host's own convention for plugin HTTP routes (vision-router
 * uses /_dsh/vision-router/...), and the route is auth-gated by the host exactly
 * like every other non-public path, so the browser session is the credential and
 * this plugin adds no auth of its own.
 */
export const MODELS_PATH = '/_dsh/model-rotator/models'

/** Body cap for the list's switch writes; the payload is a handful of strings. */
const MAX_MODELS_BODY_BYTES = 64 * 1024

/**
 * A free-typed answer that means "leave the current model alone".
 *
 * The switch question's answer is a label pick, but the composer also accepts a
 * typed reply, and a typed "不切换" arrives as custom text with an empty
 * selection. Matching the refusal prefixes keeps that reply on the same side as
 * the explicit decline option instead of being read as consent.
 */
const SWITCH_REFUSAL = /^(不|否|别|取消|拒绝|保持|停|no|n|cancel|stop|deny|keep|stay)/i

/**
 * Model families that cannot answer a chat turn, by name.
 *
 * Discovery walks every provider's listModels(), and that listing is a *catalog*,
 * not a roster of conversational models: the same providers publish embedding,
 * reranker, ASR, TTS, OCR, image-generation and content-moderation models
 * alongside their chat models. Dialing one of those as a fallback cannot
 * succeed - it fails the turn, then burns a cooldown slot that a real model
 * could have used.
 *
 * The harness adapter strips the catalog's own `wire: 'chat'` marker before
 * handing rows to listModels(), so the capability cannot be read off the row.
 * Name matching is therefore the available signal, and it is deliberately
 * narrow: a pattern must not touch a chat model that merely mentions a modality
 * ("Qwen3-VL-8B-Instruct" is chat, "Z-Image-Turbo" is not).
 *
 * Overridable through the `excludePatterns` config key (regex sources, added
 * verbatim to this list).
 */
const NON_CHAT_PATTERNS = [
  // vectors and ranking.
  // Note the deliberate lack of a leading \\b: these tokens are routinely a
  // suffix or infix of a compound family name (bge-m3, bge-reranker-v2-m3,
  // Qwen3-Embedding) and a leading boundary would miss every one of them.
  '(bge|m3e|text-embedding|embeddings?|rerankers?|reranks?)(?![a-z0-9])',
  // speech in and out. CosyVoice2 / SenseVoiceSmall / XingChenASR carry the
  // token inside a longer word, so no leading boundary and no trailing one.
  '(asr|tts|speech|whisper|sensevoice|cosyvoice|diariz)',
  // image and video generation, editing, captioning
  '(z-image|qwen-image|kolors|wan\\d|flux|stable-diffusion|dall-e|midjourney|nano-banana|imagen|image-edit|seedream|seededit)',
  // document / pixel parsing (PaddleOCR-VL carries "ocr" mid-word)
  '(ocr|mineru|captioner)',
  // safety classifiers and judges (CompassJudger carries "judger" mid-word)
  '(content-safety|moderation|prompt-guard|judger|judge)',
]

/**
 * The image-reading mode dsh-vision-router builds.
 *
 * The plugin wraps a real chat *route* into a twin whose only job is to add image
 * reading: a "<provider>-vision" provider (the contract vision-router documents
 * as "generated twin"), plus the configured wrapper route, whose name carries the
 * same token. It is one model reachable twice, not two models - so failing a text
 * turn over into the twin would answer it through the image pipeline, and the
 * "same model on another channel" preference (built to find the *same* model
 * elsewhere) would rank the twin first. That is the repeated same-model switching
 * this rule removes.
 *
 * The test is on the *provider*, and that is deliberate: a model id mentioning
 * vision ("llama-3.2-11b-vision-instruct") is still a chat model, and refusing it
 * on the strength of its name would exclude something the user may well want. The
 * whole exclusion is a default, too - the model list's own switch can bring a
 * twin back (see exclusionReason), so an unusual wrapper name costs a click
 * rather than a lost model.
 */
const VISION_TWIN_PATTERN = /(^|[-_./])vision([-_.]|$)/i

/** True when this provider is a vision twin rather than a chat route. */
function isVisionTwin(provider) {
  return VISION_TWIN_PATTERN.test(String(provider ?? ''))
}

/** Compile the deny list once; a bad user-supplied pattern is skipped, not fatal. */
function compileNonChat(cfg) {
  const out = []
  for (const source of [...NON_CHAT_PATTERNS, ...cfg.excludePatterns]) {
    try { out.push(new RegExp(source, 'i')) } catch { /* an invalid pattern is the user's typo, not a crash */ }
  }
  return out
}

/** True when this model id names a family that cannot answer a chat turn. */
function looksNonChat(id, patterns, provider) {
  const haystack = provider + '/' + id
  return patterns.some(pattern => pattern.test(haystack))
}

/**
 * Test seam: does this model id look like a non-chat family?
 *
 * Exported so the offline suite asserts against the *shipped* pattern table
 * rather than a copy of it. A test that re-types the patterns proves nothing
 * about the code that actually runs.
 */
export function isNonChatModelId(provider, id) {
  return looksNonChat(String(id ?? ''), compileNonChat(normalizeConfig(null)), String(provider ?? ''))
}

/** Hard ceiling on candidates considered per turn, regardless of config. */
const HARD_MAX_CANDIDATES = 8

/**
 * Hard ceiling on same-model retries per candidate, regardless of config.
 *
 * A retry of the model that just failed costs the provider another dispatch, so
 * the knob is capped: past a handful of tries the failure is not a blip.
 */
const HARD_MAX_RETRIES = 5

/**
 * The plugin's settings schema.
 *
 * Only fields marked .volatile() reach the generated settings page; the host's
 * volatileForm() keeps exactly those and drops every other key. This page is
 * deliberately the personalisation subset, not the whole config:
 *
 *   on the page  enabled, allowImageFailover, maxCandidates, cooldownBaseMs,
 *                maxCooldownMs, confirmSwitch, confirmTimeoutMs,
 *                adoptSwitchedModel, retriesPerModel, retryBackoffMs,
 *                preferSameModel, weights.connectivity, weights.speed
 *   file only    excludeProviders, excludeModels, excludePatterns, pinned
 *
 * The exclusion lists and the pin stay in model-rotator/config.json on purpose:
 * they are long, they are edited by tool or by hand, and the select/benchmark
 * tools already own them.
 *
 * Two schemastery rules shape the nesting. volatile fields cannot sit inside a
 * volatile parent, so the page group is a plain object whose leaves are
 * volatile - the host treats the nearest marked ancestor as the field, which
 * makes weights.connectivity and weights.speed two separate rows. And an
 * unmarked leaf inside that group would be dropped by volatileForm(), which is
 * why every leaf carries its own mark.
 */
export const Config = z === undefined ? undefined : z.object({
  enabled: z.boolean().default(SETTINGS_DEFAULTS.enabled).volatile()
    .description('Rank candidates and switch models when the current one fails before producing any output.'),
  allowImageFailover: z.boolean().default(SETTINGS_DEFAULTS.allowImageFailover).volatile()
    .description('Also fail over on turns that carry an image. Off by default: a fallback model may not accept images.'),
  maxCandidates: z.number().step(1).min(1).max(HARD_MAX_CANDIDATES).default(SETTINGS_DEFAULTS.maxCandidates).volatile()
    .description('How many models one turn may try, the current model included.'),
  cooldownBaseMs: z.number().min(0).max(6 * 60 * 60 * 1000).default(SETTINGS_DEFAULTS.cooldownBaseMs).volatile()
    .description('Base cooldown after a failure, in milliseconds. It doubles per consecutive failure.'),
  maxCooldownMs: z.number().min(0).max(6 * 60 * 60 * 1000).default(SETTINGS_DEFAULTS.maxCooldownMs).volatile()
    .description('Ceiling for the exponential cooldown, in milliseconds. A quota-exhausted model still rests until the daily boundary.'),
  quotaCooldownMs: z.number().min(0).max(26 * 60 * 60 * 1000).default(SETTINGS_DEFAULTS.quotaCooldownMs).volatile()
    .description('Rest time for a model whose quota or balance is exhausted, in milliseconds, counted from the moment of failure. Capped so the model returns before the next daily boundary of the failure itself.'),
  quotaCooldownHour: z.number().step(1).min(0).max(23).default(SETTINGS_DEFAULTS.quotaCooldownHour).volatile()
    .description('Local hour (0-23) at which a quota-exhausted model becomes usable again. The rest always reaches this hour of the following day at the earliest.'),
  statsPersistTtlMs: z.number().min(0).max(30 * 24 * 60 * 60 * 1000).default(SETTINGS_DEFAULTS.statsPersistTtlMs).volatile()
    .description('How long measured statistics and cooldowns survive across restarts, in milliseconds. 0 disables persistence.'),
  confirmSwitch: z.boolean().default(SETTINGS_DEFAULTS.confirmSwitch).volatile()
    .description('Ask before switching to another model. The switch proceeds on confirm and on timeout; declining keeps the current model.'),
  confirmTimeoutMs: z.number().step(1000).min(1000).max(10 * 60 * 1000).default(SETTINGS_DEFAULTS.confirmTimeoutMs).volatile()
    .description('How long the switch question waits for an answer, in milliseconds, before switching anyway.'),
  adoptSwitchedModel: z.boolean().default(SETTINGS_DEFAULTS.adoptSwitchedModel).volatile()
    .description('Make the model that answered this session\'s model after a switch, so the conversation shows what is really in use. Session only: no provider configuration and no saved default is touched.'),
  retriesPerModel: z.number().step(1).min(0).max(HARD_MAX_RETRIES).default(SETTINGS_DEFAULTS.retriesPerModel).volatile()
    .description('How many extra tries the same model gets before its failure is believed. A retry is not a switch, so it needs no confirmation.'),
  retryBackoffMs: z.number().min(0).max(60000).default(SETTINGS_DEFAULTS.retryBackoffMs).volatile()
    .description('Pause before each retry of the same model, in milliseconds. The nth retry waits n times this.'),
  preferSameModel: z.boolean().default(SETTINGS_DEFAULTS.preferSameModel).volatile()
    .description('Rank the same model on another provider - or a close relative - ahead of unrelated models.'),
  noticeSwitch: z.boolean().default(SETTINGS_DEFAULTS.noticeSwitch).volatile()
    .description('Post one line in the conversation when a turn is answered by a different model than the one asked for (a notice, not a message).'),
  weights: z.object({
    connectivity: z.number().min(0).default(SETTINGS_DEFAULTS.weights.connectivity).volatile()
      .description('Ranking weight for the measured success rate.'),
    speed: z.number().min(0).default(SETTINGS_DEFAULTS.weights.speed).volatile()
      .description('Ranking weight for measured TTFT and throughput.'),
  }),
})

/**
 * True when this chunk carries reply content that must not be duplicated.
 *
 * "Flow" decides whether a later error may still be retried, so the test has to
 * mean *the user has been shown something*. A reasoning delta does not: the
 * harness folds it away again on a retry, which is exactly what makes retrying a
 * reasoning-loop or reasoning-effort failure safe. Counting markup chunks as
 * content instead is what made a live model look dead: a block-start arrived,
 * "flowed" turned true, and the very next error was accepted as terminal instead
 * of being retried.
 */
function isContentChunk(chunk) {
  const type = String(chunk?.type ?? '')
  if (type === 'text-delta') return String(chunk?.text ?? '') !== ''
  if (type === 'tool-call-delta') return String(chunk?.argumentsDelta ?? '') !== ''
  if (type === 'block-end') {
    const blockType = String(chunk?.block?.type ?? '')
    return blockType === 'text' || blockType === 'tool-call'
  }
  return false
}

/** Per-candidate measured state. In memory on purpose: a restart costs priors only. */
function emptyStat() {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    empty: 0,
    ttftMs: [],
    totalMs: [],
    tokens: 0,
    lastError: '',
    lastErrorKind: '',
    consecutiveFailures: 0,
    cooldownUntil: 0,
    // Set only when a restored row was healed rather than measured: it makes the
    // next write replace that row instead of omitting it (see saveStats).
    purging: false,
  }
}

function readJsonSafe(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clampMs(value, fallback) {
  return Math.min(Math.max(numberOr(value, fallback), 0), 6 * 60 * 60 * 1000)
}

/** Pause between two tries of the same model. */
function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Defaults; every field is overridable through model-rotator/config.json. */
function defaultConfig() {
  return {
    ...SETTINGS_DEFAULTS,
    weights: { ...SETTINGS_DEFAULTS.weights },
    excludeProviders: [],
    excludeModels: [],
    excludePatterns: [],
    disabledModels: [],
    enabledModels: [],
    disabledProviders: [],
    pinned: '',
  }
}

function normalizeConfig(raw) {
  const base = defaultConfig()
  if (raw === null || typeof raw !== 'object') return base
  const weights = raw.weights !== null && typeof raw.weights === 'object' ? raw.weights : {}
  return {
    enabled: raw.enabled !== false,
    allowImageFailover: raw.allowImageFailover === true,
    maxCandidates: Math.min(Math.max(Math.trunc(numberOr(raw.maxCandidates, base.maxCandidates)), 1), HARD_MAX_CANDIDATES),
    cooldownBaseMs: clampMs(raw.cooldownBaseMs, base.cooldownBaseMs),
    maxCooldownMs: clampMs(raw.maxCooldownMs, base.maxCooldownMs),
    quotaCooldownMs: Math.min(Math.max(numberOr(raw.quotaCooldownMs, base.quotaCooldownMs), 0), 26 * 60 * 60 * 1000),
    quotaCooldownHour: Math.min(Math.max(Math.trunc(numberOr(raw.quotaCooldownHour, base.quotaCooldownHour)), 0), 23),
    statsPersistTtlMs: Math.min(
      Math.max(numberOr(raw.statsPersistTtlMs, base.statsPersistTtlMs), 0),
      30 * 24 * 60 * 60 * 1000,
    ),
    confirmSwitch: raw.confirmSwitch !== false,
    confirmTimeoutMs: Math.min(
      Math.max(numberOr(raw.confirmTimeoutMs, base.confirmTimeoutMs), 1000),
      10 * 60 * 1000,
    ),
    adoptSwitchedModel: raw.adoptSwitchedModel !== false,
    retriesPerModel: Math.min(
      Math.max(Math.trunc(numberOr(raw.retriesPerModel, base.retriesPerModel)), 0),
      HARD_MAX_RETRIES,
    ),
    retryBackoffMs: Math.min(Math.max(numberOr(raw.retryBackoffMs, base.retryBackoffMs), 0), 60000),
    preferSameModel: raw.preferSameModel !== false,
    noticeSwitch: raw.noticeSwitch !== false,
    weights: {
      connectivity: Math.max(numberOr(weights.connectivity, base.weights.connectivity), 0),
      speed: Math.max(numberOr(weights.speed, base.weights.speed), 0),
    },
    excludeProviders: Array.isArray(raw.excludeProviders) ? raw.excludeProviders.map(String) : [],
    excludeModels: Array.isArray(raw.excludeModels) ? raw.excludeModels.map(String) : [],
    excludePatterns: Array.isArray(raw.excludePatterns) ? raw.excludePatterns.map(String) : [],
    disabledModels: Array.isArray(raw.disabledModels) ? raw.disabledModels.map(String) : [],
    enabledModels: Array.isArray(raw.enabledModels) ? raw.enabledModels.map(String) : [],
    disabledProviders: Array.isArray(raw.disabledProviders) ? raw.disabledProviders.map(String) : [],
    pinned: typeof raw.pinned === 'string' ? raw.pinned : '',
  }
}

/** Laplace-smoothed success rate: an untried candidate scores 0.5, not 0 or 1. */
function connectivity(stat) {
  return (stat.successes + 1) / (stat.attempts + 2)
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Speed score in 0..1 against fixed reference points: 800 ms TTFT is fast and
 * 8000 ms is slow; 40 tok/s is fast and 4 tok/s is slow. A never-probed
 * candidate sits at 0.5 so an unknown model is not penalised into never being
 * tried.
 */
function speedScore(stat) {
  const ttft = median(stat.ttftMs)
  const total = median(stat.totalMs)
  if (ttft === null || total === null || total <= 0) return 0.5
  const ttftPart = 1 - Math.min(Math.max((ttft - 800) / (8000 - 800), 0), 1)
  const throughput = stat.tokens > 0 ? (stat.tokens * 1000) / total : 0
  const tputPart = throughput > 0 ? Math.min(Math.max((throughput - 4) / (40 - 4), 0), 1) : 0.5
  return 0.5 * ttftPart + 0.5 * tputPart
}

/**
 * Normalised model identity.
 *
 * Catalog ids arrive as 'deepseek-v4.1-flash', 'deepseek-ai/DeepSeek-V4-Flash'
 * or 'zai-org/GLM-5.3'. Lower-casing and collapsing every run of separators to a
 * single dash makes them comparable without a per-vendor table.
 */
function modelKey(id) {
  return String(id ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * How much two model ids look like the same model, in 0..1.
 *
 * A user whose current model fails usually wants *that* model from another
 * channel, not an unrelated one that merely measured better. Three tiers say it
 * plainly: the identical id (1), a shared multi-token family stem such as
 * 'deepseek-v4-1' in deepseek-v4.1-flash vs deepseek-v4.1-pro (0.8), and a
 * shared first token such as 'glm' (0.5). Anything else is 0.
 */
function modelSimilarity(a, b) {
  const ka = modelKey(a)
  const kb = modelKey(b)
  if (ka === '' || kb === '') return 0
  if (ka === kb) return 1
  const ta = ka.split('-')
  const tb = kb.split('-')
  let lead = 0
  while (lead < ta.length && lead < tb.length && ta[lead] === tb[lead]) lead += 1
  if (lead === 0) return 0
  return lead >= 2 ? 0.8 : 0.5
}

/** Ranking bonus for a candidate that is the current model, or a close relative. */
function sameModelBoost(currentModel, candidateModel, cfg) {
  if (cfg.preferSameModel !== true) return 0
  const alike = modelSimilarity(currentModel, candidateModel)
  if (alike >= 1) return 1
  if (alike >= 0.8) return 0.6
  if (alike >= 0.5) return 0.3
  return 0
}

/**
 * Score a candidate. A cooldown dominates: a cooling candidate must not be
 * preferred over a healthy peer, but it is never removed from the list - if
 * everything is cooling down the least-bad one still runs rather than the turn
 * failing with no attempt at all.
 */
function scoreCandidate(stat, cfg, nowMs) {
  if (stat.cooldownUntil > nowMs) return -1
  const weights = cfg.weights
  const total = weights.connectivity + weights.speed
  if (total <= 0) return connectivity(stat)
  return (connectivity(stat) * weights.connectivity + speedScore(stat) * weights.speed) / total
}

/** Exponential backoff per candidate, capped, cleared by any success. */
function cooldownFor(stat, cfg) {
  const n = Math.max(stat.consecutiveFailures, 1)
  return Math.min(cfg.cooldownBaseMs * 2 ** (n - 1), cfg.maxCooldownMs)
}

/**
 * Why a candidate failed, as a small closed vocabulary.
 *
 * A provider's refusal arrives as prose, and prose is not something a cooldown
 * policy can branch on: "insufficient quota" and "rate limit reached" are both
 * a 429 to a naive reader, yet one clears in seconds and the other not until
 * the daily allowance resets. Naming the kind is therefore the whole point -
 * it is what lets the quota case rest until tomorrow while a blip keeps the
 * ordinary exponential backoff.
 *
 * Order matters and is deliberate. A quota wall is frequently reported as a 429
 * with a billing sentence attached, so the quota test runs before everything
 * else. A named key or permission problem then outranks the bare 429: both
 * take the ordinary backoff - only quota changes the policy - so the order
 * decides which name is *recorded*, and "invalid api key" is the more truthful
 * name for a 429 that says so.
 */
const FAILURE_KIND_TESTS = [
  ['quota', /(?:insufficient|exhausted|exceeded|depleted|empty|out[ _-]*of|low|no)(?:[ _-]+\w+){0,3}[ _-]+(?:user[ _-]+)?(?:quota|balance|credits?|funds|billing|arrears|allowance)|(?:quota|balance|credits?|allowance|billing)[ _-]+(?:exhausted|exceeded|depleted|insufficient|empty)|out[ _-]*of[ _-]*(?:credit|quota|tokens?)|free[ _-]*tier|recharge|top[ _-]?up|余额[^。，,;；]{0,4}(?:不足|不够|为零)|额度[^。，,;；]{0,6}(?:用尽|耗尽|不足|已满|超限|用完|已尽)|配额[^。，,;；]{0,6}(?:不足|用尽|耗尽|已满)|欠费|请充值|充值(?:后|再)|402[ _-]*payment[ _-]*required|\b402\b/i],
  // A request-shape refusal ("this model does not support reasoning effort on") is
  // decided before the model is ever asked, so the retry dispatches would repeat
  // it verbatim. It is named so the walk skips them - and so the record says
  // "unsupported" rather than leaving the row unclassified. Tested after quota on
  // purpose: a plan that "does not support" a model is a billing wall, and losing
  // that classification would cost the daily rest a dead balance needs.
  ['unsupported', /(does not support|doesn't support|unsupported|not supported|no such model|unknown model|model not found|invalid model|model is not available)/i],
  ['auth', /(invalid[ _-]*api[ _-]*key|api[ _-]*key[ _-]*(invalid|missing|expired)|unauthori[sz]ed|unauthenticated|authentication|credential|permission denied|forbidden|401|403|鉴权|密钥|授权失败|认证失败)/i],
  ['rate-limit', /(rate[ _-]*limit|too many requests|request[ _-]*limit|throttl|429|限流|请求过于频繁|过于频繁|qps)/i],
  ['server', /(internal[ _-]*server[ _-]*error|bad[ _-]*gateway|service[ _-]*unavailable|server[ _-]*(error|overload)|overloaded|gateway[ _-]*timeout|50[0-9])/i],
  ['network', /(econnreset|econnrefused|etimedout|enotfound|eai_again|socket|network|fetch failed|timed?[ _-]?out|timeout|disconnected|connection (closed|reset|refused)|aborted)/i],
]

/**
 * Name the failure. '' when nothing recognisable is in the text, which keeps the
 * default policy (exponential backoff) rather than guessing a category.
 */
export function classifyFailureKind(message) {
  const text = String(message ?? '')
  if (text === '') return ''
  for (const [kind, pattern] of FAILURE_KIND_TESTS) {
    if (pattern.test(text)) return kind
  }
  return ''
}

/**
 * A refusal that names this host rather than this model.
 *
 * Two families. A JSON envelope written by the harness or by another plugin -
 * `"code":"dsh_*` - is a statement about this *host*: the call was refused around
 * the provider boundary, so the model never got a chance to answer and its
 * health says nothing about the route. And an error raised inside this plugin
 * ("model-rotator: ...", or cordis refusing an injected service for an inactive
 * fibre) never left the machine at all.
 *
 * Kept separate from classifyFailureKind on purpose: the kind is still recorded
 * (the page shows it, and the cooldown policy reads it), but a host refusal must
 * not be *counted* against the route. Counting it cools a healthy model down and
 * pushes the ranking away from a route that did nothing wrong.
 */
export function isHostRefusal(message) {
  const text = String(message ?? '')
  if (text === '') return false
  if (text.includes('model-rotator:')) return true
  if (/cannot get required service .+ in inactive context/.test(text)) return true
  return /"code"\s*:\s*"dsh_/.test(text)
}

/**
 * When a quota-exhausted model may be tried again.
 *
 * A provider that says "insufficient balance" is not going to change its mind
 * in thirty minutes, so the ordinary backoff is the wrong shape here: the
 * useful horizon is the next day. The rest therefore reaches the *following*
 * calendar day at cfg.quotaCooldownHour (00:00 by default), with
 * cfg.quotaCooldownMs as a floor - an exhaustion at 23:50 should still cost a
 * real rest rather than the ten minutes left before midnight.
 *
 * Exported as a test seam: the daily boundary is time-of-day arithmetic, and
 * arithmetic that only manifest at midnight is exactly what an offline suite
 * should pin down.
 */
export function quotaRestUntil(nowMs, cfg) {
  const at = new Date(nowMs)
  const hour = Math.min(Math.max(Math.trunc(numberOr(cfg?.quotaCooldownHour, 0)), 0), 23)
  const floor = Math.max(numberOr(cfg?.quotaCooldownMs, 0), 0)
  // Strictly the next calendar day: repairing a same-day boundary would let a
  // failure at 00:05 come back at 00:00 the same evening.
  const boundary = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, hour, 0, 0, 0)
  return Math.max(boundary.getTime(), nowMs + floor)
}

/** Instant until which this failure keeps the candidate out of the ranking. */
function cooldownUntilFor(stat, cfg, nowMs, errorKind) {
  if (errorKind === 'quota') return quotaRestUntil(nowMs, cfg)
  return nowMs + cooldownFor(stat, cfg)
}

function hasImagePart(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part === null || typeof part !== 'object') continue
      const type = String(part.type ?? '')
      if (type === 'image' || type === 'image_url' || type === 'input_image') return true
      if (part.image !== undefined || part.imageUrl !== undefined) return true
    }
  }
  return false
}

/**
 * Readable text out of a failure payload.
 *
 * `failure.message` is a string by contract, but a provider adapter that throws
 * its own object puts one there anyway - and String(obj) is "[object Object]",
 * which is both unreadable in the record and unclassifiable, so a quota wall
 * would lose its daily rest to a typing accident one layer down. Anything that is
 * not a string is serialised instead.
 */
function failureText(value, fallback) {
  if (typeof value === 'string' && value !== '') return value
  if (value === undefined || value === null) return fallback
  // An Error's own toString carries its name and message; JSON.stringify would
  // return "{}" for it and lose everything, so keep the string form first.
  if (value instanceof Error) return String(value)
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      return json === undefined || json === '{}' ? fallback : json
    } catch { return fallback }
  }
  return String(value)
}

/** Longest summary a \`notice\`-form message may carry, per the harness contract. */
const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * The in-conversation notice for one switch, in the harness's own shape.
 *
 * A switch is otherwise invisible: the reply just arrives from a different
 * model. This is the same mechanism the host uses for its own "model changed"
 * line - a user-role message whose source is
 * \`{ kind: '…', form: 'notice' }\` - because that form is what the conversation
 * UI renders as a context row rather than as something the user typed, and
 * \`user/message\` is a *known* event type, so a log carrying it still loads and
 * replays. Inventing a private event type would not: the persistence reader
 * refuses to interpret a log containing a type it does not know.
 *
 * Kept short on purpose. The row is a caption, not a message: the reader wants
 * "A → B", not a paragraph.
 */
function switchNoticeMessage(from, to, reason) {
  // The channel name is the vendor's own display name when the host publishes one
  // ("硅基流动" for siliconflow), falling back to the route id. The id is what the
  // plugin ranks by; the display name is what the user recognises.
  const fromChannel = from.displayName === undefined || from.displayName === '' ? from.provider : from.displayName
  const toChannel = to.displayName === undefined || to.displayName === '' ? to.provider : to.displayName
  const sameChannel = from.provider === to.provider
  const fromLabel = sameChannel ? from.model : fromChannel + '/' + from.model
  const toLabel = sameChannel ? to.model : toChannel + '/' + to.model
  const why = reason === '' ? '' : '  (' + reason + ')'
  const text = '模型已切换：' + fromLabel + ' → ' + toLabel + why
  const summary = (fromLabel + ' → ' + toLabel).slice(0, CONTEXT_SUMMARY_MAX_CHARS)
  // A user-role message with a fresh id, exactly the shape the harness builds for
  // its own notice: an identified message is what the session surface accepts.
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: text }],
    source: { kind: 'model-rotator/switch', form: 'notice', summary: summary },
  }
}

/**
 * Test seam: build the notice exactly as the running plugin does.
 *
 * Exported so the offline suite asserts against the shipped shape - the same
 * reason isNonChatModelId and quotaRestUntil are exported. A test that retypes
 * the message proves nothing about the message that is actually steered.
 */
export function switchNoticeFor(from, to, reason) {
  return switchNoticeMessage(from, to, reason)
}

/** Fixed-width text table so tool output stays readable in the transcript. */
function formatTable(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(row => String(row[i] ?? '').length)))
  const line = cells => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')
  const out = [line(headers), widths.map(w => '-'.repeat(w)).join('  ')]
  for (const row of rows) out.push(line(row))
  return out.join('\n')
}

/**
 * @param {object} ctx - cordis context with the tools and llm services injected.
 */
export function apply(ctx, config = {}, runtime = {}) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const configPath = process.env.DSH_MODEL_ROTATOR_CONFIG || join(dshHome, 'model-rotator', 'config.json')

  /** Measured state, keyed by "provider/model". */
  const stats = new Map()
  /** Options objects we built for a retry; matching one means "do not wrap me again". */
  const retryMarkers = new WeakSet()
  /** Preferred head, mirroring config.pinned. */
  let pinned = ''

  const logger = ctx.logger ?? ctx.get?.('logger') ?? undefined
  const warn = message => {
    try { logger?.warn?.('[model-rotator] ' + String(message)) } catch { /* logging must never throw */ }
  }

  const statFor = key => {
    hydrateStats()
    let stat = stats.get(key)
    if (stat === undefined) {
      stat = emptyStat()
      stats.set(key, stat)
    }
    return stat
  }

  // ---- automatic calls ---------------------------------------------------------

  /**
   * Purposes that are not the conversation.
   *
   * A compaction summary and a session title ride the same llm/stream seam as a
   * user turn but are *not* a user turn: nothing about them is answered to a
   * human, and failing one over asks a second provider to do plumbing work the
   * first provider refused. That refusal is also frequently a policy answer -
   * "this lane owns compression" - which another model would happily ignore.
   * The names come from the host itself (dsh-compaction-basic passes
   * purpose: "compaction", dsh-session-title-llm passes "session-title"), and an
   * unnamed call stays in scope, so the ordinary turns - which carry no purpose
   * at all - keep failing over exactly as before.
   */
  const AUTOMATIC_PURPOSES = new Set(['compaction', 'session-title'])

  // ---- configuration ----------------------------------------------------------

  /**
   * Read a field the settings page owns.
   *
   * The host hands every .volatile() field to apply() as a live handle rather
   * than a plain value, and the page writes into that handle. The protocol is
   * cosmokit's: a frozen object with get() plus a well-known write symbol. The
   * symbol is looked up rather than imported so this plugin needs no second
   * anchor load, and Object.isFrozen() covers a future rename of that key.
   */
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
  function isVolatileHandle(value) {
    return value !== null
      && typeof value === 'object'
      && typeof value.get === 'function'
      && (VOLATILE_WRITE in value || Object.isFrozen(value))
  }

  /** Current value of a page field, or undefined when the page does not own it. */
  function readSetting(value, fallback) {
    if (isVolatileHandle(value)) {
      try {
        const live = value.get()
        return live === undefined ? fallback : live
      } catch {
        return fallback
      }
    }
    return value === undefined ? fallback : value
  }

  /**
   * Snapshot of the page layer.
   *
   * undefined means "the page does not own this field", which is what lets the
   * file layer and then the defaults show through. That distinction matters:
   * a false or a 0 from the page must win, so the check is against undefined
   * and never against falsiness.
   */
  function pageValues() {
    const source = config !== null && typeof config === 'object' ? config : {}
    const weights = readSetting(source.weights, undefined)
    const nested = weights !== null && typeof weights === 'object' ? weights : {}
    return {
      enabled: readSetting(source.enabled, undefined),
      allowImageFailover: readSetting(source.allowImageFailover, undefined),
      maxCandidates: readSetting(source.maxCandidates, undefined),
      cooldownBaseMs: readSetting(source.cooldownBaseMs, undefined),
      maxCooldownMs: readSetting(source.maxCooldownMs, undefined),
      quotaCooldownMs: readSetting(source.quotaCooldownMs, undefined),
      quotaCooldownHour: readSetting(source.quotaCooldownHour, undefined),
      statsPersistTtlMs: readSetting(source.statsPersistTtlMs, undefined),
      confirmSwitch: readSetting(source.confirmSwitch, undefined),
      confirmTimeoutMs: readSetting(source.confirmTimeoutMs, undefined),
      adoptSwitchedModel: readSetting(source.adoptSwitchedModel, undefined),
      retriesPerModel: readSetting(source.retriesPerModel, undefined),
      retryBackoffMs: readSetting(source.retryBackoffMs, undefined),
      preferSameModel: readSetting(source.preferSameModel, undefined),
      noticeSwitch: readSetting(source.noticeSwitch, undefined),
      weights: {
        connectivity: readSetting(nested.connectivity, undefined),
        speed: readSetting(nested.speed, undefined),
      },
    }
  }

  let cached = null
  /** Raw text of the file last read; null when a file was there and is now gone. */
  let cachedFileText = null
  /** The file layer as last read; null when there is no usable file. */
  let cachedFile = null
  let cachedPage = null
  let cachedPageKey = ''

  /**
   * Re-read the file when it changes, so an edit takes effect without a restart.
   *
   * The comparison is on the file's *text*, not its mtime. mtime was the cheaper
   * test, but it is not trustworthy at this granularity: two writes inside the
   * same filesystem timestamp tick (which is exactly what a switch followed by a
   * hand edit looks like) produce an identical mtime, the cache concludes nothing
   * changed, and the edit is invisible until something else moves the clock. The
   * config file is a few kilobytes, so reading it costs nothing next to silently
   * ignoring a change - and re-parsing only happens when the text really differs,
   * which is what protects the discovery cache.
   */
  function readFileLayer() {
    let text = null
    try {
      text = readFileSync(configPath, 'utf8')
    } catch {
      // No readable file. Only reset when a file used to be there, so the
      // missing-file case does not recompose the config on every single turn
      // (which would also throw away the discovery cache).
      if (cachedFileText !== null) {
        cachedFile = null
        cachedFileText = null
        cached = null
      }
      return cachedFile
    }
    if (text !== cachedFileText) {
      cachedFileText = text
      cachedFile = readJsonSafe(configPath)
      cached = null
    }
    return cachedFile
  }

  /** Re-read the page when any exposed field changed. */
  function readPageLayer() {
    const page = pageValues()
    const key = JSON.stringify(page)
    if (cachedPage === null || key !== cachedPageKey) {
      cachedPage = page
      cachedPageKey = key
      cached = null
    }
    return cachedPage
  }

  /**
   * Compose the effective config: defaults < config.json < settings page.
   *
   * The page wins because it is the surface the user is looking at, and the
   * host only carries a key there once it has actually been set (an untouched
   * page field stays undefined and lets the file through).
   */
  function currentConfig() {
    readFileLayer()
    const page = readPageLayer()
    if (cached === null) {
      const merged = { ...(cachedFile ?? {}) }
      for (const key of PAGE_KEYS) {
        if (page[key] !== undefined) merged[key] = page[key]
      }

      if (page.weights.connectivity !== undefined || page.weights.speed !== undefined) {
        const fromFile = cachedFile?.weights !== null && typeof cachedFile?.weights === 'object' ? cachedFile.weights : {}
        merged.weights = { ...fromFile }
        if (page.weights.connectivity !== undefined) merged.weights.connectivity = page.weights.connectivity
        if (page.weights.speed !== undefined) merged.weights.speed = page.weights.speed
      }
      cached = normalizeConfig(merged)
      pinned = cached.pinned
      // Config changed: the deny list and the roster it filters must not stay
      // stale. Done here (not via invalidatePairs) so this function never
      // re-enters itself.
      patternCache = compileNonChat(cached)
      pairCache = { at: 0, pairs: [] }
    }
    return cached
  }

  /**
   * Page-owned keys that config.json sets *and* the page overrides.
   *
   * Only a genuine collision is worth reporting. A key the file sets while the
   * page leaves untouched is simply the value in force, so calling it shadowed
   * would be wrong - the page does not win a field it never sets.
   */
  function pageKeysInFile() {
    const file = cachedFile
    if (file === null || typeof file !== 'object') return []
    const page = readPageLayer()
    const keys = PAGE_KEYS.filter(key => file[key] !== undefined && page[key] !== undefined)
    if (file.weights !== null && typeof file.weights === 'object') {
      for (const key of ['connectivity', 'speed']) {
        if (file.weights[key] !== undefined && page.weights[key] !== undefined) keys.push('weights.' + key)
      }
    }
    return keys
  }

  /**
   * Which layer supplies one dotted key of the effective config.
   *
   * The status tool reports the merged value, and the layer that won is the
   * part a user cannot see from any single file: a value on the settings page
   * outranks config.json, which outranks the defaults. Returning the layer name
   * (not a precedence number) keeps the report readable.
   */
  function sourceOf(dotted) {
    const read = (source, path) => {
      let current = source
      for (const part of path.split('.')) {
        if (current === null || typeof current !== 'object') return undefined
        current = current[part]
      }
      return current
    }
    if (read(readPageLayer(), dotted) !== undefined) return 'settings page'
    if (cachedFile !== null && read(cachedFile, dotted) !== undefined) return 'config.json'
    return 'default'
  }

  /**
   * Write the file layer.
   *
   * Page-owned keys are stripped from the patch and never written, because a
   * value parked in config.json would silently outrank nothing (the page still
   * wins) while looking authoritative in the file.
   */
  function persistConfig(patch) {
    readFileLayer()
    const merged = { ...(cachedFile ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      if (!PAGE_KEYS.includes(key)) merged[key] = value
    }
    try {
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8')
      cachedFile = merged
      cached = null
      // Keep the text fingerprint in step with what was just written, so the next
      // read does not treat our own write as a change.
      try { cachedFileText = readFileSync(configPath, 'utf8') } catch { cachedFileText = null }
      return true
    } catch (error) {
      warn('could not persist ' + configPath + ': ' + String(error))
      return false
    }
  }

  // ---- measured-state persistence ----------------------------------------------

  /**
   * Statistics outlive the process on purpose.
   *
   * A quota wall is the one failure with a horizon measured in hours, so an
   * in-memory-only cooldown would be undone by the restart a user performs
   * precisely after being told their balance is gone. The interesting fields are
   * therefore the policy inputs - counters, the last error and its kind, and the
   * cooldown horizon - while the latency samples stay in memory: they are a
   * 20-sample sliding window, and a stale window is worse than a short one.
   *
   * Best effort in both directions. A missing, unreadable or malformed file
   * simply means the process starts with priors, and a failed write is a warning
   * rather than a broken turn.
   */
  const statsPath = process.env.DSH_MODEL_ROTOR_STATS || join(dirname(configPath), 'stats.json')
  const STATS_SAVE_DEBOUNCE_MS = 1500
  let statsHydrated = false
  let statsSaveTimer = null

  /** The subset of a stat worth writing to disk. */
  function persistedRow(stat, nowMs) {
    return {
      savedAt: nowMs,
      attempts: stat.attempts,
      successes: stat.successes,
      failures: stat.failures,
      consecutiveFailures: stat.consecutiveFailures,
      cooldownUntil: stat.cooldownUntil,
      lastError: stat.lastError,
      lastErrorKind: stat.lastErrorKind,
    }
  }

  function scheduleStatsSave() {
    if (statsSaveTimer !== null) return
    statsSaveTimer = setTimeout(() => {
      statsSaveTimer = null
      try { saveStats(Date.now()) } catch (error) { warn('stats save failed: ' + String(error)) }
    }, STATS_SAVE_DEBOUNCE_MS)
    // A pending write must not hold the process open on shutdown.
    if (typeof statsSaveTimer.unref === 'function') statsSaveTimer.unref()
  }

  function saveStats(nowMs) {
    const ttl = numberOr(currentConfig().statsPersistTtlMs, SETTINGS_DEFAULTS.statsPersistTtlMs)
    if (ttl <= 0) return
    const rows = {}
    for (const [key, stat] of stats) {
      // A healed row carries no counters by design, but it still has to be written:
      // omitting it is what left the stale copy in the file for the next boot.
      if (stat.attempts === 0 && stat.cooldownUntil === 0 && stat.purging !== true) continue
      rows[key] = persistedRow(stat, nowMs)
    }
    mkdirSync(dirname(statsPath), { recursive: true })
    writeFileSync(statsPath, JSON.stringify({ version: 1, rows }, null, 2) + '\n', 'utf8')
  }

  /**
   * Restore the previous process's counters once, on first use rather than in
   * apply(): a turn that never ranks a candidate should not pay for a disk read,
   * and the file's own age has to be judged against the TTL the user set.
   */
  function hydrateStats() {
    if (statsHydrated) return
    statsHydrated = true
    const raw = readJsonSafe(statsPath)
    if (raw === null || typeof raw !== 'object') return
    const rows = raw.rows !== null && typeof raw.rows === 'object' ? raw.rows : {}
    const ttl = numberOr(currentConfig().statsPersistTtlMs, SETTINGS_DEFAULTS.statsPersistTtlMs)
    if (ttl <= 0) return
    const nowMs = Date.now()
    // Counts the rows this read had to heal. The file is only rewritten when a
    // model is next attempted, so without an explicit save here a healed row would
    // sit uncorrected on disk and the following boot would restore it.
    let healed = 0
    for (const [key, row] of Object.entries(rows)) {
      if (row === null || typeof row !== 'object') continue
      const savedAt = numberOr(row.savedAt, 0)
      if (savedAt <= 0 || nowMs - savedAt > ttl) continue
      const stat = emptyStat()
      stat.attempts = Math.max(Math.trunc(numberOr(row.attempts, 0)), 0)
      stat.successes = Math.max(Math.trunc(numberOr(row.successes, 0)), 0)
      stat.failures = Math.max(Math.trunc(numberOr(row.failures, 0)), 0)
      stat.consecutiveFailures = Math.max(Math.trunc(numberOr(row.consecutiveFailures, 0)), 0)
      stat.cooldownUntil = Math.max(numberOr(row.cooldownUntil, 0), 0)
      // Two kinds of prose are not measurements and must not survive a restart.
      //
      // "[object Object]" is unreadable - a legacy row written before failureText
      // existed.
      //
      // Anything isHostRefusal() names is a bug or a policy answer on this
      // machine, not a fact about the model: the dispatch never left the host, so
      // blaming the model would mark a perfectly healthy route as broken and keep
      // its failure counter climbing. Clearing it here lets the route be judged on
      // its next real dispatch instead of on our own crash.
      const unusable = typeof row.lastError !== 'string'
        || row.lastError === '[object Object]'
        || isHostRefusal(row.lastError)
      if (unusable) healed += 1
      stat.lastError = unusable ? '' : row.lastError
      // The failure *count* has to go with it. Health is 'error' whenever the
      // consecutive-failure counter is non-zero, so clearing only the prose would
      // leave a healthy route displayed as broken - which is exactly what the
      // stale rows looked like. The counters are rebuilt by real dispatches.
      if (unusable) {
        stat.attempts = 0
        stat.successes = 0
        stat.failures = 0
        stat.consecutiveFailures = 0
        stat.cooldownUntil = 0
        // Flagged so the next write replaces the stale entry on disk. Dropping it
        // from the payload instead would leave the old row in the file, and the
        // following boot would restore it and mark the route broken all over again.
        stat.purging = true
      }
      // The prose is the measurement; the kind is only a verdict about it, and a
      // verdict written by an older build can be wrong. Re-reading it here means
      // a pattern added later relabels the history it was written for, instead of
      // the user seeing "unclassified" until that model happens to fail again.
      //
      // A healed row keeps no verdict at all: the page decides "broken" from the
      // kind as much as from the counters, so a discarded prose that left its old
      // kind behind would still show a healthy route as failed.
      stat.lastErrorKind = stat.lastError === '' ? '' : classifyFailureKind(stat.lastError)
      stats.set(key, stat)
    }
    if (healed > 0) scheduleStatsSave()
  }

  // ---- candidate discovery and ranking ----------------------------------------

  /**
   * The llm service, captured the first time the plugin sees it and reused after.
   *
   * Every read of `ctx.llm` goes through here rather than through the live
   * property. Cordis refuses an injected service once its fibre deactivates
   * (`cannot get required service "llm" in inactive context`), and a turn can be
   * parked and resumed - an automatic continuation, a background turn - while
   * this plugin is midway through discovery or a failover walk. Reading the live
   * property there did not just fail: it turned a switch into a silent no-op that
   * still consumed a candidate.
   *
   * Captured lazily rather than once at apply time: a plugin loads before some
   * host services publish, so resolving only at apply time would pin `undefined`
   * forever on a slow boot. The first successful read sticks; after that the live
   * property is never consulted again.
   */
  let llmService
  function llmRef() {
    if (llmService !== undefined) return llmService
    // Only while nothing has been captured yet, and only inside a synchronous
    // frame (never after an await), so the read cannot land in a dead fibre.
    const live = typeof ctx.llm?.stream === 'function' || typeof ctx.llm?.listProviders === 'function' ? ctx.llm : undefined
    if (live !== undefined) llmService = live
    return llmService
  }
  // Resolve as early as this module's own scope is active.
  llmRef()

  /**
   * Enumerate live "provider/model" ids. A provider qualifies only when the llm
   * service exposes a registration with a listModels-capable adapter - the same
   * admission the harness itself uses to decide a route is dialable.
   */
  async function discoverPairsRaw() {
    const out = []
    const llm = llmRef()
    if (typeof llm?.listProviders !== 'function') return out
    let providers = []
    try { providers = llm.listProviders() } catch { return out }
    for (const entry of Array.isArray(providers) ? providers : []) {
      const provider = entry !== null && typeof entry === 'object' && typeof entry.id === 'string' ? entry.id : ''
      if (provider === '') continue
      // The vendor's own label, when the adapter published one. Kept beside the id
      // (never instead of it): the id is the routing key, the label is for people.
      // The registered route carries the vendor's own label in `name` (the host
      // builds it from the provider profile: "硅基流动" for siliconflow)
      // `displayName` is the configurable-directory spelling and is absent from a
      // live registration, so reading it alone labelled every channel with its raw
      // route id. The id is kept when the two are equal, so the page's own
      // "name (id)" fallback stays meaningful.
      const label = typeof entry.name === 'string' && entry.name !== ''
        ? entry.name
        : (typeof entry.displayName === 'string' ? entry.displayName : '')
      const displayName = label === provider ? '' : label
      let adapter
      try { adapter = llm.registration?.(provider)?.adapter } catch { adapter = undefined }
      if (adapter === undefined || typeof adapter.listModels !== 'function') continue
      let listed = []
      try { listed = await adapter.listModels(provider) } catch { continue }
      for (const model of Array.isArray(listed) ? listed : []) {
        if (model === null || typeof model !== 'object' || typeof model.id !== 'string' || model.id === '') continue
        if (looksNonChat(model.id, patternCache, provider)) continue
        out.push({ provider, model: model.id, displayName, inputModalities: model.inputModalities })
      }
    }
    return out
  }

  /**
   * Cache the discovery result.
   *
   * listModels() is a live call into every provider: on a machine carrying a few
   * hundred catalog rows that is real latency, and it would otherwise run on
   * *every* turn including the ones that never need a fallback. The roster also
   * changes only when a provider re-publishes, so a short TTL is the right
   * trade: a turn that fails mid-roster-change simply falls back to the harness
   * path unrotated (see rotateStream's catch).
   */
  let pairCache = { at: 0, pairs: [] }
  const PAIR_TTL_MS = 60_000
  let patternCache = compileNonChat(normalizeConfig(null))

  async function discoverPairs() {
    const now = Date.now()
    if (pairCache.pairs.length > 0 && now - pairCache.at < PAIR_TTL_MS) return pairCache.pairs
    const pairs = await discoverPairsRaw()
    pairCache = { at: now, pairs }
    return pairs
  }

  /**
   * The vendor label for one provider id, from the last discovery scan.
   *
   * Cached beside the pair cache rather than resolved on demand: a notice is built
   * on a hot path and must not trigger another listProviders() sweep. An unknown
   * route (a combo, an unregistered id) falls back to the id itself.
   */
  function displayNameOf(provider) {
    for (const pair of pairCache.pairs) {
      if (pair.provider === provider) return pair.displayName ?? ''
    }
    return ''
  }

  /**
   * Manual switch state for one pair: 'off', 'on', or '' when nobody said.
   *
   * Both lists accept the same two spellings, and the disable list outranks the
   * enable list. That order is what keeps a pair from flickering: disabling
   * "openai/gpt-x" while "gpt-x" had already been allowed elsewhere must mean
   * off, not "depends which list is read first".
   */
  function manualState(pair, cfg) {
    const full = pair.provider + '/' + pair.model
    if (cfg.disabledModels.includes(full) || cfg.disabledModels.includes(pair.model)) return 'off'
    if (cfg.enabledModels.includes(full) || cfg.enabledModels.includes(pair.model)) return 'on'
    return ''
  }

  /**
   * Why a pair cannot be a candidate, or '' when it can.
   *
   * The reasons are named rather than collapsed into a boolean because the model
   * list shows them: "why is this model greyed out, and which switch brings it
   * back" is the first question the list has to answer. Most of the reasons are
   * structural (a combo is not a real model) or come from config.json; the manual
   * switch is read first, because it is the one that overrules a default - a
   * vision twin that the user switched on stays on.
   */
  function exclusionReason(pair, cfg) {
    const manual = manualState(pair, cfg)
    if (pair.provider.startsWith(COMBO_PREFIX) || pair.model.startsWith(COMBO_PREFIX)) return 'combo'
    // The manual switch is the most specific reason, so it is named first: a user
    // who switched this very row off should see that, not the broader rule that
    // would also have kept it out.
    if (manual === 'off') return 'manual'
    if (isVisionTwin(pair.provider) && manual !== 'on') return 'vision'
    if (cfg.excludeProviders.includes(pair.provider)) return 'provider'
    // The channel switch. A row the user switched on by hand outranks it, so
    // closing a whole channel does not take away the ability to keep one model.
    if (cfg.disabledProviders.includes(pair.provider) && manual !== 'on') return 'channel'
    if (looksNonChat(pair.model, patternCache, pair.provider)) return 'non-chat'
    const full = pair.provider + '/' + pair.model
    if (cfg.excludeModels.includes(full) || cfg.excludeModels.includes(pair.model)) return 'excluded'
    return ''
  }

  function isExcluded(pair, cfg) {
    return exclusionReason(pair, cfg) !== ''
  }

  /**
   * Rank candidates for one turn: the current model always heads the list (a
   * turn never silently starts somewhere else), then measured alternatives,
   * then cooling-down ones as a last resort.
   *
   * Measured quality is not the only preference. A model that fails is usually
   * wanted from another channel, so the same id - or a close relative - carries
   * a bonus that lifts it above unrelated models; preferSameModel turns that off
   * and leaves the ranking to the measurements alone.
   */
  async function rankCandidates(options, cfg) {
    const current = { provider: String(options.provider ?? ''), model: String(options.model ?? '') }
    const nowMs = Date.now()
    const pairs = await discoverPairs()
    const seen = new Set([current.provider + '/' + current.model])
    const ranked = []
    for (const pair of pairs) {
      if (isExcluded(pair, cfg)) continue
      const key = pair.provider + '/' + pair.model
      if (seen.has(key)) continue
      seen.add(key)
      const base = scoreCandidate(statFor(key), cfg, nowMs)
      // A cooling candidate stays negative: the same-model preference is a
      // tie-breaker among models worth trying, never a way to resurrect a dead
      // one (that is what the cooldown is for).
      const score = base < 0 ? base : base + sameModelBoost(current.model, pair.model, cfg)
      ranked.push({ pair, key, score })
    }
    ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

    // One candidate per model *family*, not one per channel. The same model on
    // five channels shares its fate - one quota wall, one dead endpoint - so
    // keeping all five in the walk spends the whole candidate budget retrying
    // what is effectively one model, and the switch notice then reads as
    // "switched to the same model again". The best-scoring channel of each
    // family survives; its siblings wait for another turn (no cooldown is
    // written for them, so a later walk can still pick them).
    const familySeen = new Set()
    const byFamily = []
    for (const row of ranked) {
      const family = String(row.pair.model).toLowerCase()
      if (familySeen.has(family)) continue
      familySeen.add(family)
      byFamily.push(row)
    }
    const ordered = [current, ...byFamily.map(row => row.pair)]

    // A pin short-circuits the ranking: the user asked for this head explicitly.
    if (pinned !== '' && pinned !== current.provider + '/' + current.model) {
      const at = ordered.findIndex(pair => pair.provider + '/' + pair.model === pinned)
      if (at > 0) ordered.unshift(ordered.splice(at, 1)[0])
    }

    return ordered.slice(0, Math.min(cfg.maxCandidates, HARD_MAX_CANDIDATES))
  }

  // ---- the turn wrapper -------------------------------------------------------

  /** Sequence for switch-question call ids; unique per process is enough. */
  let switchAskSeq = 0
  /** The unavailable-seam warning is worth saying once, not once per failure. */
  let switchSeamWarned = false

  /**
   * Ask the user before leaving a failed model.
   *
   * A zero-content failure is the only moment this plugin changes models, and
   * the reply that follows comes from a different model than the one the user
   * picked. The page can require consent first: the question travels through
   * ctx.userQuestions - the harness's own human-interaction seam - so the card
   * lands in the conversation, and askTimed() settles it as an answer or a
   * timeout.
   *
   *   answered "switch"        -> allow; the rest of this turn's walk is covered
   *   answered "stay"          -> deny; the turn ends on the original failure
   *   no answer inside timeout -> allow (the request was time-boxed switching)
   *   seam absent or throwing  -> allow (failover keeps working unattended)
   *
   * The seam accepts only the exact live root agent of the turn being served.
   * A delegated child agent has no human answerer (DELEGATED_CALLER) and an
   * agentless ask never reaches one (NO_PROVIDER); both fall through to allow
   * rather than stalling a turn nobody is watching.
   */
  async function confirmSwitch(options, cfg, fromKey, toPair, failure) {
    const questions = ctx.get?.('userQuestions')
    const registry = ctx.get?.('agents')
    if (questions === undefined || typeof questions.askTimed !== 'function') return 'allow'
    if (registry === undefined || typeof registry.currentInitiator !== 'function') return 'allow'
    let agent
    try { agent = registry.currentInitiator() } catch { return 'allow' }
    if (agent === undefined || agent === null) return 'allow'

    const timeoutMs = Math.min(
      Math.max(Math.trunc(numberOr(cfg.confirmTimeoutMs, SETTINGS_DEFAULTS.confirmTimeoutMs)), 1000),
      2147483647,
    )
    const toKey = toPair.provider + '/' + toPair.model
    const approve = '切换'
    const decline = '保持当前模型'
    switchAskSeq += 1
    const callId = 'model-rotator-' + Date.now().toString(36) + '-' + switchAskSeq
    try {
      const result = await questions.askTimed({
        questions: [{
          id: 'model-rotator-switch',
          header: '模型故障切换',
          question: '当前模型 ' + fromKey + ' 未产生任何输出。是否切换到 ' + toKey + ' 继续这一轮？',
          detail: '失败原因：' + failure + '\n\n' + Math.round(timeoutMs / 1000) + ' 秒内不作答将自动切换。',
          options: [
            { label: approve, description: '立即改用备选模型继续这一轮' },
            { label: decline, description: '不改用备选模型，这一轮以失败结束' },
          ],
        }],
        agent,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }, callId, timeoutMs)
      if (result === null || typeof result !== 'object') return 'allow'
      if (result.pending === true) return 'allow'
      const answer = Array.isArray(result.answers) ? result.answers[0] : undefined
      const selected = Array.isArray(answer?.selected) ? answer.selected.map(String) : []
      const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
      if (selected.includes(decline)) return 'deny'
      if (custom !== '' && SWITCH_REFUSAL.test(custom)) return 'deny'
      return 'allow'
    } catch (error) {
      switchSeamError = String(error)
      if (!switchSeamWarned) {
        switchSeamWarned = true
        warn('cannot ask before switching (' + String(error) + '); switches proceed unconfirmed')
      }
      return 'allow'
    }
  }

  /** The adoption warning is worth saying once, not once per switch. */
  let adoptWarned = false

  /** Last failure of the pre-switch question, reported once by the status tool. */
  let switchSeamError = ''

  /**
   * The object that owns selectForNextRequest(), or undefined.
   *
   * The service published as "sessionController" is the remote-facing facade; the
   * per-agent selection API hangs off its `agents` member - the harness's own
   * selectModel() reaches it as this.agents.selectForNextRequest(...). Probing the
   * facade itself for that method always came back undefined, which is why the
   * conversation kept displaying the failed model. Both spellings are accepted so
   * a version that promotes the method keeps working.
   */
  function sessionAgentController() {
    let controller
    try { controller = ctx.get?.('sessionController') } catch { controller = undefined }
    if (controller === undefined || controller === null) return undefined
    for (const owner of [controller.agents, controller]) {
      if (owner !== undefined && owner !== null && typeof owner.selectForNextRequest === 'function') return owner
    }
    return undefined
  }

  /**
   * Record the model that actually answered this turn as the session's model.
   *
   * A retry is served by a different provider/model than the one the session
   * selected, and nothing in the harness learns that on its own: the durable
   * request header still names the failed model, so the conversation keeps
   * displaying it. selectForNextRequest() is the session-local half of the
   * harness's own model switch - it appends the "model/selection" event the
   * model-selection projection (and therefore the UI) reads, and the harness
   * then appends its own "[model changed: ...]" notice and routes the next
   * request to the adopted model.
   *
   * The default-model write lives in the controller's selectModel(), which this
   * plugin never calls: no provider configuration and no saved default changes.
   *
   * @returns true when the session accepted the new model.
   */
  function adoptServedModel(pair) {
    const owner = sessionAgentController()
    const registry = ctx.get?.('agents')
    if (owner === undefined) return false
    if (registry === undefined || typeof registry.currentInitiator !== 'function') return false
    let agent
    try { agent = registry.currentInitiator() } catch { return false }
    if (agent === undefined || agent === null) return false
    try {
      owner.selectForNextRequest(agent, { provider: pair.provider, model: pair.model })
      return true
    } catch (error) {
      if (!adoptWarned) {
        adoptWarned = true
        warn('cannot record the swapped model on the session (' + String(error) +
          '); the conversation keeps showing the previously selected model')
      }
      return false
    }
  }

  /**
   * Walk the ranking inside one turn.
   *
   * Attempt 1 is next(): the untouched harness path. Only a content-free
   * failure is retried, and every retry is dispatched as a fresh
   * ctx.llm.stream() whose options are pre-marked so this listener stays out of
   * its own way.
   */
  async function* rotateStream(options, next) {
    const cfg = currentConfig()
    // Same captured service as discovery uses (see llmService). Cordis deactivates
    // a fiber's injected services while a turn is parked, and a live `ctx.llm` read
    // inside the walk then throws `cannot get required service "llm" in inactive
    // context` - which turned a switch into a no-op that still cost a candidate.
    const llm = llmRef()
    let candidates
    try {
      candidates = await rankCandidates(options, cfg)
    } catch (error) {
      warn('candidate discovery failed, running unrotated: ' + String(error))
      yield* next()
      return
    }
    if (candidates.length === 0) {
      yield* next()
      return
    }

    let lastFailure = null
    /**
     * The provider's own error finish, held while a retry or a later candidate
     * could still answer. When the whole walk ends with nothing to show, this is
     * what the caller gets: the provider's words, not a paraphrase of them.
     */
    let lastHeldFinish = null
    /**
     * Set when some attempt this turn was refused by the host or by this plugin
     * rather than by the provider. A turn like that must not read as "this model
     * failed": nothing about the route was learned, so the user's own model stays
     * the model, and only the attempt that really failed becomes the failure the
     * caller sees.
     */
    let hostRefusalSeen = false
    // '' = not asked yet this turn, otherwise 'allow' or 'deny'.
    let switchVerdict = ''
    for (let index = 0; index < candidates.length; index += 1) {
      const pair = candidates[index]
      const key = pair.provider + '/' + pair.model
      const stat = statFor(key)
      const isLast = index === candidates.length - 1

      // One candidate, several dispatches. A content-free failure is not believed
      // on sight: providers fail transiently (a rate-limit blip, a socket reset)
      // and a single miss would otherwise cost the user the model they picked.
      // The same model therefore gets cfg.retriesPerModel extra tries before its
      // failure is acted on. A retry is not a switch, so it changes nothing and
      // asks nobody.
      let retriesLeft = cfg.retriesPerModel
      for (;;) {
        const attempt = cfg.retriesPerModel - retriesLeft
        let stream = null
        let dispatchError = null

        if (index > 0 || attempt > 0) {
          // Every dispatch past the first one of the first candidate is a fresh
          // ctx.llm.stream() call: the harness path (next()) exists only once.
          const retryOptions = { ...options, provider: pair.provider, model: pair.model }
          retryMarkers.add(retryOptions)
          try {
            stream = llm.stream(retryOptions)
          } catch (error) {
            dispatchError = error
          }
        } else {
          stream = next()
        }

        // A dispatch that produced no stream at all (a synchronous throw, an
        // unusable object) is not a provider hiccup: it is believed at once.
        let noRetry = dispatchError !== null
        let failure = dispatchError === null ? null : failureText(dispatchError, 'dispatch error')
        let failureYielded = null
        let abandon = null
        let abandonChunk = null
        let flowed = false
        let usageTokens = 0
        let firstChunkAt = null
        const pending = []
        const startedAt = Date.now()

        if (dispatchError === null) {
          const iterator = stream?.[Symbol.asyncIterator]?.()
          if (iterator === undefined) {
            noRetry = true
            failure = 'stream is not async iterable'
          } else {
            try {
              for (;;) {
                const result = await iterator.next()
                if (result.done === true) break
                const chunk = result.value
                if (firstChunkAt === null) firstChunkAt = Date.now()

                if (chunk !== null && chunk !== undefined && chunk.type === 'usage' && chunk.usage != null) {
                  const total = Number(chunk.usage.totalTokens ?? chunk.usage.outputTokens ?? 0)
                  if (Number.isFinite(total) && total > 0) usageTokens = total
                }

                if (chunk !== null && chunk !== undefined && chunk.type === 'finish') {
                  const kind = String(chunk.reason?.kind ?? '')
                  const failed = kind === 'error' || kind === 'aborted'
                  const message = failureText(
                    chunk.reason?.failure?.message ?? chunk.reason?.message,
                    kind,
                  )
                  if (failed && !flowed) {
                    // Hold the error while anything is still worth trying - a
                    // retry of this model, or a later candidate. Only a failure
                    // with nothing behind it reaches the consumer verbatim.
                    if (!isLast || retriesLeft > 0) {
                      abandon = message
                      abandonChunk = chunk
                      break
                    }
                    failureYielded = message
                    for (const held of pending) yield held
                    pending.length = 0
                    yield chunk
                    break
                  }
                  // An error reaching this point is terminal for the turn: either
                  // text already flowed (retrying would duplicate it) or this was
                  // the last candidate. Record it as a failure, then surface it.
                  if (failed) failureYielded = message
                  for (const held of pending) yield held
                  pending.length = 0
                  yield chunk
                  break
                }

                if (isContentChunk(chunk)) {
                  flowed = true
                  for (const held of pending) yield held
                  pending.length = 0
                  yield chunk
                } else if (flowed) {
                  yield chunk
                } else {
                  pending.push(chunk)
                }
              }
            } finally {
              // A hand-written loop has no automatic close: when an attempt is
              // abandoned the upstream stream must be released here, or the
              // provider keeps generating (and billing) into a socket nobody
              // reads.
              if (abandon !== null) {
                try { await iterator.return?.() } catch { /* best effort */ }
              }
            }
          }
        }

        const elapsed = Date.now() - startedAt
        if (firstChunkAt !== null) stat.ttftMs.push(firstChunkAt - startedAt)
        if (stat.ttftMs.length > 20) stat.ttftMs.splice(0, stat.ttftMs.length - 20)
        stat.attempts += 1
        scheduleStatsSave()

        if (failure === null && failureYielded === null && abandon === null) {
          // This attempt produced the turn's answer.
          stat.successes += 1
          stat.consecutiveFailures = 0
          stat.cooldownUntil = 0
          stat.lastError = ''
          stat.lastErrorKind = ''
          stat.totalMs.push(elapsed)
          if (stat.totalMs.length > 20) stat.totalMs.splice(0, stat.totalMs.length - 20)
          if (usageTokens > 0) stat.tokens += usageTokens
          if (!flowed) stat.empty += 1
          // A retry that served content is the switch the user asked to see: make
          // it this session's model so the conversation stops naming the failed one.
          // A turn that also saw a host refusal is the exception: at least one
          // dispatch never reached a provider, so an answer here does not mean the
          // user's model is unreachable, and adopting would change their model
          // behind a fault rather than behind a failure.
          if (index > 0 && flowed && cfg.adoptSwitchedModel && !hostRefusalSeen) adoptServedModel(pair)
          // Tell the reader which model answered instead of theirs. Recorded here
          // and delivered at the turn boundary (see the notice listener), because
          // this is the moment the walk actually left the model the user picked.
          if (index > 0 && cfg.noticeSwitch) {
            // One notice per *distinct* destination per turn. The same model on
            // another channel is a legitimate switch the first time it is
            // announced; announcing it again for the next sibling channel is what
            // makes the reader see "switched to the same model" twice. A family
            // is named by its model id, which is exactly the part the reader
            // recognises.
            const alreadyNamed = noticeQueue.some(entry => entry.to.model === pair.model)
            if (!alreadyNamed) {
              noticeQueue.push({
                // "from" is the model the turn was dispatched with - the one the user
                // is looking at - not the model of whichever attempt failed last.
                from: {
                  provider: String(options.provider ?? ''),
                  model: String(options.model ?? ''),
                  displayName: displayNameOf(String(options.provider ?? '')),
                },
                to: { provider: pair.provider, model: pair.model, displayName: pair.displayName ?? '' },
                reason: classifyFailureKind(String(lastFailure ?? '')),
              })
            }
          }
          return
        }

        const failedBecause = failure ?? failureYielded ?? abandon
        // The kind, not the prose, is what the cooldown policy reads: a quota
        // wall rests until tomorrow, a blip keeps the ordinary backoff.
        const failedKind = classifyFailureKind(failedBecause)
        // A refusal that names the host - a \`"code":"dsh_*\` envelope from the
        // harness or from another plugin, or an error this plugin raised itself -
        // is not evidence about this route. Recording it as a failure cooled a
        // healthy model down and pushed the ranking away from it, which is the
        // exact complaint "it marked a good model bad" the harness-side healing
        // already had to undo on the next boot. Worse, when the refusal was
        // raised *because* a switch was attempted, it also wrote itself over the
        // provider failure that caused the switch, burying the real reason.
        // So: trust the exception (believe the failure at once, count it,
        // surface it), or drop it entirely - never let it blame a model.
        const hostRefusal = isHostRefusal(failedBecause)
        // Two different things wear the same label. A dsh_* envelope arrives over
        // the wire: the harness or another plugin refused the call around the
        // provider boundary, so the walk keeps looking for a model that answers.
        // An internal marker ("inactive context", "model-rotator: ...") is this
        // machine's own fault, and asking the next candidate would hit the same
        // wall - but it must still be *trusted* when the dispatch itself threw,
        // because masking it would hand the caller a stream that never emits.
        const internalFault = hostRefusal && !/"code"\s*:\s*"dsh_/.test(failedBecause)
        if (hostRefusal) hostRefusalSeen = true
        const trustedFailure = dispatchError !== null && internalFault
        if (!hostRefusal || trustedFailure) {
          stat.failures += 1
          stat.lastError = failedBecause
          stat.lastErrorKind = failedKind
        }

        if (failureYielded !== null) {
          // The error chunk is already in the consumer's hands; retrying now
          // would stack a second finish on a live stream, so stop and keep the
          // honest record of what failed. lastFailure is deliberately not set:
          // the caller's own error is the truth, and wrapping it again only
          // buries the provider's words under ours.
          if (!hostRefusal || trustedFailure) {
            stat.consecutiveFailures += 1
            stat.cooldownUntil = cooldownUntilFor(stat, cfg, Date.now(), failedKind)
          }
          // The error chunk is already in the consumer's hands, so the walk ends
          // here either way - and it must, because a fault of ours would repeat
          // verbatim for every remaining candidate.
          return
        }

        // A host refusal is not this route's failure and must not overwrite the
        // provider error that actually started the walk. The refusal chunk itself
        // is still held as the last finish: if nothing answers, that refusal is
        // the honest reason the turn ended, and the reader has to see it.
        if (!hostRefusal || trustedFailure) lastFailure = failedBecause
        // Remember what the provider actually said. The walk may still find a
        // model that answers, in which case this is discarded; if it does not,
        // the caller gets the provider's own error instead of a paraphrase.
        if (abandonChunk !== null) lastHeldFinish = abandonChunk

        const aborted = options.signal?.aborted === true

        // Two kinds are settled before a retry could matter: a balance does not
        // refill between two dispatches, and a request the provider refuses as
        // unsupported is refused identically by the same provider. Spending the
        // retries only delays the switch the user needs. Auth keeps its retries
        // deliberately - a 403 raised by a burst-rate proxy does recover.
        if (failedKind === 'quota' || failedKind === 'unsupported') noRetry = true

        // Retry the same model before calling it dead.
        if (retriesLeft > 0 && !noRetry && !aborted) {
          retriesLeft -= 1
          const pauseMs = Math.min(cfg.retryBackoffMs * (attempt + 1), 10000)
          if (pauseMs > 0) await sleep(pauseMs)
          continue
        }

        // The failure is believed now: cool the model down and walk on - but only
        // when the model is what failed. A host refusal cools nothing, so the
        // route stays fully available to the next turn.
        if (!hostRefusal || trustedFailure) {
          stat.consecutiveFailures += 1
          stat.cooldownUntil = cooldownUntilFor(stat, cfg, Date.now(), failedKind)
        }

        // A fault of ours ends the walk. Every further candidate would hit the
        // same wall - the refusal came from this machine, not from the network -
        // so spending the rest of the budget on it only delays the honest error.
        if (internalFault && !trustedFailure) {
          yield abandonChunk ?? {
            type: 'finish',
            reason: { kind: 'error', failure: { message: failedBecause } },
          }
          return
        }

        if (aborted) {
          // The caller stopped the turn (Stop, a deadline, a closed client).
          // Dialing another provider now would burn an attempt nobody reads.
          yield abandonChunk ?? {
            type: 'finish',
            reason: { kind: 'error', failure: { message: 'model-rotator: ' + String(failedBecause) } },
          }
          return
        }

        // Consent gate. Asked once per turn: approving the first switch covers
        // the rest of the walk, so a cascade of dead models does not become a
        // cascade of identical questions.
        if (!isLast && cfg.confirmSwitch && switchVerdict === '') {
          switchVerdict = await confirmSwitch(options, cfg, key, candidates[index + 1], failedBecause)
          if (switchVerdict === 'deny') {
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: { message: 'model-rotator: switch declined after ' + failedBecause },
              },
            }
            return
          }
        }

        break
      }
    }

    // Every candidate was exhausted without content. A provider error held back
    // during the walk is the honest answer, passed through as it arrived; only a
    // walk that never saw a finish chunk needs one written for it.
    if (lastHeldFinish !== null) {
      yield lastHeldFinish
      return
    }
    const message = lastFailure ?? 'all candidates failed'
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'model-rotator: ' + message } } }
  }

  // ---- mount ------------------------------------------------------------------

  if (typeof llmRef()?.stream === 'function') {
    ctx.on('llm/stream', (options, next) => {
      const cfg = currentConfig()
      if (!cfg.enabled) return next()
      if (options === null || typeof options !== 'object') return next()
      // Not a conversation turn (a compaction summary, a session title): the
      // refusal is about that lane, not about this model being unreachable, so
      // another provider must not be asked to take it over. Passed through
      // untouched, including its error.
      if (AUTOMATIC_PURPOSES.has(String(options.purpose ?? ''))) return next()
      if (retryMarkers.has(options)) return next()
      if (options.__modelRotator === true) return next()
      if (options.signal?.aborted === true) return next()
      if (!cfg.allowImageFailover && hasImagePart(options.messages)) return next()
      return (async function* rotatorStream() {
        yield* rotateStream(options, next)
      })()
    })
  } else {
    warn('llm.stream is unavailable; failover is disabled, tools remain mounted')
  }

  /**
   * The switch notice, announced in the conversation.
   *
   * A switch is otherwise silent - the reply simply arrives from somewhere else -
   * so the walk records that it changed the model, and the turn boundary turns
   * that record into one visible line. The delivery goes through
   * ctx.on('agent/turn-stopping') and agent.steer(): "steer" is the host's own way
   * of adding a message to the running conversation, so the notice is a normal,
   * durable, replayable entry (a user/message) rather than a private event type -
   * the persistence reader refuses to interpret a log containing a type it does
   * not know, so an invented event would break replay.
   *
   * Steered at the *end* of the turn on purpose: the switch already happened and
   * the answer is already streaming, so announcing it mid-turn would only insert a
   * context row in the middle of the reply it describes.
   */
  const noticeQueue = []
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('agent/turn-stopping', ({ agent, signal }) => {
        if (noticeQueue.length === 0) return
        const pending = noticeQueue.splice(0, noticeQueue.length)
        if (signal?.aborted === true) return
        // Only a root conversation gets the row. Announcing a switch inside
        // somebody else's subagent transcript would be noise in a log the reader
        // never asked about.
        if (agent?.session?.header?.parentSession !== undefined) return
        for (const notice of pending) {
          try { agent.steer(switchNoticeMessage(notice.from, notice.to, notice.reason)) }
          catch (error) {
            if (!noticeSteerWarned) {
              noticeSteerWarned = true
              warn('cannot post the switch notice to the conversation (' + String(error) + ')')
            }
          }
        }
      })
    } catch (error) {
      warn('cannot watch the turn boundary for switch notices: ' + String(error))
    }
  }
  /** The delivery warning is worth saying once, not once per switch. */
  let noticeSteerWarned = false

  // ---- model list over HTTP -----------------------------------------------------

  /** Read and parse a small JSON body; {} when the request carried none. */
  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_MODELS_BODY_BYTES) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  /**
   * Switch one model on or off, and remember it.
   *
   * The write goes to config.json - not the settings page - because a list of
   * arbitrary length has no natural volatile field, and because this switch is a
   * *file-layer* decision: it outlives the process the same way the pinned head
   * does, and it is readable and editable by hand when the page is not open.
   *
   * Turning a model back on removes it from the disable list and, when the entry
   * was written against a specific provider, drops that exact spelling too, so a
   * later click cannot be defeated by a stale entry nobody can see.
   */
  function setModelEnabled(key, enabled) {
    if (typeof key !== 'string' || key.trim() === '') return { ok: false, error: 'missing model key' }
    // Both spellings are legal, exactly as in the disable list the file layer
    // carries: "provider/model" names one row, a bare model id names the model on
    // every channel that serves it. An empty key is the only real mistake.
    const trimmed = key.trim()
    if (trimmed === '') return { ok: false, error: 'missing model key' }
    readFileLayer()
    const disabled = Array.isArray(cachedFile?.disabledModels) ? cachedFile.disabledModels.map(String) : []
    const allowed = Array.isArray(cachedFile?.enabledModels) ? cachedFile.enabledModels.map(String) : []
    // The bare id is the part after the provider, or the whole key when none was
    // given - dropping both spellings is what makes "switch it back on" work no
    // matter which spelling a file edit left behind.
    const slash = trimmed.indexOf('/')
    const model = slash > 0 ? trimmed.slice(slash + 1) : trimmed
    const drop = list => list.filter(entry => entry !== trimmed && entry !== model)

    let nextDisabled
    let nextAllowed
    if (enabled) {
      nextDisabled = drop(disabled)
      // "On" is recorded as an explicit statement, not merely as the absence of an
      // off. Two rules are decided at the provider level - the vision mode and the
      // channel switch - and without an entry here the row would fall straight back
      // under them and the click would look like it did nothing.
      nextAllowed = allowed.includes(trimmed) ? allowed : [...allowed, trimmed]
    } else {
      nextDisabled = disabled.includes(trimmed) ? disabled : [...disabled, trimmed]
      nextAllowed = drop(allowed)
    }
    const written = persistConfig({ disabledModels: nextDisabled, enabledModels: nextAllowed })
    return { ok: true, disabledModels: nextDisabled, enabledModels: nextAllowed, persisted: written }
  }

  /**
   * Switch a whole provider channel off or on.
   *
   * One entry for the channel, not one per model: the channel is the unit the
   * user is thinking in ("this provider is dead"), and a list of 112 model ids
   * would be both unreadable and impossible to undo honestly. Models the user
   * switched on individually survive it, because their own entry outranks this
   * one at the point the reason is decided.
   */
  function setProviderEnabled(provider, enabled) {
    const trimmed = typeof provider === 'string' ? provider.trim() : ''
    if (trimmed === '') return { ok: false, error: 'missing provider' }
    if (trimmed.includes('/')) return { ok: false, error: 'provider must not contain "/"' }
    readFileLayer()
    const current = Array.isArray(cachedFile?.disabledProviders) ? cachedFile.disabledProviders.map(String) : []
    const allowed = Array.isArray(cachedFile?.enabledModels) ? cachedFile.enabledModels.map(String) : []
    let next
    let nextAllowed = allowed
    if (enabled) {
      next = current.filter(entry => entry !== trimmed)
    } else {
      next = current.includes(trimmed) ? current : [...current, trimmed]
      // Closing a channel has to actually close it. A per-row "on" left over from
      // an earlier click would otherwise quietly reopen part of the channel and the
      // button would look broken. They are dropped here rather than ignored at read
      // time, so the stored state stays readable ("this channel is off") and a row
      // enabled *afterwards* still wins, because it writes a fresh entry.
      nextAllowed = allowed.filter(entry => !entry.startsWith(trimmed + '/'))
    }
    const written = persistConfig({ disabledProviders: next, enabledModels: nextAllowed })
    return { ok: true, disabledProviders: next, enabledModels: nextAllowed, persisted: written }
  }

  /**
   * Mount the list's data route.
   *
   * The route resolves late (ctx.inject + effect) because this plugin loads
   * before the browser half publishes the web server in the real composition: a
   * one-shot ctx.get('webServer') at apply time finds nothing, the route never
   * registers, and the page then has no data source while a server is busy
   * serving it.
   */
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], scoped => {
        const server = scoped?.webServer
        if (server === undefined || typeof server.register !== 'function') return
        const handler = async (req, res) => {
          const method = String(req?.method ?? 'GET').toUpperCase()
          try {
            if (method === 'GET') {
              sendJson(res, 200, await modelListReport())
              return
            }
            if (method === 'POST') {
              const body = await readJsonBody(req)
              const key = typeof body.key === 'string' ? body.key : ''
              // Two scopes, one route: "provider" switches a whole channel, the
              // default switches one model row.
              const result = body.scope === 'provider'
                ? setProviderEnabled(key, body.enabled !== false)
                : setModelEnabled(key, body.enabled !== false)
              if (result.ok !== true) {
                sendJson(res, 400, result)
                return
              }
              sendJson(res, 200, { ...result, list: await modelListReport() })
              return
            }
            sendJson(res, 405, { error: 'method not allowed' })
          } catch (error) {
            // A malformed body is the caller's bug; anything else is ours and is
            // reported rather than swallowed, because a page that silently shows
            // stale data is worse than one that says it failed.
            const message = String(error?.message ?? error)
            sendJson(res, /body|JSON/i.test(message) ? 400 : 500, { error: message })
          }
        }
        scoped.effect(
          () => server.register({ kind: 'exact', path: MODELS_PATH, handler }),
          'model-rotator: model list route',
        )
      })
    } catch (error) {
      warn('cannot mount the model list route: ' + String(error))
    }
  }

  // ---- tools ------------------------------------------------------------------

  const stringOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  const RANK_HEADERS = [
    'candidate', 'att', 'ok', 'fail', 'empty', 'ttft(ms)', 'state', 'type', 'rest', 'score',
  ]

  /**
   * Rows of the status tool's "in force right now" block.
   *
   * config.json and the settings page can both supply a key, and the defaults
   * supply the rest, so "what is my plugin actually running with" is a merge -
   * not something any one surface shows. Each row carries the dotted path used
   * to ask sourceOf() which layer won.
   */
  const EFFECTIVE_KEYS = [
    { key: 'enabled', path: 'enabled', read: cfg => cfg.enabled },
    { key: 'maxCandidates', path: 'maxCandidates', read: cfg => cfg.maxCandidates },
    { key: 'cooldownBaseMs', path: 'cooldownBaseMs', read: cfg => cfg.cooldownBaseMs },
    { key: 'maxCooldownMs', path: 'maxCooldownMs', read: cfg => cfg.maxCooldownMs },
    { key: 'quotaCooldownMs', path: 'quotaCooldownMs', read: cfg => cfg.quotaCooldownMs },
    { key: 'quotaCooldownHour', path: 'quotaCooldownHour', read: cfg => cfg.quotaCooldownHour },
    { key: 'statsPersistTtlMs', path: 'statsPersistTtlMs', read: cfg => cfg.statsPersistTtlMs },
    { key: 'allowImageFailover', path: 'allowImageFailover', read: cfg => cfg.allowImageFailover },
    { key: 'confirmSwitch', path: 'confirmSwitch', read: cfg => cfg.confirmSwitch },
    { key: 'confirmTimeoutMs', path: 'confirmTimeoutMs', read: cfg => cfg.confirmTimeoutMs },
    { key: 'adoptSwitchedModel', path: 'adoptSwitchedModel', read: cfg => cfg.adoptSwitchedModel },
    { key: 'retriesPerModel', path: 'retriesPerModel', read: cfg => cfg.retriesPerModel },
    { key: 'retryBackoffMs', path: 'retryBackoffMs', read: cfg => cfg.retryBackoffMs },
    { key: 'preferSameModel', path: 'preferSameModel', read: cfg => cfg.preferSameModel },
    { key: 'noticeSwitch', path: 'noticeSwitch', read: cfg => cfg.noticeSwitch },
    { key: 'weights.connectivity', path: 'weights.connectivity', read: cfg => cfg.weights.connectivity },
    { key: 'weights.speed', path: 'weights.speed', read: cfg => cfg.weights.speed },
    { key: 'disabledModels', path: 'disabledModels', read: cfg => (cfg.disabledModels.length === 0 ? '(none)' : cfg.disabledModels.length + ' entry') },
    { key: 'disabledProviders', path: 'disabledProviders', read: cfg => (cfg.disabledProviders.length === 0 ? '(none)' : cfg.disabledProviders.length + ' entry') },
    { key: 'pinned', path: 'pinned', read: cfg => (cfg.pinned === '' ? '(none)' : cfg.pinned) },
  ]

  /**
   * Where a model is from: the provider id as written, minus a combo prefix.
   *
   * The list groups by channel because that is the axis a failure travels along:
   * one broken key takes out every model behind it at once, so seeing the models
   * of a provider together (and how many of them are resting) is what tells a
   * user whether they are looking at one dead key or five unrelated ones.
   */
  function channelOf(provider) {
    return provider.startsWith(COMBO_PREFIX) ? provider.slice(COMBO_PREFIX.length) : provider
  }

  /** Minutes left on a cooldown, or 0 when the candidate is not resting. */
  function restMinutes(stat, nowMs) {
    return stat.cooldownUntil > nowMs ? Math.ceil((stat.cooldownUntil - nowMs) / 60000) : 0
  }

  /**
   * Every discovered model, grouped by provider, with its health and its switch.
   *
   * Every pair is listed, including the ones excluded from rotation: a list that
   * only showed the survivors could not answer "why is this model not being
   * used" - the reason column is the answer, and 'manual' is the one a reader can
   * change from here. Health is judged per channel as well as per model, because
   * "this provider is down" and "this one model is down" are different problems
   * with the same symptom.
   */
  async function modelListReport() {
    hydrateStats()
    const cfg = currentConfig()
    const all = await discoverPairs()
    const nowMs = Date.now()
    const rows = []
    for (const pair of all) {
      const key = pair.provider + '/' + pair.model
      const stat = stats.get(key) ?? emptyStat()
      const rest = restMinutes(stat, nowMs)
      const reason = exclusionReason(pair, cfg)
      const cooling = rest === 0 ? '' : (stat.lastErrorKind === 'quota' ? 'quota' : 'cooling')
      // "Healthy" is deliberately modest: nothing is resting, no consecutive
      // failures are on record, and the last thing seen was not an error. An
      // untried model passes - it has done nothing wrong yet - which is why the
      // empty state is not reported as a failure.
      let health = 'unknown'
      if (reason !== '') health = 'off'
      else if (cooling !== '') health = cooling
      else if (stat.consecutiveFailures === 0 && stat.lastErrorKind === '') health = 'ok'
      else health = 'error'
      // The kind of route this is, which is also how the page groups it: the
      // vision twins are not a provider of their own, they are the image-reading
      // arm of the provider they wrap ("amd" and "amd-vision" are one channel).
      const channel = channelOf(pair.provider)
      const twinOf = pair.provider.endsWith('-vision') ? pair.provider.slice(0, -'-vision'.length) : ''
      rows.push({
        key,
        provider: pair.provider,
        model: pair.model,
        channel,
        displayName: pair.displayName ?? '',
        // "vision-router" is the group; sourceChannel is the provider it wraps, and
        // it is only a real cross-reference when that provider is also dialable.
        kind: reason === 'vision' ? 'vision' : 'chat',
        sourceChannel: twinOf,
        health,
        rest,
        reason,
        lastErrorKind: stat.lastErrorKind,
        attempts: stat.attempts,
        successes: stat.successes,
        failures: stat.failures,
        ttftMs: median(stat.ttftMs),
        // The prose is for a human scanning one row; a full provider stack trace
        // times nine hundred models is a payload nobody reads.
        lastError: stat.lastError.slice(0, 160),
        manual: manualState(pair, cfg),
        inRotation: reason === '',
        // A vision twin is the one *default* exclusion here: it is usually right
        // (one model reachable twice) but a wrapper with an unusual name may be a
        // route the user wants, so the switch works on it. A combo or a non-chat
        // family is structural, and the two config.json lists are not this page's
        // to edit.
        switchable: reason === '' || reason === 'manual' || reason === 'vision' || reason === 'channel',
      })
    }
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const channels = new Map()
    for (const row of rows) {
      let bucket = channels.get(row.provider)
      if (bucket === undefined) {
        bucket = {
          provider: row.provider,
          channel: row.channel,
          // The vendor's own label when the host publishes one; the id otherwise.
          displayName: row.displayName === '' ? row.channel : row.displayName,
          kind: row.kind,
          sourceChannel: row.sourceChannel,
          // The channel's own switch: off when the whole provider was switched off
          // from its header, which is what labels that button.
          switchedOff: cfg.disabledProviders.includes(row.provider),
          models: [],
          ok: 0,
          off: 0,
          resting: 0,
        }
        channels.set(row.provider, bucket)
      }
      bucket.models.push(row)
      if (row.health === 'ok') bucket.ok += 1
      else if (row.health === 'off') bucket.off += 1
      else bucket.resting += 1
    }
    /**
     * Group the channels into the two sections the page shows.
     *
     * They are different questions, which is why they are not one list: the chat
     * channels are what failover actually ranks, while the vision group is the
     * image-reading arm each of them has - one model reachable twice, listed
     * separately so the chat section stays readable and so the (~450) twins do not
     * bury the candidates that matter. The wrapped channel is named with the twin
     * because that is what makes the pair legible: "amd-vision" alone reads as
     * another provider, "amd-vision -> amd" does not.
     */
    const buckets = [...channels.values()]
    const groups = [
      { key: 'chat', channels: buckets.filter(channel => channel.kind === 'chat') },
      { key: 'vision', channels: buckets.filter(channel => channel.kind === 'vision') },
    ].filter(group => group.channels.length > 0)
    for (const group of groups) {
      // The section carries the same counters as a channel, so both layers have one
      // shape. The page derives its tallies from the rows either way, so these are
      // for any other consumer (and for reading the payload by hand).
      group.models = group.channels.reduce((sum, channel) => sum + channel.models.length, 0)
      group.ok = group.channels.reduce((sum, channel) => sum + channel.ok, 0)
      group.resting = group.channels.reduce((sum, channel) => sum + channel.resting, 0)
      group.off = group.channels.reduce((sum, channel) => sum + channel.off, 0)
    }
    return {
      at: nowMs,
      total: rows.length,
      inRotation: rows.filter(row => row.inRotation).length,
      // Deliberately no cfg: the page already has every setting through the
      // form, and the roster's own answer is the roster.
      groups,
      channels: buckets,
      models: rows,
    }
  }

  /** Human-readable ranking view, shared by status and benchmark. */
  async function rankingReport() {
    hydrateStats()
    const cfg = currentConfig()
    const pairs = await discoverPairs()
    const nowMs = Date.now()
    const rows = pairs
      .filter(pair => !isExcluded(pair, cfg))
      .map(pair => {
        const key = pair.provider + '/' + pair.model
        const stat = stats.get(key) ?? emptyStat()
        const cooling = stat.cooldownUntil > nowMs
        return [
          key,
          stat.attempts,
          stat.successes,
          stat.failures,
          stat.empty,
          median(stat.ttftMs) ?? '-',
          cooling ? (stat.lastErrorKind === 'quota' ? 'QUOTA-REST' : 'COOLDOWN') : '-',
          stat.lastErrorKind === '' ? '-' : stat.lastErrorKind,
          cooling ? Math.ceil((stat.cooldownUntil - nowMs) / 60000) + 'm' : '-',
          scoreCandidate(stat, cfg, nowMs).toFixed(3),
        ]
      })
    rows.sort((a, b) => Number(b[9]) - Number(a[9]))
    return { cfg, rows, pairs: pairs.length, nowMs }
  }

  /**
   * The provider/model the running session last sent, or an honest placeholder.
   *
   * A tool call runs inside the turn's initiator scope, so currentInitiator()
   * resolves to the agent whose session is on screen - which is what "the model
   * I am using right now" means. The header, not the default, is the answer: the
   * default is what the next *new* session starts with.
   */
  function modelInUse() {
    const registry = ctx.get?.('agents')
    if (registry === undefined || typeof registry.currentInitiator !== 'function') return '(no live session)'
    let agent
    try { agent = registry.currentInitiator() } catch { return '(no live session)' }
    const headerConfig = agent?.session?.requestHeader?.()?.config
    if (headerConfig === undefined || typeof headerConfig.provider !== 'string') return '(no request in this session yet)'
    const effort = headerConfig.reasoningEffort === undefined ? '' : ' (effort ' + headerConfig.reasoningEffort + ')'
    return headerConfig.provider + '/' + headerConfig.model + effort
  }

  /** Whether the session-local model switch seam is mounted in this host. */
  function sessionSwitchLine() {
    return sessionAgentController() !== undefined
      ? 'available (the swapped model becomes the model of this session; no default is written)'
      : 'unavailable (the conversation keeps showing the previously selected model)'
  }

  /** Whether the pre-switch question can actually reach a human right now. */
  function askChannelLine() {
    let questions
    try { questions = ctx.get?.('userQuestions') } catch { questions = undefined }
    if (questions === undefined || questions === null) {
      return 'unavailable (ctx.userQuestions is not mounted; switches proceed unconfirmed)'
    }
    if (typeof questions.askTimed !== 'function') {
      return 'unavailable (ctx.userQuestions.askTimed is missing; switches proceed unconfirmed)'
    }
    if (switchSeamError !== '') return 'mounted; the last question failed: ' + switchSeamError
    return 'mounted (askTimed; a delegated or agentless turn is allowed through without asking)'
  }

  ctx.tools.register({
    name: 'model_rotator_status',
    description:
      'Report the model-rotator state: whether failover is enabled, where its config lives, the model this session is using now, every discovered model, and the measured ranking (attempts, successes, failures, median TTFT, active cooldown, score). Read-only: it changes no model or provider configuration.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: stringOutput,
    async execute() {
      const { cfg, rows, pairs } = await rankingReport()
      const shadowed = pageKeysInFile()
      // When schemastery did not load, the first and last probe entries name the
      // reason, so the settings page can be diagnosed without another restart.
      const probeNote = SCHEMA_PROBE.length === 0
        ? ''
        : ' - ' + SCHEMA_PROBE[0]
          + (SCHEMA_PROBE.length > 1 ? ' ... ' + SCHEMA_PROBE[SCHEMA_PROBE.length - 1] : '')
      const settingsLine = z === undefined
        ? 'unavailable (schemastery not resolvable; file config only)' + probeNote
        : 'live, ' + PAGE_KEYS.length + ' fields + weights.connectivity/speed'
      const lines = [
        'model-rotator status',
        '  enabled          : ' + cfg.enabled,
        '  config           : ' + configPath,
        '  settings page    : ' + settingsLine,
        '  discovered       : ' + pairs + ' provider/model pairs',
        '  maxCandidates    : ' + cfg.maxCandidates,
        '  cooldown base/cap: ' + cfg.cooldownBaseMs + 'ms / ' + cfg.maxCooldownMs + 'ms',
        '  quota rest       : ' + (cfg.quotaCooldownMs <= 0
          ? 'disabled (a quota failure takes the ordinary backoff)'
          : 'until the next day at ' + String(cfg.quotaCooldownHour).padStart(2, '0')
            + ':00 local, at least ' + Math.round(cfg.quotaCooldownMs / 60000) + 'min'),
        '  pinned head      : ' + (pinned === '' ? '(none)' : pinned),
        '  disabled models  : ' + (cfg.disabledModels.length === 0 ? '(none)' : cfg.disabledModels.join(', ')),
        '  disabled channels: ' + (cfg.disabledProviders.length === 0 ? '(none)' : cfg.disabledProviders.join(', ')),
        // Named here because the symptom is confusing: a model the user can see in
        // the directory is absent from the ranking, and only this rule explains it.
        '  switch notice    : ' + (cfg.noticeSwitch
          ? 'posted in the conversation after a switch (a notice row, not a message)'
          : 'off; a switch stays silent'),
        '  vision twins     : never a candidate (the dsh-vision-router mode wraps a model, it is not a second one)',
        '  model list route : ' + MODELS_PATH + ' (GET the grouped list; POST {key, enabled} to switch one off or on)',
        '  image failover   : ' + (cfg.allowImageFailover ? 'allowed' : 'skipped (text-only turns only)'),
        '  switch confirm   : ' + (cfg.confirmSwitch
          ? 'ask first; switches on confirm or after ' + cfg.confirmTimeoutMs + 'ms, never on decline'
          : 'no prompt; switches immediately'),
        '  ask channel      : ' + askChannelLine(),
        '  adopt on switch  : ' + (cfg.adoptSwitchedModel
          ? 'yes; the model that answered becomes the model of this session'
          : 'no; this session keeps the model you picked'),
        '  model in use now : ' + modelInUse(),
        '  session switch   : ' + sessionSwitchLine(),
        '  last failure seen: ' + (() => {
          const seen = [...stats.entries()]
            .filter(([, stat]) => stat.lastError !== '')
            .map(([key, stat]) => key + ' [' + (stat.lastErrorKind === '' ? 'unclassified' : stat.lastErrorKind) + '] '
              + stat.lastError.slice(0, 80))
          return seen.length === 0 ? '(nothing recorded yet)' : seen.join(' | ')
        })(),
        '  failure verdict  : ' + (cfg.retriesPerModel === 0
          ? 'first failure; the model is dropped at once'
          : 'the model gets ' + cfg.retriesPerModel + ' more tr'
            + (cfg.retriesPerModel === 1 ? 'y' : 'ies') + ' ('
            + cfg.retryBackoffMs + 'ms, then ' + cfg.retryBackoffMs * 2 + 'ms, ...) before it counts as failed'),
        '  switch order     : ' + (cfg.preferSameModel
          ? 'the same model on another provider first, then close relatives, then the ranking'
          : 'pure ranking; no same-model preference'),
        '',
        'in force right now (default < config.json < settings page):',
        ...EFFECTIVE_KEYS.map(entry => '  ' + entry.key.padEnd(19) + ': '
          + String(entry.read(cfg)).padEnd(10) + ' [' + sourceOf(entry.path) + ']'),
      ]
      if (shadowed.length > 0) {
        lines.push(
          '  note             : ' + configPath + ' also sets ' + shadowed.join(', ') +
          '; the settings page wins for those keys.',
        )
      }
      lines.push('', rows.length === 0 ? '(no candidates discovered)' : formatTable(rows, RANK_HEADERS))
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'model_rotator_benchmark',
    description:
      'Measure candidate models with a minimal live request (tiny prompt, small output cap) to refresh TTFT/throughput and clear or confirm cooldowns. This spends a small amount of each provider quota, so it is bounded by limit (default 5, max 20) and always reports per-candidate latency.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum candidates to probe (default 5, max 20).' },
        prompt: { type: 'string', description: 'Prompt sent to each candidate (default "ping").' },
        timeoutMs: { type: 'number', description: 'Per-candidate timeout in milliseconds (default 20000).' },
      },
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args) {
      if (typeof llmRef()?.stream !== 'function') return 'llm/stream is unavailable; nothing was probed.'
      const cfg = currentConfig()
      const limit = Math.min(Math.max(Math.trunc(numberOr(args.limit, 5)), 1), 20)
      const prompt = typeof args.prompt === 'string' && args.prompt !== '' ? args.prompt : 'ping'
      const timeoutMs = Math.min(Math.max(numberOr(args.timeoutMs, 20000), 1000), 120000)

      const pairs = (await discoverPairs()).filter(pair => !isExcluded(pair, cfg)).slice(0, limit)
      if (pairs.length === 0) return 'No candidate models were discovered.'

      const results = []
      for (const pair of pairs) {
        const key = pair.provider + '/' + pair.model
        const stat = statFor(key)
        const startedAt = Date.now()
        let firstChunkAt = null
        let text = ''
        let failure = ''
        let timer
        const controller = new AbortController()
        try {
          timer = setTimeout(() => controller.abort(), timeoutMs)
          const stream = llmRef().stream({
            provider: pair.provider,
            model: pair.model,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            maxTokens: 8,
            signal: controller.signal,
            __modelRotator: true,
          })
          const iterator = stream[Symbol.asyncIterator]()
          stat.attempts += 1
          for (;;) {
            const result = await iterator.next()
            if (result.done === true) break
            const chunk = result.value
            if (firstChunkAt === null) firstChunkAt = Date.now()
            if (chunk !== null && chunk !== undefined && chunk.type === 'text-delta') text += String(chunk.text ?? '')
            if (chunk !== null && chunk !== undefined && chunk.type === 'finish') {
              const kind = String(chunk.reason?.kind ?? '')
              if (kind === 'error' || kind === 'aborted') failure = failureText(chunk.reason?.failure?.message, kind)
              break
            }
          }
        } catch (error) {
          failure = failureText(error, 'benchmark error')
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }

        const elapsed = Date.now() - startedAt
        if (firstChunkAt !== null) stat.ttftMs.push(firstChunkAt - startedAt)
        if (stat.ttftMs.length > 20) stat.ttftMs.splice(0, stat.ttftMs.length - 20)
        if (failure === '') {
          stat.successes += 1
          stat.consecutiveFailures = 0
          stat.cooldownUntil = 0
          stat.lastError = ''
          stat.lastErrorKind = ''
          stat.totalMs.push(elapsed)
          if (stat.totalMs.length > 20) stat.totalMs.splice(0, stat.totalMs.length - 20)
        } else {
          const failedKind = classifyFailureKind(failure)
          stat.failures += 1
          stat.consecutiveFailures += 1
          stat.cooldownUntil = cooldownUntilFor(stat, cfg, Date.now(), failedKind)
          stat.lastError = failure
          stat.lastErrorKind = failedKind
        }
        scheduleStatsSave()
        results.push([
          key,
          firstChunkAt === null ? '-' : firstChunkAt - startedAt,
          elapsed,
          failure === '' ? 'ok' : 'FAIL',
          failure === '' ? text.slice(0, 40) : failure.slice(0, 60),
        ])
      }

      const { rows } = await rankingReport()
      return [
        'Probed ' + results.length + ' candidate(s), timeout ' + timeoutMs + 'ms.',
        '',
        formatTable(results, ['candidate', 'ttft(ms)', 'total(ms)', 'result', 'detail']),
        '',
        'Updated ranking:',
        formatTable(rows, RANK_HEADERS),
      ].join('\n')
    },
  })

  ctx.tools.register({
    name: 'model_rotator_select',
    description:
      'Pin or unpin the model that heads the failover order (the ranking still decides the tail). Pass target as "provider/model", or clear: true to remove the pin. This only sets the rotator own preference; it never edits provider or agent-default-model configuration.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Preferred head as "provider/model".' },
        clear: { type: 'boolean', description: 'Remove the current pin instead of setting one.' },
      },
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args) {
      if (args.clear === true) {
        pinned = ''
        const persisted = persistConfig({ pinned: '' })
        return 'Pin cleared.' + (persisted ? '' : ' (config at ' + configPath + ' was not writable; the change applies to this process only)')
      }
      const target = typeof args.target === 'string' ? args.target.trim() : ''
      if (target === '') return 'Nothing selected: pass target as "provider/model", or clear: true.'
      const known = (await discoverPairs()).some(pair => pair.provider + '/' + pair.model === target)
      pinned = target
      const persisted = persistConfig({ pinned: target })
      return [
        'Pinned head: ' + target,
        known ? '(discovered and dialable)' : '(warning: not currently discovered; it is used only if it appears)',
        persisted ? '' : '(config at ' + configPath + ' was not writable; the change applies to this process only)',
      ].filter(line => line !== '').join('\n')
    },
  })
}
