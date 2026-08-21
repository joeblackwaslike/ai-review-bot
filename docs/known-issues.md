# Known Issues in Published Releases

**As of August 19, 2026, npm ships `0.3.0`**, which includes every fix listed below — this page
is now a historical record, not an active caveat. If you're on `0.1.0` or `0.2.0`, upgrade
(`npm install ai-review-bot@latest`) rather than building from `main`.

## Bugs present in the published releases, fixed on `main`

These four bugs were in code that already existed at the `0.2.0` tag — anyone who installed
`0.1.0` or `0.2.0` was exposed to them.

| Severity | Symptom | Fixed by |
| --- | --- | --- |
| P1 | Review posts nothing and the webhook still returns 202 when every agent throws — a total silent failure with no visible error anywhere | [PR #31](https://github.com/joeblackwaslike/ai-review-bot/pull/31) |
| P1 | Codex bot produces no reviews at all — `AI_NoObjectGeneratedError` on every agent | [PR #19](https://github.com/joeblackwaslike/ai-review-bot/pull/19) |
| P1 | No idempotency claim before agents run — concurrent triggers could post duplicate reviews on the same PR | [PR #18](https://github.com/joeblackwaslike/ai-review-bot/pull/18) |
| P1 | Review body rendered as one giant Markdown heading (setext-heading corruption) instead of the intended sections | [PR #48](https://github.com/joeblackwaslike/ai-review-bot/pull/48) |

## Bugs in features added after `0.2.0` (never shipped in a published release)

These six were introduced and fixed entirely on `main`, in code that didn't exist yet at the
`0.2.0` tag (the QStash scheduler, the reaction/feedback signal system, and the incremental-review
triage gate were all added afterward). No published version was ever exposed to them — listed
here for completeness and because they explain a lot of `main`'s recent history, not as a reason
to avoid `0.2.0`.

| Severity | Symptom | Fixed by |
| --- | --- | --- |
| P1 | QStash `deduplicationId` contained a `:`, so every scheduled-review publish failed and the scheduler silently fell back to the legacy inline path on every PR | [PR #30](https://github.com/joeblackwaslike/ai-review-bot/pull/30) |
| P0 | Codex bot misreported "out of credits" as a generic rate limit (both arrive as HTTP 429) — masked a billing problem as a transient retry-later error | [PR #36](https://github.com/joeblackwaslike/ai-review-bot/pull/36) |
| P1 | The 😕 "confused" reaction on a finding was silently dropped from the signal model instead of being tracked as a distinct verdict | [PR #32](https://github.com/joeblackwaslike/ai-review-bot/pull/32) |
| P1 | Blocking (`REQUEST_CHANGES`) reviews rendered no reason on the incremental re-review path — a review could block a merge with no visible explanation | [PR #54](https://github.com/joeblackwaslike/ai-review-bot/pull/54) |
| P1 | Summary prose could contradict the "Still open" carry-forward table across re-reviews — misleading about whether a finding was actually resolved | [PR #61](https://github.com/joeblackwaslike/ai-review-bot/pull/61) |
| P1 | Stuck-loop / incremental-review-state issue — the bot could keep re-flagging findings across re-reviews instead of recognizing they'd already been addressed | [PR #21](https://github.com/joeblackwaslike/ai-review-bot/pull/21), [PR #22](https://github.com/joeblackwaslike/ai-review-bot/pull/22) |

See also the dedicated post-mortems for the two most severe historical incidents:

- [Post-mortem: OpenSSL PKCS#1](/post-mortem-openssl-pkcs1) — total loss of review output on first deploy
- [Post-mortem: Reviewer Hallucinations](/post-mortem-reviewer-hallucinations)

## Why there's no newer tag yet

This list exists because publishing was tracked separately from fixing — bugs got fixed and
merged to `main` without a corresponding version bump + `npm publish`. Cutting a new release
(`v0.3.0`+) is the real fix for this page needing to exist at all; this table is a stopgap until
that happens.
