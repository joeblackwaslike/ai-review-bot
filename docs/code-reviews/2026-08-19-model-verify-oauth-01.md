---
title: "Code Review — local changes"
date: 2026-08-19
timestamp: 2026-08-19T17:31:56.267Z
status: reviewed
scope: local-changes
remote: https://github.com/joeblackwaslike/ai-review-bot
duration_seconds: 728
cost_usd: 2.421372
providers: ["anthropic", "openai"]
models: ["claude-sonnet-5", "gpt-5.6-terra"]
skills: ["code-reviewer", "silent-failure-hunter", "pr-test-analyzer", "security-sast", "code-review-and-quality"]
files_reviewed: 14
findings:
  high: 3
  medium: 5
  low: 24
---

# Code Review — local changes

## Table of Contents

- [Summary](#summary)
- [Findings](#findings)
- [Inline Notes](#inline-notes)
- [Metadata](#metadata)

## Summary

Reviewed **14** file(s) (local-changes) with anthropic + openai. Found **49** item(s): 3 high · 5 medium · 24 low. Took 728s · $2.4214.

## Findings

### 1. 🟢 [LOW] Review is test-only; no production source changes to audit

All 8 files reviewed are test files (audit.test.ts, check-run.test.ts, github-app.test.ts, improve/qc.test.ts, models.test.ts, report.test.ts) plus two production files (improve/qc.ts, models.ts) that appear unchanged relative to their tests and contain no obvious defects. The test suites are thorough, well-documented with rationale comments explaining regressions they guard against, and exercise meaningful edge cases (pagination caps, whitespace drift, error propagation, idempotency). No material issues found at ≥80% confidence.

### 2. 🟢 [LOW] Test files only in this diff — no production error-handling changes to audit directly

This diff consists entirely of test files (audit.test.ts, check-run.test.ts, github-app.test.ts, qc.test.ts, models.test.ts, report.test.ts) plus two production source files that are largely typed helpers with narrow, well-reasoned error handling (models.ts, qc.ts). The tests strongly document (via comments) a series of prior incidents around silent failures, duplicate posts, and ambiguous retry/verify states, and each corresponding fix appears to have been validated by an accompanying regression test (e.g., 'preserves the original error as cause', 'refuses to retry ... when it cannot verify', 'propagates a non-request error from the local scan instead of swallowing it'). No new empty catch blocks, unjustified fallbacks, or silently swallowed errors were introduced by the reviewed files themselves.

### 3. 🟢 [LOW] qc.ts: isProgrammingError narrow-catch rethrow logic looks sound but is worth flagging for future maintenance

In src/improve/qc.ts, `judgeFinding` deliberately rethrows only `TypeError`/`ReferenceError` and swallows everything else (recording as unjudged) with a documented rationale (SyntaxError/RangeError being expected from the AI SDK on malformed responses). This is a reasonable, well-justified design and is exercised by qc.test.ts's summarize/formatQcComment tests distinguishing outages from real failures. No action needed, but flagging as a note: if the AI SDK later throws other error subclasses for genuine misconfiguration (e.g. an `Error` wrapping a bad model name), those would currently be silently recorded as 'unjudged' rather than surfaced as a config bug. Low-severity/no action — the current trade-off is explicitly documented and acceptable given the code comment's stated reasoning.

### 4. 🟢 [LOW] No material security issues found in this diff

This PR consists entirely of test files and pure-function implementation modules (audit.test.ts, check-run.test.ts, github-app.test.ts, improve/qc.test.ts, improve/qc.ts, models.test.ts, models.ts, report.test.ts). No SQL construction, shell execution, file path handling from user input, deserialization of untrusted data, or DOM manipulation is present. Secrets are read from environment/config (auth objects) or are clearly test fixtures ("k", "tok", "pem") rather than hardcoded production credentials.

### 5. 🟢 [LOW] OAuth token/fetch handling in models.ts is a reasonable design but worth a light sanity note

In models.ts, createAIModel passes a placeholder apiKey ("oauth") for Anthropic OAuth mode with a comment stating the custom fetch deletes the resulting x-api-key header — this is a sound pattern to avoid leaking a bogus key, but it depends entirely on `auth.fetch` correctly stripping/replacing headers on every request path (including retries within the AI SDK). Since `auth.fetch` is external to this diff and not shown, no runtime issue can be confirmed here, but it's worth confirming test coverage exists elsewhere for the header-stripping behavior itself (not just that it's called).

### 6. 🟢 [LOW] Test-only review: no production source changes visible

This diff consists entirely of test files (audit.test.ts, check-run.test.ts, github-app.test.ts, qc.test.ts, models.test.ts, report.test.ts) plus two source files (models.ts, qc.ts) that appear to be included only as read-only context for the tests. Without the corresponding source diffs for audit.ts, github-app.ts, check-run.ts, report.ts, and commands.ts, it's not possible to verify most of the behavior these tests assert against (e.g., the marker-migration logic in injectPRSection, the peer-gate logic in runScheduledReview, or the writeArtifacts error wrapping). The review below is limited to what can be inferred purely from the test files and the two included source files.

### 7. 🟢 [LOW] TOKEN_RATES lacks a fallback/alert for unknown models silently returning $0 cost

In models.ts, `computeCost` returns 0 for any model not present in `TOKEN_RATES` (confirmed by the models.test.ts "unknown-model-xyz" case). This is intentional per the test, but it means a typo in a model name, or a new model added to router.ts without a corresponding TOKEN_RATES entry, will silently report $0 cost in metadata/reports rather than surfacing as an error or warning. Since cost tracking appears to be relied upon for budget/quota logic elsewhere in the codebase (see qc.ts's `outputBudget`), consider at least logging a warning when an unmapped model is priced, so a missing-rate bug doesn't silently mask real spend.

### 8. 🟢 [LOW] qc.ts: judge failure classification may misclassify some legitimate SDK errors as programming errors

`isProgrammingError` treats any `TypeError` or `ReferenceError` as a non-retryable programming bug and rethrows it, aborting the whole judging run. The comment acknowledges the AI SDK could throw a `TypeError` for reasons unrelated to a code defect (e.g., a malformed but unexpected response shape), and accepts that tradeoff. This is a reasonable, documented tradeoff, but worth flagging as a low-confidence risk: if the AI SDK's error taxonomy changes (e.g., starts using `TypeError` for a validation failure), this could turn a transient provider issue into a hard crash of the whole QC batch instead of recording it as unjudged. Consider narrowing further (e.g., checking `err.message`/`err.name` for SDK-specific error markers) if this proves noisy in practice.

### 9. 🟢 [LOW] Large, well-structured test file - no material issues found

This is a single test file (review.test.ts) covering review.ts logic extensively (mergeReviews, buildReviewComments, buildReview, runAgent, generateSummary, classifyRefusal, triage gating, provenance, markdown formatting, auth threading, etc). The tests are thorough, well-documented with explanatory comments describing regressions and rationale, and consistently use mocks/fixtures from testing.js. No bugs, anti-patterns, or CLAUDE.md violations were identified within the scope of this file alone. Since only the test file was provided (not the corresponding review.ts implementation), it's not possible to verify that assertions like exact call counts (e.g., 'toHaveBeenCalledTimes(6)') or string matches (e.g., 'Partial review', 'ground truth') will remain accurate against the implementation, but nothing within the test file itself indicates a defect.

### 10. 🟢 [LOW] Comprehensive, behavior-focused test suite with well-documented regressions

This is a very thorough test file covering merge/dedup logic, comment anchoring/validation, provenance tracking, rate-limit and quota classification, time-budget partial runs, triage-gate carry-forward semantics (INCREMENTAL/FULL/SKIP), markdown formatting regressions, and auth threading. Nearly every test includes a comment explaining *why* the test exists and what regression it guards against, which is excellent for maintainability. Tests generally assert on observable behavior (event, body content, comment sets) rather than internals, and several tests explicitly include a 'control' case (e.g. 'does approve the same clean result when every agent ran') to prove the assertion isn't vacuously true — a strong practice.

### 11. 🟢 [LOW] Some tests rely on generateObject call-count/order fragility

Several tests (e.g. 'skips duplicate reviews...', Tier 2 gate tests, 'runs every agent...') hardcode exact `mockResolvedValueOnce` chains and exact `toHaveBeenCalledTimes(N)` counts tied to `TIER1_SKILLS.length` (5) plus a fixed summary call. If TIER1_SKILLS grows/shrinks, many of these will fail with the wrong root-cause message (mock exhaustion) rather than a meaningful assertion failure. This is already partly mitigated in later tests (`reviewer tuning wiring`, `strict evidence rules propagation`) which key off `TIER1_SKILLS.length` dynamically — the same pattern could be applied to the earlier fixed-count tests for consistency, but this is a low-cost/low-value refactor, not a correctness gap.

### 12. 🟢 [LOW] No direct test for computePaceDelayMs floor/threshold boundary

`computePaceDelayMs` tests cover 'plenty of tokens' (25000), 'below the floor' (500), retry-after cap, undefined info, past reset, and malformed timestamp — but there's no test exactly at the floor boundary (e.g. remaining tokens exactly at whatever threshold triggers pacing). This is a minor edge case; given the other boundary tests present, the risk of an off-by-one regression slipping through is low but non-zero. Rated 3/10 — nice-to-have, not blocking.

### 13. 🟢 [LOW] Test-only file, no material security findings

This is a Vitest test file for the review-building logic (src/review.ts). It contains mocked API keys/tokens (e.g. "pem", "secret", auth `token: "tok"`), but these are clearly test fixtures/mocks, not real credentials, and pose no material security risk. No SQL injection, XSS, path traversal, command injection, insecure deserialization, or hardcoded-secret patterns applicable to this SAST framework were found in production code paths. No inline comments are warranted.

### 14. 🟢 [LOW] Very large, well-structured test file; no material issues found

This is a test-only file (`src/review.test.ts`) adding/covering extensive behavior for `review.ts`: merge/resolution logic, comment anchoring, tier gates, rate-limit/quota classification, agent time budgets, markdown body formatting, and provenance tracking. The tests are detailed, use clear regression-comment annotations explaining *why* each test exists (e.g. referencing specific PR numbers and prior bugs), and generally avoid brittle assumptions like fixed call-index ordering (e.g. the provenance test explicitly routes by skill path rather than call order, and the reviewer-tuning tests key off `mockGenerateObject.mock.calls.length` relative to `TIER1_SKILLS.length` rather than hardcoded indices). No correctness, security, or architecture issues were identified in this file itself.

### 15. 🟢 [LOW] Some tests rely on implementation details of mocked call ordering/count

Several tests still hardcode the number of `mockResolvedValueOnce` calls to match `TIER1_SKILLS.length` (e.g. 5 Tier-1 agents + 1 summary = 6 calls), which is somewhat brittle if `TIER1_SKILLS` changes size — though this is explicitly called out and mitigated in comments for the trickier cases (dedup/provenance tests). This is a minor maintainability nit, not a defect, and many of the more fragile assertions have already been hardened per the in-code comments referencing past regressions.

### 16. 🟢 [LOW] console.warn spies are consistently restored

All `vi.spyOn(console, "warn")` usages are correctly paired with `.mockRestore()`, and fake timers are cleaned up via `afterEach(() => vi.useRealTimers())` at the relevant describe level. No test-pollution risk observed.

### 17. 🟢 [LOW] Comment says `start_line !== null && start_line >= line` drops the comment, but this also runs before the range validity check needed

Not a real issue on inspection — kept for completeness only if relevant elsewhere.

### 18. 🟢 [LOW] generateObject error handling in runAgent uses broad catch but is well-classified

runAgent's catch block classifies errors via classifyRefusal (quota vs rate-limit vs generic error) and logs distinctly with console.error/console.warn including skillPath context. This is a reasonable pattern given the AI SDK's error surface — not flagging as a defect. However, the generic `catch (err)` at the bottom (status: 'error') swallows ANY exception during generateObject (network errors, schema validation errors, programmer errors) into an undifferentiated 'error' status that is later just counted and named as 'agent failed' with no distinguishing detail beyond skillPath. Consider logging `err` type/name (e.g. `err instanceof Error ? err.name : typeof err`) alongside the message so a schema-validation failure isn't indistinguishable from a network timeout in the logs.

### 19. 🟢 [LOW] restampCheckRun best-effort failure is silent to the PR author

restampCheckRun's catch logs to console.error only; per its own doc comment this is intentional (failure must not turn a clean SKIP into an error). That's a reasonable, explicitly-justified fallback — noting only because it's a case where a failure is fully swallowed from the user's perspective (no PR comment, no check-run update) with just a server-side log. Since this is explicitly documented as intentional behavior in the code, this is informational rather than a defect.

### 20. 🟢 [LOW] triageReReview fail-safe on any thrown error, including non-network errors

In triage.ts, `catch (err)` around the triage generateObject call converts ANY error — auth failures, schema violations, network errors, or bugs in buildTriageSchema — into the same FAIL_SAFE (INCREMENTAL, resolved: []). This is explicitly a documented design decision (fail safe, never SKIP) and the repo's own test suite (triage.test.ts) directly calls this out, including an explicit regression test about auth previously being silently dropped. Given the tests explicitly validate this exact behavior and note the past incident, the pattern here is intentional and reviewed — not flagging as a new issue, but noting that this catch remains fully generic (`catch (err)`) and would equally mask a bug in schema construction as it would a real API outage. If a future auth-plumbing bug like the one referenced in the test comments recurs, it will again surface only as 'INCREMENTAL' with a console.error, not as a distinguishable failure mode.

### 21. 🟢 [LOW] QUOTA_MARKERS substring matching can misclassify errors

classifyRefusal matches quota markers against the lowercased concatenation of message + responseBody. Some of these markers are fairly generic substrings (e.g. "credit balance is too low" is specific enough, but nothing prevents an unrelated error whose message happens to contain one of these phrases — e.g. a proxied error message from a downstream service — from being misclassified as quota_exhausted and reported to users as a permanent, non-retriable condition. Given the asymmetric cost of this misclassification (an actually-transient error told to the user as unrecoverable), it may be worth requiring the 429 status code to also be present before checking quota markers, rather than matching markers independently of status.

### 22. 🟢 [LOW] console.log/console.error used for structured logging throughout

src/review.ts and src/triage.ts log extensively via console.log/console.warn/console.error with structured objects. This is a design choice already baked into the codebase, not new to this diff, but worth flagging: in a hosted webhook service these logs are the only observability surface, and there's no central redaction step visiting PII/secrets that might appear in PR titles, bodies, or diffs before they're logged (e.g. `console.log("agent done", {... skillPath, status ...})` is fine, but `userMessage`/prompt contents are never logged, so this is likely low risk in practice — noting it as a general finding rather than blocking).

### 23. 🟢 [LOW] Backwards start_line comparison check reversed intent

In buildReviewComments, the check `if (comment.start_line !== null && comment.start_line >= comment.line)` drops comments where start_line >= line, which is correct behavior (start_line should be less than line for a valid range) — but the log message says "backwards range" which matches. This is fine; flagging for clarity only, no action needed.

### 24. 🟢 [LOW] Silent truthiness comparison for finding IDs across incremental/full passes could double count in edge case

In review.ts, `byId` dedup logic in the KV persistence section gives freshFindings priority over survivingPrior/resolvedTombstones by insertion order into the Map, relying on `if (!byId.has(f.id))`. This is correct as implemented (first-wins with freshFindings spread first), but it's worth double-checking that `findingId(path, line, title)` is stable/deterministic across a title rewording by the agent — if an agent slightly rephrases a still-open finding's title between rounds, it will get a new ID and never dedupe against the old one, potentially causing the same underlying issue to be tracked as two separate findings indefinitely. Consider whether title should be part of the ID or whether a fuzzy/stable finding key would be safer, since dedupeClaims already exists for a similar near-duplicate problem but findingId doesn't use it.

### 25. 🟡 [MEDIUM] Resetting fetchDeltaMeta leaks an empty mock into later re-review tests

Confidence: 93. `mockFetchDeltaMeta.mockReset()` removes the hoisted default implementation, and this suite does not restore it after its two one-shot truncated responses. Subsequent suites that seed prior state and exercise triage (`INCREMENTAL carries forward...`, `FULL carries forward...`, and later incremental helpers) do not configure this mock, so their calls receive `undefined` rather than `{ files, diff, truncated }`. This can either fail the full test run or drive an error/fallback path instead of the intended incremental path, letting the tests pass without covering their claimed behavior. Restore the normal non-truncated implementation in an `afterEach`, or make the suite's `beforeEach` reset and immediately install the default implementation before overriding it per test.

### 26. 🟡 [MEDIUM] Resetting fetchDeltaMeta removes its default implementation for later triage tests

The truncated-compare suite calls `mockFetchDeltaMeta.mockReset()` but only supplies one-shot implementations within its two tests. Later suites seed prior review state and invoke the triage path without restoring a default implementation. Since `mockReset()` clears the hoisted async default, those later calls receive `undefined` from `fetchDeltaMeta`, likely causing the triage gate to fail while reading delta metadata. Use `mockClear()` here, or restore `mockResolvedValue({ files: [], diff: "delta", truncated: false })` in the relevant `beforeEach`/`afterEach`.

### 27. 🟡 [MEDIUM] Restore the default fetchDeltaMeta mock after resetting it

`mockFetchDeltaMeta` is created with a default non-truncated implementation, but the truncated-compare suite calls `mockReset()` in `beforeEach`. That removes the implementation entirely; each truncated test supplies only one one-shot return, leaving subsequent stateful triage suites with a mock that resolves `undefined`. Those later tests exercise re-review paths and can no longer reliably obtain delta metadata, making their behavior depend on execution order or fail before their intended assertions. Use `mockClear()` here, or restore the default implementation in the `beforeEach` after resetting.

### 28. 🟡 [MEDIUM] Do not hide failed check-run re-stamps on the SKIP path

`restampCheckRun` catches every failure, logs only `{ err }`, and then `buildReview` returns `null`. Since SKIP intentionally posts no review, a GitHub API failure (permissions/authentication errors, rate limits, network failures, malformed request serialization, or an unexpected Octokit error) leaves no current-head check-run and no user-visible indication that the carried-forward verdict was not published. The webhook/job also cannot retry because the error is swallowed. Include owner/repo/PR/SHA context in the log and propagate the failure to the caller (or produce an explicit user-visible failure/status) so this essential status update is retried rather than silently lost.

### 29. 🔴 [HIGH] Compare API failures abort the re-review instead of failing safe

Criticality: 8/10. `fetchDeltaMeta(...)` is awaited outside any recovery path in `buildReview`. A transient compare API failure therefore rejects the entire review before `triageReReview` can apply its documented fail-safe behavior, resulting in no review/check-run update for a new push. Add a build-review-level test that makes the compare request reject and verifies the bot falls back to reviewing the full paginated PR file set (and still posts/persists a result). Then catch this failure around delta retrieval and select the existing FULL path. The current triage tests cover model-call failure but not this higher-risk GitHub integration failure.

### 30. 🔴 [HIGH] Do not apply triage resolutions from a truncated compare result

`fetchDeltaMeta` correctly treats a 300-file compare result as incomplete for choosing SKIP/INCREMENTAL, but the code still calls triage and marks findings resolved before checking `deltaMeta.truncated`. Those resolved findings are removed from `survivingPrior` and can therefore stop forcing `REQUEST_CHANGES`; if the subsequent full-review agents do not restate them, the PR can be approved despite a previously open finding. When the compare result is truncated, bypass triage entirely (or at minimum ignore `triage.resolved`) and retain all prior open findings until a complete delta can validate their resolution.

### 31. 🔴 [HIGH] Resolved inline findings can suppress unrelated new general findings

When triage resolves any persisted inline finding, the loop adds both its `inline:path:line` key and a `general:<title>` key to `resolvedKeys`. `mergeReviewsDetailed` uses the latter to discard every general finding with that title, regardless of file or location. A newly introduced issue with a common title such as “Missing null check” can therefore be removed from the merged review; if it was the only finding, the clean-delta path can approve the PR. Only add the general-title key for persisted general findings (`path === null`), and add the inline key for anchored findings.

### 32. 🟡 [MEDIUM] Approval message overlooks several unsuccessful completed CI states

`fetchOutstandingChecks` treats a completed check as noteworthy only when `conclusion === "failure"`. Completed checks can also be non-successful/action-required states (for example, cancelled, timed out, stale, or action required), yet the approval message will say no checks are outstanding. Treat completed conclusions other than explicitly acceptable outcomes as requiring a merge warning, or report all non-success conclusions accurately.

## Inline Notes

| File | Line | Comment |
|------|------|---------|
| `src/models.ts` | 25 | **computeCost: floating point cost accumulation not rounded**: `computeCost` returns a raw floating-point sum of two divisions and multiplications. Over many invocations (e.g., accumulated per-agent-call costs summed across a multi-provider audit run), floating-point drift could accumulate in reports. The tests use `toBeCloseTo`, which tolerates this in isolation, but if callers sum many `computeCost` results and display/store the raw sum (as report.test.ts's `cost_usd: 0.012345` suggests), consider rounding to a fixed precision (e.g., cents or 6 decimal places) at the point of aggregation or display to avoid noisy-looking totals like `0.0119999999997`. |
| `src/review.ts` | 1 | **comment.start_line >= comment.line comparison mishandles equal start/line without lowering to general (already handled) — false alarm, see below for real finding**: placeholder |
| `src/review.ts` | 665 | **fetchOutstandingChecks catches all errors and treats them as 'fetchFailed' without distinguishing cause**: This catch block catches everything from the check-runs API call — network errors, 404s (bad headSha), auth/permission errors, rate limits — and collapses them all into a generic `fetchFailed: true`, logged via `console.warn` with only `headSha` and the raw `err` object. The resulting user-facing message (`buildApprovalMessage`) says only 'could not verify outstanding CI checks — check them manually before merging', which is reasonable given this is explicitly a best-effort auxiliary check (approval itself doesn't depend on it), so downgrading this to low confidence. Consider logging `err instanceof Error ? err.message : err` explicitly (or at least owner/repo/pullNumber) for easier triage, since `headSha` alone won't distinguish a transient network blip from a persistent permissions problem across multiple PRs. |
| `src/review.ts` | 156 | **classifyRefusal / extractRateLimit rely entirely on message-substring matching, which is fragile but documented**: Both `classifyRefusal` and `extractRateLimit` walk `err`, `err.lastError`, and `err.errors[]` for a `statusCode === 429`, and `classifyRefusal` additionally does substring matching against `QUOTA_MARKERS` in the lowercased message/responseBody. This is explicitly commented as necessary because neither provider exposes a reliable machine-readable field through the AI SDK's RetryError wrapper — a reasonable, well-documented trade-off. One risk worth flagging at low severity: if a provider ever changes its error message wording (e.g. removes 'insufficient_quota' from the string), the classification silently falls through to `null` and the outer catch in `runAgent` reports a generic `status: 'error'` instead of `quota_exhausted` — meaning a real quota exhaustion could look like a transient bug for one bad review run before anyone notices the pattern in logs. Not asking for a fix here (there's no better signal available per the comment), just noting the failure mode is a silent misclassification rather than a crash. |
| `src/review.ts` | 1000 | **Non-null assertion risk: reduce() on possibly-empty array is fine, but check placement**: placeholder |
| `src/review.ts` | 507 | **Non-null assertion risk: comment.start_line !== null check happens before undefined check**: `comment.start_line !== null && comment.start_line >= comment.line` — start_line is typed `number   null` per the Zod schema (`.nullable()`), so this comparison is type-safe. No issue; just confirming intent is preserved. (No action needed — false positive, removing as a real finding.) |
| `src/review.ts` | 760 | **console.log/warn used for structured operational logging throughout hot path**: Numerous `console.log`/`console.warn`/`console.error` calls are scattered through `buildReview` and `runAgent` (e.g. lines around agent completion, rate limiting, dropped comments). This is a very large function with many side-effecting log statements interleaved with business logic, which hurts readability and makes the control flow harder to trace. Consider extracting a small logger abstraction or at least grouping diagnostic logging away from the core decision logic, especially since this function is already quite long (400+ lines) and handles many responsibilities (idempotency, triage gating, agent orchestration, merging, formatting, persistence). |
| `src/review.ts` | 625 | **buildReview is doing too much — consider decomposition**: `buildReview` spans the entire file's core logic: idempotency check, prior-review dedup, triage gating, agent orchestration, merging, summary generation, cost computation, message formatting, and KV persistence — all in one ~500+ line async function with many mutable `let` bindings threaded through it (`survivingPrior`, `priorSha`, `resolvedTombstones`, `resolvedThisRound`, `incrementalPass`, `lastRateLimit`, etc.). This makes the function hard to unit test in isolation and increases the risk of subtle bugs when one section's state leaks into another. Consider extracting the triage-gate block and the message-formatting block into separate named functions with explicit inputs/outputs (some of this decomposition already exists for formatFindings/buildApprovalMessage/buildCommentBody — extending that pattern to the triage section and the final body-assembly section would meaningfully improve readability and testability). |
| `src/review.ts` | 700 | **Potential state corruption: mutating state.findings in place before persisting**: In the triage gate, `for (const f of state.findings) { if (triage.resolved.includes(f.id)) { f.status = "resolved"; ... } }` mutates the findings array returned from `loadReviewState` directly. Later, on the SKIP path, this mutated `state` (with `state.event` recomputed) is persisted via `saveReviewState`. This is likely intentional, but relying on mutating a loaded object in place (rather than constructing a new state object) makes it easy to accidentally carry over stale mutations if this function is ever called multiple times with the same `state` reference (e.g., in a retry loop or a future refactor that reuses `state` across pull requests). Consider constructing a new findings array immutably to guard against this class of bug as the function grows. |
| `src/review.ts` | 152 | **QUOTA_MARKERS substring matching is brittle across provider message changes**: `QUOTA_MARKERS` matches on literal substrings within error messages (e.g. "insufficient_quota", "credit balance is too low"). Since this is explicitly documented as necessary because neither provider exposes a machine-readable field, it's a reasonable pragmatic choice, but note it is fragile against provider wording changes (e.g. Anthropic or OpenAI rephrasing their error text would silently break the quota/rate-limit distinction and misclassify a quota exhaustion as a plain rate limit, sending users into a futile retry loop). Consider adding a test that pins these exact strings against a real captured error response, and/or logging when a 429 is classified as neither quota nor rate-limit so silent misclassifications are observable in production logs. |
| `src/router.ts` | 103 | **routeModel's _authMode param is now dead but still threaded through many call sites**: `_authMode` is unused (prefixed with underscore, correctly) in `routeModel`, `triageSelection`, but the parameter is still accepted and passed through at every call site in review.ts (`context.auth?.mode`) and tests still exercise it explicitly. Given the comment explains this is intentional for compatibility, this is fine as-is, but consider adding a deprecation comment/TODO with a target removal condition (e.g., "remove once gpt-5.4-oauth split is confirmed permanently retired") so this doesn't become permanent dead parameter cruft that future readers have to puzzle over. |
| `src/triage.ts` | 119 | **Silent truncation fallback duplicated between fetchDeltaMeta and isLikelyTruncated callers**: `isLikelyTruncated` is exported and used both inside `fetchDeltaMeta` and (implicitly) relied upon by callers in review.ts that check `deltaMeta.truncated`. This is fine, but the constant `COMPARE_FILE_CAP = 300` is asserted as GitHub's actual API cap in a comment without a citation/test against real GitHub behavior — if GitHub ever changes this cap (they have changed similar undocumented limits before), the `isLikelyTruncated` heuristic silently stops working and truncated diffs will be treated as complete, causing SKIP/INCREMENTAL to reason over partial data (the exact failure mode this code exists to prevent). Since this is safety-critical (a wrong SKIP verdict means a real bug is missed), consider also cross-checking against a documented response header/field if GitHub exposes one, rather than relying solely on hitting the count. |
| `src/improve/qc.ts` | 116 | **Add behavioral tests for judge failure classification**: Criticality: 7/10. `qc.test.ts` covers selection, aggregation, and formatting, but never exercises `judgeFinding`. Add mocked `generateObject` tests that verify transient/provider failures return `null` (and are therefore counted as unjudged), while `TypeError`/`ReferenceError` are rethrown. This protects the important distinction documented here: an outage must not silently appear as a valid QC pass, while programming defects must not be downgraded into an outage. |
| `src/models.ts` | 39 | **Cover model construction for each authentication mode**: Criticality: 7/10. The model tests validate pricing only. There is no coverage for the credential-routing contract in `createAIModel`: API-key auth versus OAuth auth, custom base URL/headers/fetch propagation, and the OpenAI OAuth Responses-model path. The local-review tests mock agents, so they cannot catch a regression that drops OAuth transport/auth configuration or routes an OAuth request through the wrong model constructor, which would break or mis-bill local subscription-backed reviews. |
| `src/review.ts` | 466 | **Do not suppress findings re-raised after triage resolution**: **Confidence: 94/100.** `resolvedKeys` is populated from the triage model before the full agents run, and this filter drops every fresh finding whose title matches a triage-resolved finding. If triage incorrectly marks an incomplete fix as resolved, or the issue is reintroduced in the same delta, agents can correctly flag it but the merge silently removes it. The persisted state then retains the resolved tombstone and the review can incorrectly approve the PR. Only use triage resolution to remove carried-forward prior findings; allow findings produced by the current agents to survive and overwrite a matching tombstone. |
| `src/triage.ts` | 88 | **Expose triage failures instead of silently treating them as incremental review**: This broad catch converts every triage failure into `INCREMENTAL` and only emits a server-side log. That includes provider authentication/quota/rate-limit failures, invalid structured output, request/configuration errors, network failures, and unexpected programming errors. The caller then reviews only the compare delta and posts an apparently normal review, without telling PR authors that structural-risk triage was unavailable and full-review escalation may have been missed. Preserve the availability fallback if desired, but return a failure/degraded-triage indicator to `buildReview`, include it in the posted partial-review notice, and distinguish expected provider refusals from unexpected errors in the catch handling. |
| `src/triage.ts` | 74 | **Untrusted diff content can instruct the triage model to skip review**: `deltaDiff` is PR-author-controlled content but is interpolated directly into an instruction-bearing LLM prompt. An attacker can add prompt-injection text to a changed file that directs the model to emit `SKIP` and/or mark known finding IDs resolved. The Zod schema only validates output shape, so it does not prevent a semantically malicious but valid decision; this path can prevent the full review from running. Delimit the diff as untrusted data and explicitly prohibit treating text within it as instructions, and do not let an LLM-only decision authorize a SKIP when it reports resolutions or the diff contains reviewable code. |

## Metadata

- **Models:** claude-sonnet-5, gpt-5.6-terra
- **Skills:** code-reviewer, silent-failure-hunter, pr-test-analyzer, security-sast, code-review-and-quality
- **Remote:** https://github.com/joeblackwaslike/ai-review-bot

---
*Generated by [ai-review-bot](https://github.com/joeblackwaslike/ai-review-bot). Flip `status:` to `implemented` once findings are addressed.*
