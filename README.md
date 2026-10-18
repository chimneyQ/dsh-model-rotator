# dsh-model-rotator

> [简体中文](./README.zh.md) | **English** | [Changelog](./CHANGELOG.md)

Model auto-ranking and transparent failover for DeepSeek Harness.

When the current model hits a quota wall, an expired credential, a rate limit or
a transient network error, this plugin switches to the next-best configured
model **inside the same turn** — and the user sees an ordinary reply.

## What it does

1. **Discovers** every dialable `provider/model` on this machine
   (`ctx.llm.listProviders()` + each adapter's `listModels()`).
2. **Filters** out families that cannot answer a chat turn — embeddings,
   rerankers, ASR/TTS, OCR, image/video generation, content moderators and
   judges. Dialing one of those can only fail the turn and burn a cooldown slot
   that a real model could have used.
3. **Skips the image-reading mode.** dsh-vision-router wraps a chat route into a
   twin (`<provider>-vision`) whose only job is to add image reading to that same
   model. It is one model reachable twice, not a second one, so failing a text
   turn over into it would answer through the image pipeline — and the
   same-model preference below would rank the twin *first*. Those routes are
   therefore never candidates (a model id that merely *mentions* vision is still
   a chat model and stays). The model list can switch one back on when a wrapper
   name does not follow the convention.
4. **Ranks** the survivors by measured connectivity (Laplace-smoothed success
   rate), speed (median TTFT and throughput) and an active failure cooldown. A
   model that *is* the current one — or a close relative of it — on another
   provider carries a bonus, because the model you picked is usually the model
   you want, just from a working channel.
4. **Retries before it believes a failure.** A provider fails transiently: a
   rate-limit blip, a reset socket, an overloaded channel. One miss therefore
   does not count as a fault — the same model gets `retriesPerModel` more tries
   (2 by default, 0–5), `retryBackoffMs` apart (300 ms, then the double of it),
   before the failure is acted on. A retry is not a switch: it asks nothing and
   changes nothing.
5. **Fails over** at the `llm/stream` waterfall: attempt 1 is the untouched
   harness path; a failure that produced **no content at all** abandons that
   attempt, closes its upstream stream, and re-dispatches the next candidate as
   a fresh `ctx.llm.stream()` — the same model first while retries remain, then
   the ranking above.

Once any content chunk has been yielded the attempt is never retried — a second
attempt would duplicate visible text. That zero-content window is exactly the
retryable window.

A turn the caller cancelled (Stop, a deadline, a closed client) ends there: the
walk stops instead of burning attempts on a reply nobody will read.

### What counts as content

"Flow" is the switch that closes the retry window, so it means *the user has been
shown reply text* — and nothing weaker. A `reasoning-delta` is not content: the
harness folds reasoning away again when a retry happens, which is exactly what
makes retrying a reasoning-loop or reasoning-effort failure safe. Markup chunks
(`block-start`, or a `block-end` carrying a reasoning block) are not content
either. Counting those was a real defect: a live model looked dead because a
block-start closed the window and the very next error was taken as final.

### Automatic calls are not conversation turns

A compaction summary and a session title ride the same `llm/stream` seam but are
not a user turn. Their refusals are usually statements about *that lane* — a
proxy answering "bili owns compression here" — so asking a second provider to
carry the plumbing is the wrong reflex: it burns a real model on work nobody
reads, and it is the single loudest source of spurious switching. The plugin
therefore passes any call carrying `purpose: "compaction"` or
`purpose: "session-title"` straight through, error included. An unnamed call —
every ordinary turn — keeps failing over exactly as before.

## Announcing a switch

A switch is otherwise silent: the reply simply arrives from a different model.
The plugin now records it on the **Model switches** tab, beside 对话 / 轨迹 /
上下文, one row per switch — when it happened, which model answered instead, and
why:

```
14:07:31  modelscope/deepseek-ai/DeepSeek-V4.1-Flash → trae/deepseek-v4.1-flash   (quota)
```

The tab reads the plugin's own record
(`GET /_dsh/model-rotator/switches?session=<id>`), so a switch costs **no
conversation context**. The conversation it belongs to is **injected by the Host**
— the cell registers `inject: (sessionId) => ({ sessionId })` and reads
`props.sessionId`, the same contract the built-in 对话 and 轨迹 tabs use (before
0.2.11 it read a field the Host never had, so the tab could not tell which
conversation it was in). Records are filed per conversation, and the session is
bound **where the switch happens** — `ctx.get('agents').currentInitiator()` answers
with the agent that started the call — rather than at the turn boundary, which is
process-wide: whichever conversation stops a turn next would otherwise drain the
queue and take everyone else's rows with it. A call with no live turn (a plugin
route, a host without `agents`) still records, with an empty session; empty-session
rows appear only in the every-session view.

When this conversation has no rows of its own but the log is not empty, the tab
falls back to **every conversation's** rows and labels the view as such, so history
never reads as "nothing happened".

If you also want the old line in the transcript, turn `noticeSwitch` on and the
plugin posts it as before — `模型已切换：A → B`, with the failure kind in brackets
when it is known (`(quota)`, `(rate-limit)`).

| Behaviour | |
|-----------|--|
| Default | **not posted** (`noticeSwitch: false`). The record is on the tab; the row is optional |
| Shape | the host's own notice mechanism: a `user/message` whose source is `{ kind: 'model-rotator/switch', form: 'notice', summary }`. The conversation UI renders that form as a context row, not as something you typed |
| Timing | the notice row is posted at the turn boundary, via `agent/turn-stopping` + `agent.steer`. The switch already happened and the answer is already streaming, so announcing it mid-turn would insert a row in the middle of the reply it describes (the *record* is not written here — see above) |
| Scope | the root conversation only. A switch inside a subagent transcript is somebody else's log |
| On | `noticeSwitch: true` (or the settings-page toggle) |

The event type is deliberately **not** a private one. The persistence reader
refuses to interpret a session log containing a type it does not know
(`dsh-session`'s `KNOWN_SESSION_EVENT_TYPES`), so an invented event would make a
log carrying it fail to load. `user/message` is known, and `notice` is a form the
client already understands — the same pair the harness uses for its own
"model changed" line.

The vendor half of the label is the provider's own `displayName` when the host
publishes one (硅基流动 for `siliconflow`), falling back to the route id. The id
stays visible in the model list, because that is what `config.json`'s lists use.

## Asking before switching

A failover replaces the model the user picked, and it can do so silently. The
default is therefore to ask first: when the current model fails with no content,
the plugin raises a question in the conversation through the harness's own
human-interaction seam (`ctx.userQuestions.askTimed()`), offering **切换** and
**保持当前模型**.

| Reply | Outcome |
|-------|---------|
| 切换 (or any answer that is not a refusal) | the next candidate serves the turn |
| 保持当前模型 (or a typed refusal — 不/否/取消/拒绝/no/cancel/stop/…) | nothing further is dialed; the turn ends on the original error |
| no answer inside the window | the switch proceeds — the request was time-boxed, not vetoed |

The question is raised **once per turn**: approving the first switch covers the
rest of that walk, so a cascade of dead models does not become a cascade of
identical cards. The wait is 20 s by default and configurable.

**Two failures are no longer asked about.** An exhausted balance (`quota`) and a
request the provider refuses as unsupported (`unsupported`) are deterministic
dead ends: the money does not come back inside the window and the next dispatch is
refused identically. Declining there cannot keep the model working — it only ends
the turn, after a card and a wait — so those switch on their own, and the tab
still records why. **Auth keeps its question**: a 403 is often a burst-rate proxy
that clears, so "keep my model and let me retry" is a real choice there.

Failover is deliberately fail-open. If the seam is missing, the ask throws, the
turn has no live root agent (a delegated sub-agent has nobody to answer), or the
timeout is reached, the walk continues unconfirmed. An unattended harness must
not stall on a card nobody is watching.

## The failure kind decides the rest

A failure is not just a string: it is classified, and the class decides how long
the model sits out.

**A quota wall is not a rate limit.** `429 insufficient balance` and `429 too many
requests` are the same HTTP status, yet one clears in seconds and the other does
not until the allowance resets. The plugin reads the kind out of the message -
`insufficient quota`, `out of credits, please top up`, `余额不足，请充值`, `额度已用尽`,
`402 Payment Required` and similar - and treats a balance problem differently:

| Kind | Rest | Retry first? |
|------|------|--------------|
| `quota` | until the next day at `quotaCooldownHour` (00:00 local by default), and never less than `quotaCooldownMs` | no - the balance does not refill between two dispatches |
| `auth` | ordinary exponential backoff | yes - a 403 from a burst-rate proxy does recover |
| `unsupported` | ordinary exponential backoff | no - the same provider returns the same refusal to the same request |
| `rate-limit` | ordinary exponential backoff | yes |
| `server` / `network` | ordinary exponential backoff | yes |
| unclassified | ordinary exponential backoff | yes |

`unsupported` is the request-shape refusal — *"provider X model Y does not
support reasoning effort high"*, *"unsupported model"*. It is decided before the
request is read, so the retry dispatches would repeat it verbatim; skipping them
is what turns a session-level mismatch into one switch instead of three.

An authentication failure is classified *before* a bare `429`, because waiting
never repairs a key: for `429 invalid api key` the honest name is `auth`, not
`rate-limit`. The distinction is recorded, not acted on - both take the same
backoff; only `quota` changes the policy.

The rest is at least "the following day at `quotaCooldownHour`". A wall hit at
23:50 still pays the full `quotaCooldownMs` floor, so it returns at 11:50 the
next day rather than ten minutes later at midnight.

`model_rotator_status` shows it: the ranking marks such a row `QUOTA-REST` (with
the remaining hours) rather than `COOLDOWN`, the `type` column names the class,
and a `last failure seen` line lists each model's last error with its kind.

Measured state - counters, the last error and kind, the cooldown horizon -
**outlives the process**, because the restart a user performs right after being
told their balance is gone must not undo the rest. It is written to
`%DSH_HOME%\model-rotator\stats.json` (or `dirname(config.json)`), debounced, and
read back once on first use. Latency samples deliberately stay in memory: they
are a 20-sample sliding window, and a stale window is worse than a short one.
`statsPersistTtlMs` bounds the age of a restored file (24 h by default; 0
disables the file entirely).

## What it does NOT do

It never reads, writes or rewrites model/provider configuration. It does not
touch `cordis.patch.yml`, `agent-default-model`, `llm-pi-ai` or any provider
registration. It only observes the stream waterfall at runtime.

## Non-chat filtering

The harness adapter strips the catalog's own `wire: 'chat'` marker before
handing rows to `listModels()`, so capability cannot be read off the row.
Name matching is the available signal, and it is deliberately narrow — a
pattern must not touch a chat model that merely mentions a modality
(`Qwen3-VL-8B-Instruct` is chat; `Z-Image-Turbo` is not).

The filter denies families across vectors/ranking, speech, image generation,
document parsing and safety classifiers — in both the plain and the `-vision`
provider variants. It runs during discovery, so the count the plugin reports
(`discovered`) is already the post-filter pool, and a machine's numbers depend
entirely on which providers are configured. Ask a live install rather than
quoting a figure from here:

```
model_rotator_status      # "discovered" = candidates after this filter
```

## Tools

| Tool | Purpose |
|------|---------|
| `model_rotator_status` | Read-only: enabled state, config path, discovered pool, measured ranking. |
| `model_rotator_benchmark` | Probe candidates with a minimal live request to refresh TTFT/throughput and cooldowns (bounded, spends a little quota). |
| `model_rotator_select` | Pin/unpin the head of the failover order; the ranking still decides the tail. |

The status tool also reports the two manual lists and the vision rule, so a model
the user can see in the directory but not in the ranking can be explained without
reading the code:

```
  disabled models  : workbuddy/hy3
  vision twins     : never a candidate (the dsh-vision-router mode wraps a model, it is not a second one)
  model list route : /_dsh/model-rotator/models (GET the grouped list; POST {key, enabled} to switch one off or on)
```

## Configuration

Optional, at `%DSH_HOME%\model-rotator\config.json` (hot-reloaded on change).
Every field has a safe default, so the plugin works with no file at all.

```json
{
  "enabled": true,
  "allowImageFailover": false,
  "maxCandidates": 4,
  "cooldownBaseMs": 60000,
  "maxCooldownMs": 1800000,
  "quotaCooldownMs": 43200000,
  "quotaCooldownHour": 0,
  "statsPersistTtlMs": 86400000,
  "confirmSwitch": true,
  "confirmTimeoutMs": 20000,
  "adoptSwitchedModel": true,
  "retriesPerModel": 2,
  "retryBackoffMs": 300,
  "preferSameModel": true,
  "weights": { "connectivity": 0.5, "speed": 0.3 },
  "excludeProviders": [],
  "excludeModels": [],
  "excludePatterns": [],
  "disabledModels": [],
  "enabledModels": [],
  "pinned": ""
}
```

- `enabled` — master switch.
- `allowImageFailover` — image turns are skipped by default: a text-only
  fallback cannot read an image, so failing over there would produce a wrong
  answer rather than a missing one.
- `maxCandidates` — cap per turn (hard ceiling 8).
- `cooldownBaseMs` / `maxCooldownMs` — exponential backoff bounds
  (`base * 2^(n-1)`, clamped to `max`).
- `quotaCooldownMs` — minimum rest after a quota wall (default 12 h, ceiling
  26 h). Counted from the failure, not rounded to the hour.
- `quotaCooldownHour` — local hour (0–23) at which an exhausted model may be
  tried again (default 0 = next midnight). The rest always reaches that hour of
  the *following* day, so a wall hit at 00:05 does not revive the same evening.
- `statsPersistTtlMs` — how long measured state survives a restart (default
  24 h, ceiling 30 d; 0 = do not persist).
- `confirmSwitch` — ask in the conversation before leaving a failed model
  (default `true`; see above).
- `confirmTimeoutMs` — how long that question waits before switching anyway
  (default 20000; clamped to 1 s … 10 min).
- `adoptSwitchedModel` — after a switch, make the model that actually
  answered the model of *this session*, so the conversation header shows what is
  really in use (default `true`). Session-local only: no provider configuration
  and no saved default is touched, and the harness's own "model changed" notice
  then names the right pair.
- `retriesPerModel` — extra tries the same model gets before its failure is
  believed (default 2, hard ceiling 5). A retry needs no confirmation because it
  does not change the model.
- `retryBackoffMs` — pause before each retry (default 300; the nth retry waits
  n times this, capped at 10 s).
- `preferSameModel` — rank the same model on another provider first, then close
  relatives, then the measured ranking (default `true`).
- `noticeSwitch` — *also* post the one-line switch notice in the conversation
  (default `false`; the switch record is on the Model switches tab either way —
  see "Announcing a switch" above).
- `weights` — connectivity vs speed in the score.
- `excludeProviders` / `excludeModels` — keep specific routes out of the pool.
- `excludePatterns` — extra regex sources appended to the non-chat deny list.
  An invalid pattern is skipped, never fatal.
- `disabledModels` — models switched off from the model list on the settings
  page. Each entry is `"provider/model"` or a bare model id (which matches every
  channel serving that model). A per-row entry outranks the channel rule.
- `disabledProviders` — whole channels switched off from a channel header's
  button. One entry per provider id. Closing a channel also clears the per-row
  `enabledModels` entries inside it, so the switch cannot be silently undone;
  enabling a row afterwards writes a new entry that does take effect.
- `enabledModels` — the opposite, and the only way to put a vision twin back into
  rotation when its wrapper name does not follow the `<provider>-vision`
  convention. Written by the same switch.
- `pinned` — preferred head of the failover order.

## Settings page

The plugin ships both halves of a real settings page: the server-side `Config`
schema the Harness serves for the `model-rotator` namespace, and a browser
bundle (`client.js`, declared through `dsh.client` plus `exports["./client"]`)
that renders the form in two host cells from one component:

- **Settings → Model failover**, its own entry in the Settings navigation
  (`settings.section`, id `model-rotator`, order 20). The Harness renders the
  plugin settings pages this way; the shell hands the cell `{ close }` and
  filters by the registration id.
- the **model-rotator** card in the Plugins panel (`plugins.item`), which
  renders the same form as its card body.

Both cells only appear while the host actually serves the namespace. Only the
fields that are safe to personalize appear there:

| Field | |
|-------|--|
| `enabled` | master switch |
| `allowImageFailover` | also fail over image turns |
| `maxCandidates` | models one turn may try |
| `cooldownBaseMs` | backoff base |
| `maxCooldownMs` | backoff cap |
| `quotaCooldownMs` | minimum rest after a quota wall |
| `quotaCooldownHour` | hour at which an exhausted model returns |
| `statsPersistTtlMs` | how long measurements survive a restart |
| `confirmSwitch` | ask before switching |
| `confirmTimeoutMs` | how long that question waits |
| `adoptSwitchedModel` | show the switched model on this session |
| `retriesPerModel` | tries before a failure is believed |
| `retryBackoffMs` | pause between those tries |
| `preferSameModel` | same model on another channel first |

`weights.connectivity` / `weights.speed` are **not** on the page: the form
model stages one top-level key at a time, so nested values stay in
`config.json`. Long lists meant for editing by hand or by tool —
`excludeProviders`, `excludeModels`, `excludePatterns`, `pinned` — stay
there too.

### The model list

Below the settings form the same page renders **模型列表 / Models**: every
discovered `provider/model`, with its health and a switch — plus a switch on each
channel header that closes **every model behind that provider in one click**. The
pair of levels is deliberate: a channel switch is the useful action when a key or
an endpoint dies (everything behind it is unreachable at once), while a row switch
is what you reach for when one model is bad and its neighbours are fine.

The list is split into two sections, because they answer different questions:

| Section | Contents |
|---------|----------|
| **对话渠道** (chat channels) | the routes failover actually ranks — the candidates |
| **识图模式** (vision mode) | the `<provider>-vision` twins, each labelled with the channel it wraps (`amd-vision → amd`) |

**Three fold levels, all independent**: each section, each provider channel inside
it, and the roster as a whole. Chat channels start open and the vision section
starts **closed**: there are as many twins as everything else on this machine
(453 of 906 rows in the last live scan), and none of them is ever a candidate, so
leaving them folded is what makes the page readable at all. Two buttons —
**全部展开 / 全部收起** — open or close every section and channel at once.

Closing a channel writes a single `disabledProviders` entry rather than one entry
per model — the channel is the unit you are thinking in, and a list of a hundred
ids would be unreadable and impossible to undo honestly. Four rules keep the two
levels from fighting:

- the header button is labelled from the channel's own flag, not from whether its
  rows happen to be in rotation — a channel whose rows are all off for per-row
  reasons is still **open**, and one closed from the header must offer the action
  that reopens it;
- a closed channel offers **启用本渠道**, and the row switches underneath stay
  available for putting one model back without reopening the whole channel;
- closing a channel clears the stale per-row overrides inside it (so the button
  does what it says), and a row you switch on **afterwards** wins (a fresh,
  deliberate statement beats an older blanket one);
- a **vision** channel carries no channel switch at all. Its rows are kept out by
  the twin rule, which the channel flag cannot lift, so a button there would write
  an entry that changes nothing while reading like a promise. Use a row switch.

The channel label is the vendor name the host publishes on the registered route
(`硅基流动` for `siliconflow`), falling back to the route id when a route
publishes no label; the id is kept in parentheses when the two differ.

A folded line never hides what matters: every channel header (and every section
header) prints the same tally — derived from the rows, not from a host-supplied
counter, so the two layers cannot disagree. A collapsed provider still says
whether it is healthy. The page also rebuilds the sections from `channels` when
the host does not send `groups`, because the two halves are versioned together
but not *loaded* together.

```
▼ 对话渠道                    453 个 · 可用 447 · 冷却 6 · 关闭 0
    ▼ 硅基流动 (siliconflow)     65 个 · 可用 63 · 冷却 2 · 关闭 0   [关闭本渠道]
        ● deepseek-v4.1-flash   冷却中   retry in 511m · rate-limit      [关闭]
    ▶ cline                    55 个 · 可用 55 · 冷却 0 · 关闭 0   [关闭本渠道]
▶ 识图模式（vision-router 创建）  453 个 · 可用 0 · 冷却 0 · 关闭 453
```

| Column | Meaning |
|--------|---------|
| dot + label | `可用` (nothing resting, no failure on record), `未测` (never tried), `冷却中`, `额度耗尽` (until the next-day boundary), `异常` (last attempt failed), `已关闭` |
| detail | TTFT and success/attempt counts, or the remaining rest, or why the row is out of rotation |
| switch | 关闭 / 启用 |

The reasons a row can be out of rotation are named rather than collapsed:
`manual` (switched off here), `vision` (the vision-router twin, a default the
switch can overrule), `provider` / `excluded` (from `config.json`),
`non-chat` (a family that cannot answer a chat turn), `combo` (a virtual
route). Only the first two are switchable from the page — the rest are
structural or owned by the file.

The roster reads its data over HTTP rather than through the settings form. Its
route is `/_dsh/model-rotator/models`: `GET` returns the grouped list
(`groups` = the two sections, `channels` = one entry per provider carrying its
`kind` and the `sourceChannel` a twin wraps, `models` = every row; a section and a
channel carry the same `models`/`ok`/`resting`/`off` counters, so one row shape
renders both and a folded line still reports its state),
`POST {key, enabled, scope}` flips one switch and answers with the refreshed list
(`scope: "provider"` for a channel header, omitted or `"model"` for a row). The
form carries the user's *policy* (how many candidates, how long to wait), while
this is a *roster* that changes whenever a provider republishes — and its rows
save one at a time, straight to `config.json`, so a refresh cannot discard a
half-typed number above it. The route is registered through
`ctx.inject(['webServer'], …)` because the host publishes the web server
*after* plugins load; it is auth-gated by the host exactly like every other
non-public path.

The two layers merge as **defaults < config.json < settings page**, and the page
wins only for the keys it actually owns: a key the page never sets still comes
from the file. `model_rotator_select` never writes a page-owned key back into
`config.json`, so a stale file value can never masquerade as authoritative.

The namespace is the plugin's cordis id (`model-rotator`) — a server half
without a client half shows nothing, which is why both ship together. A host
that ships no generic settings form has to be given one: the page is the
plugin's own React form, so the fields above are exactly the ones this bundle
stages, not every key the `Config` schema accepts.

The `Config` export needs schemastery *inside the host process*. The plugin
ships its own copy under `vendor/node_modules/` and loads that copy by absolute
path when a bare import cannot be resolved from the plugin's real path, which is
what makes the page appear on installs where the manifest link resolves outside
the profile's `node_modules`.

`model_rotator_status` ends with an **in force right now** block that lists the
merged value of every effective key next to the layer it came from
(`[default]`, `[config.json]` or `[settings page]`), so what is actually
driving the plugin is visible without reading two files and doing the merge in
your head. Further lines report the live picture: `ask channel` (whether the
pre-switch question can actually reach you, and why not when it cannot),
`adopt on switch`, `model in use now` (read from this session's request
header), `session switch` (whether the plugin can record the swapped model on
the session), `failure verdict` and `switch order`.

## Install

From npm (recommended):

```
dsh plugin --profile desktop add dsh-model-rotator
```

From GitHub:

```
dsh plugin --profile desktop add github:chimneyQ/dsh-model-rotator
```

From a local checkout, the same command takes the directory instead:

```
dsh plugin --profile desktop add <path-to-this-directory>
```

The package declares `dsh.bundle.patch`, so its `cordis.patch.yml` wires the
plugin automatically, and it has no dependencies to build. A full app restart is
required for the host to load it.

To confirm the host actually wired it up (a failed first install can leave the
dependency recorded without adding the plugin to `dsh.profile.bundles`), check
that `dsh.profile.bundles` in `<DSH_HOME>/profiles/desktop/package.json` lists
`dsh-model-rotator`.

## Test

```
node test-offline.mjs     # failover + consent gate, against a stub harness
node test-settings.mjs    # server-side settings contract, against the host rules
node test-client.mjs      # browser bundle: loader shape, card registration, fields
```

All three run with no network and no DSH process. `test-offline.mjs` (135
assertions) covers failure-then-retry, no-retry-once-text-flows, image-turn skip,
all-candidates-failed, cooldown accounting, aborted-signal passthrough,
non-chat filtering through a real waterfall, tool registration, and the consent
gate (prompt off, approved, declined by button and by typed text, timeout,
one-question-per-walk, and every fail-open path). Failure classification and the
quota rest are asserted through the exported `classifyFailureKind()` and
`quotaRestUntil()` seams — day boundaries, the pre-midnight floor, a month
rollover, "a quota wall never burns a retry", "an unsupported request is not
retried", and the on-disk round trip including TTL expiry and a malformed file.
The non-chat assertions call the exported `isNonChatModelId()` seam so they
test the shipped pattern table rather than a copy of it.

Two later scenarios pin the defects fixed after the first live run: **16** — a
`-vision` provider is never dialed, while a *model named* something-vision
stays a candidate, and switching a twin back on really does restore it; and
**17** — a reasoning-only attempt still gets its retries, text still closes the
walk, and an empty `block-start` counts as nothing. The list route is driven
end to end in **14** through an opt-in HTTP harness (GET, POST, the file write,
a bare model id, an empty key, a hand-edited file, and the whole channel switch
including its precedence rules). **16** additionally
asserts the two page sections — the twins counted apart from the chat channels,
each naming the channel it wraps — and **15** that a `purpose: "compaction"` call
is passed through untouched while an ordinary turn still fails over.

Two more offline cases cover the record itself: a stored `lastErrorKind` is
re-derived from its prose when the file is loaded, so a pattern added in a later
build relabels the history it was written for (a stored quota wall keeps resting
until tomorrow instead of being retried the moment it is read back); and a failure
payload that arrives as an object is serialised rather than stringified into
`[object Object]` — unreadable, and unclassifiable, which would cost a real quota
wall its daily rest.

**18** covers the switch notice: the message shape the session accepts (a
`user/message` with form `notice`, a fresh id, a summary inside the host's
120-character bound), the vendor-name bug above, the turn-boundary delivery
through `agent.steer`, one notice per switch rather than per boundary, no notice
in a subagent transcript, none on an aborted turn, and the off switch.

Persistence makes the suite order-sensitive by nature: a cooldown that survives
the process would let scenario 5's dead keys decide scenario 9's candidate
order. Every harness therefore mounts onto a stats file of its own, and the two
that mean to assert across applies opt into sharing one explicitly.

`test-settings.mjs` (34 assertions) asserts the host's own rules, not this
plugin's opinion of them: it copies the shipped `volatileForm()` walk and
checks that the exported `Config` yields exactly the intended page fields
(a non-volatile sibling is dropped), and that the page outranks `config.json`
for the keys it owns while the file still fills the rest. It loads the host's
real `schemastery` and `cosmokit`, so `createVolatile()` handles behave
exactly as they do in the app.

`test-client.mjs` (44 assertions) runs `client.js` against a stub module
loader: the `window.__ModuleLoader__.load()` shape, the exported `apply` /
`inject`, the two cells (`settings.section` and `plugins.item`) registered for
the `model-rotator` namespace, and — the anti-drift check — that the fields the card renders and
stages are exactly the volatile fields the schema walk above yields. A field the
bundle forgets to stage is a setting nobody can edit; one it invents throws
`plugin card has no field <name>` inside the real form.

Its last block goes further than source matching: it renders the roster with a real
hooks runtime (state, effects, memoized callbacks, re-renders) against a payload
shaped like the host's, presses the buttons a reader would press, and asserts what
comes back — both sections, the derived tally, the folded and expanded states of
each fold level, and that the list is fetched exactly once. A regex can prove a
feature is mentioned; only a render proves it works, and this is what caught a
re-fetch loop the source checks could not see.

## License

MIT
