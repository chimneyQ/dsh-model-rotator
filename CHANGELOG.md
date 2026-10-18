# Changelog (dsh-model-rotator)

> [简体中文](./CHANGELOG.zh.md) | **English**

User-visible changes, newest first. Commit hashes in brackets.

## 0.2.14
- **A pinned head that cannot be resolved is now reported as ignored.** Ordering only promotes the pinned pair when it is actually among the candidates and not cooling down, but the status line printed the raw string either way — so `pinned head: nonexistent/nope` read as if it were in effect. It now says `(not among the N candidates - ignored)` or `(cooling down - ignored for now)`.
- Cleared a stray test value (`nonexistent/nope`) from this machine's config so the status no longer carries a fake head.
- Suites: offline 194, client 102, settings 35, pin-cooling, release gate 23.

## 0.2.13
- **Fixed: `model_rotator_benchmark` crashed whenever a probed model failed.** The benchmark's failure branch read a variable named `failedBecause` - the name the *walk* uses for its failure text - while the benchmark's own text lives in `failure`. Probing any unhealthy candidate therefore threw `ReferenceError: failedBecause is not defined` instead of reporting the failure, which is precisely the case the tool exists to measure. The value now comes from the local `failure`.
- **Tests: registration is not execution.** The benchmark was asserted to *exist* in the registry and never once called, which is how the above shipped through 192 green assertions. `6b`/`6c` now call it on a failing candidate and require both the summary and the recorded `FAIL`; reverting the fix fails them at once.
- 194 offline assertions, 102 client, 35 settings.
## 0.2.12
- **Fixed: a failover could move a conversation onto a route too small to hold it.** A model can be perfectly healthy and still be the wrong place to continue *this* conversation: the request then overflows the route's context window and the turn dies - and the compaction that could have shrunk the conversation cannot run either, because the summary is requested on that same route. Live case: a conversation ~450k tokens long, running on a 1M-window route, was switched to a route whose window is 262k; from then on every turn ended on `MAX_TOKENS` with a 1-token reply, and eight consecutive compactions failed with "summarization truncated at the token cap". The ranking now drops candidates that cannot hold the conversation as it stands: pressure comes from the host's token meter, the window from the adapter that owns the route (`ctx.llm.resolveModelInfo()` - a profile *declaration* is not a dispatch), and a candidate is held back only when it is smaller than pressure + 32 768. Nothing is rejected on a number the plugin does not have: no pressure reading means no guard, an unpublished window means no opinion, and a route on the same window as the current one is exempt because the guard decides about *moving*. The model list names `window` as the reason, and `model_rotator_status` prints the pressure it acted on.
- **New setting: `windowGuard`** (default on, settings page toggle). Turn it off to make every discovered model a candidate again, whatever its size.
- 192 offline assertions (21a-21g are the new guard cases, including the "guard off", "no reading" and "unpublished window" controls), 35 settings assertions, **102 client assertions**.
## 0.2.11
- **Fixed: the Model switches tab could not tell which conversation it was in.** Both 0.2.9 and 0.2.10 read the id as `sessions.list.getSnapshot().current` - a field that store never carried (it exposes `ids` / `byId` / `phase` / `projectionsBySession`; `current` belongs to the `uiSession` service instead). The tab now declares the Host's own inject contract, `inject: (sessionId) => ({ sessionId })`, and reads `props.sessionId` - the same thing the built-in 对话 and 轨迹 tabs do; the service read is kept only as a best-effort fallback for a Host that injects nothing. Until this, the tab always degraded to the unfiltered log, which is what the reader saw: an empty-state line next to the "conversation not identified" banner.
- 185 offline assertions, **102 client assertions** (6j-6l pin the inject contract and prove an injected id outranks a service-reported one).
## 0.2.10
- **Fixed: a switch was recorded against the wrong conversation.** The 0.2.9 tab files records per conversation, but the owning session was read at the **turn boundary** (`agent/turn-stopping`) while the pending queue is **process-wide**. A conversation whose turn never stops therefore left its switch in that queue, and the *next* conversation to stop a turn drained the batch and stamped it with its own name. Reproduced live: conversation A's switch was filed under conversation B, so A's own tab read "no model switches in this conversation" - history that looks empty. The record is now written **where the switch happens**: the `llm/stream` candidate branch resolves the initiating agent's session through `ctx.get('agents').currentInitiator()` (the same seam adoptServedModel already trusts) and appends at/from/to/purpose/reason with it. The turn boundary now only decides whether to *also* post the in-conversation row.
- **Fixed: a switch with no resolvable session is no longer lost.** A plugin route, or a host without `agents`, has no live turn: the record is still written with an empty session (visible in the every-session view only), without throwing or warning.
- **Fixed: the tab no longer shows "nothing here" over a non-empty log.** When the requested conversation returns zero rows but the log total is not zero, the tab falls back to the full history and says so (new `switches.fallback` copy) instead of claiming there were no switches.
- **Deliberately unchanged**: the log is still in-memory (lost on restart), subagent turns still write no root record, and the every-session view still does no per-conversation isolation.
- 185 offline assertions (scenario 20 rewritten as 20a-20m, adding the cross-talk regression and the no-live-turn case); 99 client assertions.

## 0.2.9
- **New: a switch is recorded on its own tab instead of being spent on context.** The record used to exist only as a notice row inside the conversation, which cost context for a plumbing fact the reader may not have been looking at — and when the row was turned off there was no record at all. Switches now land on a **Model switches** tab beside 对话 / 轨迹 / 上下文, one row each: when, from which model to which, and why. The tab reads the plugin's own log (`GET /_dsh/model-rotator/switches?session=<id>`), so nothing is added to the conversation. Records are filed per conversation — the host hands no session to a plugin route, so the session is bound at the turn boundary, the one moment that both sees the switch and knows whose it was.
- **Changed: the in-conversation row is now opt-in** (`noticeSwitch` defaults to **off**). The tab is the record; turning the setting on additionally posts the old line in the transcript.
- **Fixed: a deterministic dead end no longer asks before switching.** A balance that is gone will not come back inside the 10 s window, and a request the provider refuses as unsupported is refused identically on the next dispatch — declining there could not have kept the model, so the question only cost a card and a wait. `quota` and `unsupported` now switch on their own. **Auth deliberately still asks**: a 403 is often a burst-rate proxy that clears, so keeping the model is a real choice there.
- 179 offline assertions. The dead-end rule has its own negative control: if the gate had simply been removed, the auth assertion would stop asking too. [`12fe8bf`]

## 0.2.8
- **Fixed: the switch notice named the wrong reason.** The line says "A → B", so the reason has to be why A went away — but it was read from the last failure the *walk* saw, which by then belongs to whichever candidate failed just before the winner. With one dead model those are the same string; with two they are not, and a balance wall on the starting model was announced as "(network)" because the channel tried after it had a socket reset. The reason now comes from the starting model's own failure. Observed live on 2026-10-18: 魔塔 was out of balance, nvidia answered, and the notice blamed the network.
- The fallback to the last failure is kept for the case where the starting model never reported one (a host refusal, an aborted turn), so the notice stays populated.
- 169 offline assertions; the negative control reverts to the old source and fails exactly this assertion, reproducing the "(network)" wording. [`79a8d5a`]

## 0.2.7
- **Fixed: a compaction that ran out of quota ended the whole turn.** The compaction summary is the first call a long conversation makes, so when the current model's balance was gone it was the first thing to fail — and it was on the do-not-fail-over list, which meant the refusal was passed straight through and the turn died before the answer existed. Compaction now walks the candidate list like any other dead route: the summary is written by the next model and the turn continues. A session title still stays on the model that was asked, because a caption nobody waits on is not worth a second provider.
- **Fixed: the switch question no longer parks a summary.** Asking "switch model?" before a compaction would have shown a modal about plumbing the reader is not watching, and on timeout it switched anyway. Compaction switches proceed unconfirmed; the reader still learns about it from the ordinary switch notice at the turn boundary.
- **Unchanged on purpose: compaction never adopts the switched model.** A summary that fails because the context is too large for this model says nothing about the model's fitness for the conversation. Adoption is left to the conversation attempt, which makes the same call on the right evidence.
- 168 offline assertions, with three negative controls proving each new exclusion is what makes its assertion pass. [`c5590ef`]

## 0.2.6
- **Fixed: other channels of the same model were deduplicated out of the walk.** This is the real problem 0.2.5 uncovered once the classification was right: when WorkBuddy met its quota wall, **buddy and trae — the same model on other channels — were healthy**, but "one channel per model family" kept them out of the candidate list entirely, so the turn ended on the quota error with a working route sitting one slot away. A family now keeps up to **two channels**: the ranked winner plus one proven-usable backup. A cooling backup is dropped, since dispatching it would walk into the same wall. The switch notice is already deduplicated by model id, so arriving at a second channel of the same model is not announced as "switched to the same model again".
- Measured: before the fix the walk held one channel of `deepseek-v4.1-flash` and `buddy` (ok=1538, healthy) was absent; after it holds three and `buddy` is back. [`fed9508`]

## 0.2.5
- **Fixed: an exhausted quota read as a rate limit, so the switch never happened.** WorkBuddy answers "可用账号均在限流中，最近一个将于 … 解禁" — every account exhausted. Classified as `rate-limit` it cooled for 60 seconds and retried the same wall; one evening accumulated 702 failures. An account pool that is entirely unavailable is now recognised as `quota` and rests like any other balance wall.
- **New: the release time is parsed out of the message.** When the provider states when it comes back, that beats any calendar policy. `parseReleaseTime()` accepts `2026/10/18 00:29:52`, `2026-10-18 00:29:52` and ISO forms; a parsed time becomes the exact cooldown (measured here: 60 seconds became 1.7 hours), and only an unparseable message falls back to the next-day rule.
- **Fixed: a switch was not persisted.** The switch notice was queued and then returned, so `scheduleStatsSave()` never ran — a restart showed the old model still in use. The save happens with the enqueue now.
- **Improved: a pin defers while it cools.** A model pinned with `model_rotator_select` took the head on every turn even while cooling, so every turn opened by walking into the same wall. The pin now applies only while the model is healthy; the ranking decides during cooldown and the pin returns by itself afterwards. [`a2d5a0c`]

## 0.2.4
- **Docs**: adds this bilingual changelog, listed in the manifest and gated by release-check; the README and repository description were refreshed too. The npm package now carries the changelog with each release. Also fixes a crash in this gate: the SHA check fed a comment line to readFileSync, so the gate died with ENOENT and hid every other check behind it. [`fc14e99`]

## 0.2.3
- **Fixed**: in the model-list search, a one-character term inside a multi-term query was almost unconstrained (25 of 36 characters matched some name; `a b` returned 264 and `d s` 528) — it is now anchored to the start of a word, while a lone `a` still searches the whole table as a substring. Measured: `a b` 264→2, `d s` 528→42, `flash a` 182→36, `ds fl` unchanged at 309. [`5aec752`]

## 0.2.2
- **New**: matching now normalises first (case and separators) and ranks hits by quality, with exact matches first.
- **New**: a length-guarded subsequence fallback, so a query without separators still reaches a hyphenated name (`ds-flash`); a single character does not trigger it. [`b9c9e57`]

## 0.2.1
- **New**: queries are split on whitespace and matched token by token with AND (previously one substring over the whole query), which sharpens multi-word results considerably across 950 models. [`f04d13f`]

## 0.2.0
- **New**: a search box for the model roster, with a hit counter and a clear button. [`c691a4f`]
- **Fixed**: two counters — one read data that was still `null` and showed "1 / 0"; the other walked only the flat model list and reported "no match" while rows were plainly visible when the host omitted that field.
- **Fixed**: the schema loader accepted a copy on the strength of `object()` alone, and this machine carries a stale copy under the user home without `.volatile()` that was resolved first, so Config threw at load; it now capability-tests the exact chain.
- **Fixed**: the tests imported the dev tree through a hardcoded absolute path, so the published bytes were never covered by their own suites; all suites are self-relative now. [`6de1b05`]

## 0.1.0 (with the 0.1.x fixes folded in)
- First release: ranks the models an install has already discovered by measured connectivity and speed, and switches to the next candidate inside the same turn when the current one fails without producing any output; ships a channel-grouped model list with per-channel switches.
- Fixed: `ctx.llm` is resolved once and reused, so discovery and dispatch survive a deactivated fiber; keep dispatching after deactivation; one candidate per model family and one notice per destination. [`78431f7` `1c52df1`]
- Fixed: a **plugin-internal** dispatch error was recorded as model evidence and restored as one; the two are now distinguished. [`4a50ba9`]
- Fixed: a healed stats row was not written back to disk; it is written back, and saved when healed. [`1174bc0`]
- Fixed: **a host-side refusal is not evidence about the model** — refusals raised at the provider boundary by the harness or another plugin were written into the route's counters, cooling down a channel that had done nothing wrong and overwriting the real provider failure; they are dropped now (no failures, no cooldown, no lastError). [`ac87505`]
- Fixed: a host-side refusal still went through the whole retry budget and exponential backoff (measured: four dispatches and 1.8s of sleeping); it now stops after one dispatch. [`8c5ec94`]
