# Known Issues in Published Releases

**npm currently ships `0.2.0` (tagged 2026-06-04).** `main` is 48+ commits ahead of that tag as
of 2026-08-12, and includes fixes for several P0/P1 bugs — some of them silent-failure bugs,
meaning a `0.2.0` install can fail without any visible error. There is no newer tagged/published
release yet.

**If you're running `0.2.0` (or `0.1.0`) today:** build from `main` instead of `npm install
ai-review-bot` until a new version is tagged, especially if you're seeing reviews go missing,
duplicate, or render incorrectly — it's very likely one of the bugs below.

## Fixed since 0.2.0 (not yet in a published release)

| Severity | Symptom | `bd` ticket | Fixed by |
| --- | --- | --- | --- |
| P1 | Review posts nothing and the webhook still returns 202 when every agent throws — a total silent failure with no visible error anywhere | `ai-review-bot-hs1` | [PR #31](https://github.com/joeblackwaslike/ai-review-bot/pull/31) |
| P1 | Codex bot produces no reviews at all — `AI_NoObjectGeneratedError` on every agent | `ai-review-bot-ihu` | [PR #19](https://github.com/joeblackwaslike/ai-review-bot/pull/19) |
| P1 | QStash `deduplicationId` contained a `:`, so every scheduled-review publish failed and the scheduler silently fell back to the legacy inline path on every PR | `ai-review-bot-e2m` | [PR #30](https://github.com/joeblackwaslike/ai-review-bot/pull/30) |
| P1 | No idempotency claim before agents run — concurrent triggers could post duplicate reviews on the same PR | `ai-review-bot-33t` | [PR #18](https://github.com/joeblackwaslike/ai-review-bot/pull/18) |
| P0 | Codex bot misreported "out of credits" as a generic rate limit (both arrive as HTTP 429) — masked a billing problem as a transient retry-later error | `ai-review-bot-n0h` | [PR #36](https://github.com/joeblackwaslike/ai-review-bot/pull/36) |
| P1 | The 😕 "confused" reaction on a finding was silently dropped from the signal model instead of being tracked as a distinct verdict | `ai-review-bot-nm4` | [PR #32](https://github.com/joeblackwaslike/ai-review-bot/pull/32) |
| P1 | Review body rendered as one giant Markdown heading (setext-heading corruption) instead of the intended sections | `ai-review-bot-z1e` | [PR #48](https://github.com/joeblackwaslike/ai-review-bot/pull/48) |
| P1 | Blocking (`REQUEST_CHANGES`) reviews rendered no reason on the incremental re-review path — a review could block a merge with no visible explanation | `ai-review-bot-twg` | commit not identified by title search — `bd show ai-review-bot-twg` |
| P1 | Summary prose could contradict the "Still open" carry-forward table across re-reviews — misleading about whether a finding was actually resolved | `ai-review-bot-ise` | [PR #61](https://github.com/joeblackwaslike/ai-review-bot/pull/61) |
| P1 | Stuck-loop / incremental-review-state issue — the bot could keep re-flagging findings across re-reviews instead of recognizing they'd already been addressed | `ai-review-bot-9nv` (epic) | `bd show ai-review-bot-9nv` for the linked PRs |

Run `bd show <ticket>` in this repo for the full incident writeup and root cause where one was
recorded. See also the dedicated post-mortems for the two most severe historical incidents:

- [Post-mortem: OpenSSL PKCS#1](/post-mortem-openssl-pkcs1) — total loss of review output on first deploy
- [Post-mortem: Reviewer Hallucinations](/post-mortem-reviewer-hallucinations)

## Why there's no newer tag yet

This list exists because publishing was tracked separately from fixing — bugs got fixed and
merged to `main` without a corresponding version bump + `npm publish`. Cutting a new release
(`v0.3.0`+) is the real fix for this page needing to exist at all; this table is a stopgap until
that happens.
