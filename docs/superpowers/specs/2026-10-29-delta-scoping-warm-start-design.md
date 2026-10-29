# Delta scoping and warm start (sprint 3)

Date: 2026-10-29
Bead: `ai-review-bot-w9b.2`
Epic: [review accuracy and convergence](2026-10-27-review-accuracy-epic-design.md)
Depends on: [sprint 1 replay harness](2026-10-27-review-replay-harness-design.md), [sprint 2 ledger](2026-10-28-ledger-repeat-suppression-design.md)

## Problem

On 2026-10-25 every Claude review of the three incident PRs said `review=1` and several scanned the whole PR even though the author had pushed a few lines ([post-mortem](../../post-mortem-re-review-memory.md), causes 3 and 4). Two things in the code explain it.

- `buildReview` runs the triage gate (SKIP, INCREMENTAL, FULL) only when `context.kv` is set, the run is not forced, and KV holds a state whose `lastReviewedSha` differs from the head. With no KV client there is no baseline, so every round reviews the whole PR. The `parsePriorReview` fallback in `src/review-state.ts` sits behind the same `context.kv` check, so it never runs without KV either.
- `ai-review watch` starts every provider with `hasPostedEver = false`, which sends `force: true` on cycle 1 of every process. Forced runs skip the state lookup and the gate. Restarting the watcher before each fix batch is the documented workflow, so each batch began with a cold full review.

All 14 Claude reviews on the incident PRs carry an `ai-review:sha` marker and an `ai-review:review` marker, checked on real GitHub today. The baseline the code needed was on the PR the whole time.

## Goal

1. A round reviews only what changed since the last review the bot posted, whether or not KV exists.
2. A restarted watcher does not force a cold review when the bot already reviewed an earlier head of the PR.
3. Review memory used for scoping comes from GitHub when KV has nothing.
4. A review says whether it was scoped to a delta or ran in full, and why.

## Non-goals

- Removing the KV code paths (sprint 5). KV stays an optional cache. When it holds a state, that state is still used as before.
- Stopping `lastReviewedSha` from advancing past agents that did not finish. See Known limits for the measurement.
- Hosted-deployment work beyond what falls out of using the shared `buildReview` path (sprint 5).
- Classifying or fixing Claude's first-pass false positives (sprint 4).
- Any LLM judge or embedding matcher (bead `ai-review-bot-w9b.8`, which this sprint unblocks).
- Deciding the 27 pre-existing defects in `ai-review-bot-4ez`.

## Decisions

### Where the baseline comes from

`buildReview` resolves one baseline per run, in this order.

1. A forced run has no baseline. It reviews the whole PR.
2. If `context.kv` holds a valid state, that state is the baseline, exactly as today.
3. Otherwise the baseline is derived from GitHub.
   - `lastReviewedSha` and `reviewCount` come from the `ai-review:sha` and `ai-review:review` markers of the latest own review at an older head. This is the existing `priorOwnReview` selection in `buildReview`, so legacy `Reviewed commit:` bodies still work.
   - Prior findings are the ledger entries of that same review (its inline comments and its body table rows) whose status is still `open`. They are converted to `PersistedFinding`.
   - If the ledger could not be built (`warm: false`), the findings are the body table rows only, which is what `parsePriorReview` returns today.
4. If neither exists, there is no baseline and the run is a first review.

`loadReviewState` stops parsing review bodies. It reads KV only. The derivation moves to a new `src/baseline.ts`, a pure function from `(priorOwnReview, ledger, latestRound)` to a `ReviewState | null`, so it can be tested without GitHub.

Why only the latest review's entries. The ledger spans every round. An older finding that the bot itself decided was fixed leaves no trace on GitHub: no reply, no resolved thread. If the derivation took every open entry, that finding would come back as a blocking prior finding on every later round and the PR could never reach APPROVE. A finding still open is repeated in the body table of each later review under "Still open from the previous review", and a finding triage resolved is not. So the entries of the latest review hold exactly the set KV would hold. This was derived from reading `formatReviewBody` and `survivingPrior` handling, and it is checked on the three real PRs in the verification section.

The ledger needs to say which round is the latest, because a latest review with no findings has no entries to read the round from. `fetchLedgerEvidence` already sorts the own reviews and indexes them, so `LedgerEvidence` gains `latestRound` (the index of the last own review, -1 when none) and `LoadedLedger` passes it on.

If KV and GitHub disagree (KV holds a sha for a review whose POST failed), KV wins in this sprint, as it does today. Using GitHub as the single source is a sprint 5 change and is recorded under Known limits.

### The gate no longer needs KV

The condition `context.kv && !context.force && state?.lastReviewedSha && state.lastReviewedSha !== context.headSha` becomes `baseline && !context.force && baseline.lastReviewedSha !== context.headSha`. Everything inside the gate stays. `carryVerdictForward` saves to KV only when KV exists and always re-stamps the check-run, so the SKIP path works without KV.

`reviewCount` for the footer is the baseline's count when there is one. For a forced run it is the highest `ai-review:review` marker among own reviews, so a forced run continues the count instead of resetting to 1. Without markers it is 0.

### Compare failures

`fetchDeltaMeta` gets a catch and a status check. Any of these makes the round FULL, with a warning that names the reason and the PR.

- The compare request throws (404 or 422 when the old sha is gone, a network error, a rate limit).
- The compare `status` is not `ahead`. A `diverged` or `behind` status means history was rewritten, and the three-dot file list then holds changes the author did not just make. This was checked on real GitHub for the two cases that can be reproduced today: a valid pair returns `ahead` with the expected 24 files, and an unknown sha returns 404. A rebased pair was not reproduced, so the `diverged` rule follows the documented compare semantics and is covered by a unit test only.
- The file list reaches the 300-file cap (already handled, unchanged).

A failed compare also skips the triage LLM call, since there is no delta to triage against.

### Forced runs

`--force` in a comment means "review all of it again". A forced run keeps its current meaning. It skips the idempotency check, the delta gate and the silence rule, and it always posts. Plain `/ai-review` without `--force` is not forced today and goes through the gate like a push does. The sprint brief said the manual command sets force on purpose, which is true only for `--force` (`parseReviewCommand`). Ledger suppression still applies to a forced run, as sprint 2 decided.

### Watcher restarts

`watchPr` no longer sends `force: true` on cycle 1. It deletes `hasPostedEver`, the cycle-1 seeding block and the `loadPersistedState` option with its KV lookup. A restart on a head the bot already reviewed gets `null` from the existing `alreadyReviewed` check, which the watcher already treats as "no new review". A restart on a new head with an earlier own review takes the baseline and gate path above.

Two consequences are accepted.

- Someone who wants a second review of the same head from the watcher must post `/ai-review --force` on the PR. The watcher never asks for one.
- With KV configured, a hard-killed watcher can leave a review claim on the head for up to 1200 seconds (`REVIEW_CLAIM_TTL_SECONDS`). The first cycles after a restart then log "commit already claimed" and retry each interval until it expires. Forced cycle 1 used to skip that claim. This does not stick, and local runs normally have no KV.

### Reporting warm or cold

The review footer gains a scope note next to the ledger note, and one log line carries the same text.

| Note | Meaning |
| --- | --- |
| `scope: delta from <sha7> (kv)` | INCREMENTAL, baseline from KV |
| `scope: delta from <sha7> (github)` | INCREMENTAL, baseline derived from GitHub |
| `scope: full (first review)` | no baseline |
| `scope: full (forced)` | forced run |
| `scope: full (triage)` | baseline existed and triage chose FULL |
| `scope: full (compare failed)` | compare threw or returned a rewritten history |
| `scope: full (compare truncated)` | 300-file cap |

The post-mortem asked for "warm or cold". `delta` is warm. Every `full` reason says why it was not.

## Design

| File | Change |
| --- | --- |
| `src/baseline.ts` (new) | `deriveBaseline(priorOwnReview, ledger, latestRound)` returns `ReviewState \| null`. Imports `PersistedFinding`, `findingId`, `parseBodyFindings` from `review-state.ts`. |
| `src/review-state.ts` | `loadReviewState` reads KV only; `parsePriorReview` is exported for `baseline.ts` and no longer called from `loadReviewState`. The `priorOwnReview` parameter is removed. |
| `src/ledger/github.ts`, `src/ledger/live.ts` | `latestRound` on `LedgerEvidence` and `LoadedLedger`. |
| `src/triage.ts` | `DeltaMeta` gains `status`. `fetchDeltaMeta` returns `null` on any failure. `CompareOctokit` data type gains `status`. |
| `src/review.ts` | Baseline resolution; gate condition; FULL fallbacks; `scopeNote`; `reviewCount` base. The ledger is fetched before the gate when an own review exists, which `fetchLedger` already memoizes. |
| `src/watch.ts` | Remove cycle-1 force, seeding and `loadPersistedState`. Update the comment block and `CLAUDE.md`'s watch paragraph. |

Named exports only, `.js` import specifiers, as elsewhere.

## Tests (each written to fail first)

Fakes assert the request shape. The Sprint 2 bug (a GraphQL call with no `variables` passing every mocked test) came from mocks that ignored their parameters, so the octokit fake used in the new `buildReview` tests throws on any route it does not know and on a compare call whose `basehead` is not `<old>...<new>`.

- `baseline`: sha, count and open findings from the latest review only; a finding open in round 1 and absent from round 3's table is not carried; a latest review with no findings gives an empty list; a cold ledger falls back to body rows; no own review gives `null`.
- `buildReview` cold path: no KV, one older own review in `existingReviews`, ledger warm. The compare fake is called once with the old and new sha, and the agents' file set is the delta. This fails today because the gate needs `context.kv`.
- `buildReview` KV present still wins when it holds a state.
- Compare throws: the review runs FULL, warns, footer says `full (compare failed)`, and the triage model is not called.
- Compare returns `diverged`: same.
- Compare truncated: FULL (existing test kept).
- Forced run: FULL, posts even when nothing is new, footer `full (forced)`, review count continues from markers.
- Footer: each scope note.
- `watchPr`: first cycle sends `force: false`; the old seeding tests are removed with the code; a restart on an already-reviewed head ends as "no new review" without a post.

## Verification

- The three incident PRs on real GitHub. A script (not a committed fixture) lists the own reviews of each PR, runs `deriveBaseline` over the live ledger, and prints the baseline sha and open finding count for every round. Every sha must match the `ai-review:sha` of the previous own review, and the compare against the next head must return `ahead`. The 14 reviews on these PRs are the sample. Rounds whose derived finding set is empty or surprising are checked by hand against that review's body.
- `ai-review replay` must stay green. It measures recycling and not scoping, so scoping is verified by the unit tests and the real-PR check above.
- One local `ai-review review --full` pass before the first push and one on the fix batch, with each finding checked against the code.

## Known limits

- A partial review still advances the baseline. 6 of the 14 incident reviews carry the "Partial review" notice (4 of 4 on stealth-browser#1, 2 of 5 on agent-skills#10, 0 of 5 on ai-listings#74). Treating them as having no baseline would send every round of the largest incident PR back to a full scan, which is the cost this sprint removes, and a delta is smaller so its agents are more likely to finish. The agents that failed in one round have not reviewed the earlier code, and a delta round will not show it to them. This matches what KV does today. It is tracked in a new bead.
- The derived finding set is only as good as the body table. A finding that was posted inline in round 1 and is still open appears in later bodies by title only, so it has no path or line and triage resolves it by title. This degrades toward reviewing more, which is how `parsePriorReview` already behaved.
- When KV holds a sha for a review whose POST failed, KV is trusted over GitHub. Sprint 5 removes KV.
- The `diverged` rule is not reproduced against a real force-push in this sprint.
