# Changelog (dsh-model-rotator)

> [简体中文](./CHANGELOG.zh.md) | **English**

User-visible changes, newest first. Commit hashes in brackets.

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
