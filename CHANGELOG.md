# Changelog (dsh-model-rotator)

> [简体中文](./CHANGELOG.zh.md) | **English**

User-visible changes, newest first. Commit hashes in brackets.

## 0.2.7
- **Fixed: a compaction that ran out of quota ended the whole turn.** The compaction summary is the first call a long conversation makes, so when the current model's balance was gone it was the first thing to fail — and it was on the do-not-fail-over list, which meant the refusal was passed straight through and the turn died before the answer existed. Compaction now walks the candidate list like any other dead route: the summary is written by the next model and the turn continues. A session title still stays on the model that was asked, because a caption nobody waits on is not worth a second provider.
- **Fixed: the switch question no longer parks a summary.** Asking "switch model?" before a compaction would have shown a modal about plumbing the reader is not watching, and on timeout it switched anyway. Compaction switches proceed unconfirmed; the reader still learns about it from the ordinary switch notice at the turn boundary.
- **Unchanged on purpose: compaction never adopts the switched model.** A summary that fails because the context is too large for this model says nothing about the model's fitness for the conversation. Adoption is left to the conversation attempt, which makes the same call on the right evidence.
- 168 offline assertions, with three negative controls proving each new exclusion is what makes its assertion pass.

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
