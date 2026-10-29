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

1. If `context.kv` holds a valid state, that state is the baseline, exactly as today.
2. Otherwise the baseline is derived from GitHub.
   - The source review is the latest own review at any head, with its id and body. This is a new selection next to the existing `priorOwnReview`, which keeps its older-head rule because the agent prompt depends on it. Legacy `Reviewed commit:` bodies still work. Taking the latest review at any head matters for a forced run right after a review at the current head, which would otherwise find nothing to carry.
   - `lastReviewedSha` and `reviewCount` come from that body's `ai-review:sha` and `ai-review:review` markers. The sha is used for scoping only when it differs from the head. A same-head source feeds carrying and the count and nothing else.
   - Prior findings come from three places in that one review. First, the ledger entries of its inline comments whose status is `open`. Second, its body table rows, which hold the review's general findings and the "Still open from the previous review" rows carried from earlier rounds. Third, the blockquote bullets under the "could not be anchored to the diff" notice, which hold inline findings that were posted in the body instead. Ledger entries and bullets are converted to `PersistedFinding` and deduplicated by id.
   - A carried-forward row and an unanchored bullet are rendered as `**Title** (\`path:line\`)`. `parseBodyFindings` keeps that suffix in the title with no path or line. `deriveBaseline` strips the suffix from entries that have no path and sets `path` and `line` from it, so the `inline:path:line` resolve key works. A title that merely ends in parentheses without a `path:line` pair is left alone. Ids are computed from the recovered or ledger coordinates and only need to be stable within one run. They are not promised to equal the ids KV stored, because the ledger prefers a comment's current line and KV stored the line at posting time.
   - The ledger picks its rounds by sorting the own reviews it fetches, and `buildReview` picks `priorOwnReview` from a separate fetch. To keep the two on the same review, `LoadedLedger` carries `reviewIds`, the ids of the own reviews in round order, and the baseline reads the round at `reviewIds.indexOf(sourceReviewId)`. If the id is missing (a review landed between the two fetches), the derived baseline is incomplete.
   - If the ledger could not be built (`warm: false`), the inline findings of the source review are unrecoverable. The baseline is then usable only when the body says `Inline comments: none` and has no unanchored bullets, so the table rows are the complete set. Otherwise it is incomplete.
   - An incomplete derived baseline cannot be used to scope. The round runs full, says `scope: full (baseline incomplete)`, and `buildReview` logs why. Whatever findings were recovered are still carried and revalidated like any other full fallback. The findings that could not be recovered are not in the skip list the agents receive, and the full scan covers the whole PR, so an unrecovered defect that still exists is raised again as a new finding.
3. If neither exists, there is no baseline and the run is a first review.

A forced run still resolves a baseline, for two uses only. It carries every open baseline finding into `survivingPrior`, and it continues the review count. It does not use the baseline to scope. Before this sprint a forced run loaded nothing, so a forced review that did not re-raise an earlier finding dropped it from the next round's baseline, and with a GitHub-derived baseline that loss would be permanent. Carrying fixes that for forced runs on both baselines.

`loadReviewState` stops parsing review bodies. It reads KV only. The derivation moves to a new `src/baseline.ts`, a pure function from `(priorOwnReview, ledger, reviewIds)` to a `ReviewState | null`, with a result type that can say "incomplete", so it can be tested without GitHub.

Why only the latest review's entries. The ledger spans every round. An older finding that the bot itself decided was fixed leaves no trace on GitHub: no reply, no resolved thread. If the derivation took every open entry, that finding would come back as a blocking prior finding on every later round and the PR could never reach APPROVE. A finding still open is repeated in the body table of each later review under "Still open from the previous review", and a finding triage resolved is not. So the open findings in the latest review match the set KV would hold, provided every run carries its baseline forward, which is why forced and fallback runs now do. This was derived from reading `formatReviewBody` and `survivingPrior` handling, and it is checked on the three real PRs in the verification section.

`reviewIds` is also what makes a latest review with no findings readable: its round has no entries, but its id still has a position.

If KV and GitHub disagree (KV holds a sha for a review whose POST failed), KV wins in this sprint, as it does today. Using GitHub as the single source is a sprint 5 change and is recorded under Known limits.

### The gate no longer needs KV

The condition `context.kv && !context.force && state?.lastReviewedSha && state.lastReviewedSha !== context.headSha` becomes `baseline && !context.force && baseline.lastReviewedSha !== context.headSha`. Everything inside the gate stays. `carryVerdictForward` saves to KV only when KV exists and always re-stamps the check-run, so the SKIP path works without KV.

`reviewCount` for the footer is the baseline's count when there is one. A forced run with no baseline uses the highest `ai-review:review` marker among own reviews. Without markers it is 0.

### Full fallbacks carry and revalidate

Every path that runs FULL on a round that has a baseline (forced, compare failed, compare truncated, compare rewritten, baseline incomplete, triage chose FULL) carries every open baseline finding into `survivingPrior`, after the ledger removes the settled ones. Today the code assigns `survivingPrior` only after the triage call, and applies `triage.resolved` before it checks truncation, so a truncated compare can resolve findings on evidence it just declared incomplete. The new rule is that the compare outcome is checked first. When the delta is unusable (threw, not `ahead`, truncated), the delta triage call is not made and nothing is resolved from a delta.

Carrying alone would trap a PR. If the fix for a carried finding lands in a fallback round, no later delta contains it, and the finding would force REQUEST_CHANGES until someone replies on a thread, which general findings do not have. So a fallback round also runs one revalidation call. It sends the carried findings that have a `path`, with the current patch of each named file from the PR file list that `buildReview` already fetched, to the triage model, using the same schema and the same fail-safe of resolving nothing. Only `resolved` is read from the answer. The patches use the existing per-file `trimPatch` cap and a total cap of 60,000 characters, with findings beyond the cap left carried. Findings with no path are not revalidated and stay carried. This is a heuristic with the same trust level as delta triage. `triageReReview` gains a `mode` argument (`delta` or `current`) that only changes the header line of the prompt, because today it hardcodes "delta only".

### Compare failures

`fetchDeltaMeta` gets a catch and a status check. It returns `null` when the delta is unusable, and the caller treats `null` and truncation the same way. Any of these makes the round FULL with every baseline finding carried, a warning that names the reason and the PR, and no triage call.

- The compare request throws (404 or 422 when the old sha is gone, a network error, a rate limit).
- The compare `status` is not `ahead`. A `diverged` or `behind` status means history was rewritten, and the three-dot file list then holds changes the author did not just make. This was checked on real GitHub for the two cases that can be reproduced today: a valid pair returns `ahead` with the expected 24 files, and an unknown sha returns 404. A rebased pair was not reproduced, so the `diverged` rule follows the documented compare semantics and is covered by a unit test only.
- The file list reaches the 300-file cap. The scope was already FULL; what changes is that triage is skipped and its resolutions are no longer applied.

### Forced runs

`--force` in a comment means "review all of it again". A forced run keeps its current meaning for scope. It skips the idempotency check, the delta gate and the silence rule, and it always posts. It now also carries the baseline's open findings (see Where the baseline comes from). Plain `/ai-review` without `--force` is not forced today and goes through the gate like a push does. The sprint brief said the manual command sets force on purpose, which is true only for `--force` (`parseReviewCommand`). Ledger suppression still applies to a forced run, as sprint 2 decided.

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
| `scope: full (baseline incomplete)` | derived baseline could not be read in full |

The post-mortem asked for "warm or cold". `delta` is warm. Every `full` reason says why it was not.

## Design

| File | Change |
| --- | --- |
| `src/baseline.ts` (new) | `deriveBaseline(priorOwnReview, ledger, latestRound)` returns `ReviewState \| null`. Imports `PersistedFinding`, `findingId`, `parseBodyFindings` from `review-state.ts`. |
| `src/review-state.ts` | `loadReviewState` reads KV only; `parsePriorReview` is exported for `baseline.ts` and no longer called from `loadReviewState`. The `priorOwnReview` parameter is removed. |
| `src/ledger/github.ts`, `src/ledger/live.ts` | `reviewIds` on `LedgerEvidence` and `LoadedLedger`. |
| `src/triage.ts` | `triageReReview` gains `mode` for the revalidation prompt header. `DeltaMeta` gains `status`. `fetchDeltaMeta` returns `null` on any failure or when `status` is not `ahead`. `CompareOctokit` data type gains `status`. |
| `src/review.ts` | Baseline resolution; gate condition; FULL fallbacks that carry and resolve nothing; `scopeNote`; `reviewCount` base; `priorOwnReview` keeps its review id. The ledger is fetched before the gate when an own review exists, which `fetchLedger` already memoizes. |
| `src/watch.ts` | Remove cycle-1 force, seeding and `loadPersistedState`. Update the comment block and `CLAUDE.md`'s watch paragraph. |

Named exports only, `.js` import specifiers, as elsewhere.

## Tests (each written to fail first)

Fakes assert the request shape. The Sprint 2 bug (a GraphQL call with no `variables` passing every mocked test) came from mocks that ignored their parameters, so the octokit fake used in the new `buildReview` tests throws on any route it does not know and on a compare call whose `basehead` is not `<old>...<new>`.

- `baseline`: a carried row `**Title** (\`src/a.ts:10\`)` becomes title `Title`, path `src/a.ts`, line 10, with KV's id; sha, count and open findings from the latest review only; a finding open in round 1 and absent from round 3's table is not carried; a latest review with no findings gives an empty list; a cold ledger falls back to body rows; no own review gives `null`.
- `buildReview` cold path: no KV, one older own review in `existingReviews`, ledger warm. The compare fake is called once with the old and new sha, and the agents' file set is the delta. This fails today because the gate needs `context.kv`.
- `buildReview` KV present still wins when it holds a state.
- Compare throws: the review runs FULL, warns, footer says `full (compare failed)`, the triage model is not called, and a baseline blocker still forces REQUEST_CHANGES when the agents return nothing.
- Compare returns `diverged`: same.
- Compare truncated: the delta triage call is not made and no delta resolution is applied (the stub would return one; the test asserts it is never asked).
- Revalidation: a fallback round whose carried finding's file no longer contains the problem resolves it, so a later unrelated push does not carry it; a title-only carried finding is not sent; the call receives only the named files' patches and stays under the cap; a model error resolves nothing.
- Same-head forced run with no KV: review A posted at the current head, then `--force`; A's findings are carried and the count continues.
- Forced run: FULL, posts even when nothing is new, footer `full (forced)`, review count continues from markers. Round 1 raises A, a forced round 2 raises only B, and round 3's baseline still holds A.
- Derived baseline completeness: a cold ledger with `Inline comments: 3` in the source body gives `full (baseline incomplete)`; a cold ledger with `Inline comments: none` is accepted from the table rows; an unanchored bullet is recovered into a finding with path and line.
- Review identity: `reviewIds` does not contain the source review id (a review landed between the fetches), so the baseline is incomplete; two own reviews at one older sha pick the later one.
- Footer: each scope note.
- `watchPr`: first cycle sends `force: false`; the old seeding tests are removed with the code; a restart on an already-reviewed head ends as "no new review" without a post.

## Verification

- The three incident PRs on real GitHub. A script (not a committed fixture) lists the own reviews of each PR, runs `deriveBaseline` over the live ledger, and prints the baseline sha and open finding count for every round. Every sha must match the `ai-review:sha` of the previous own review, and the compare against the next head must return `ahead`. The 14 reviews on these PRs are the sample. Rounds whose derived finding set is empty or surprising are checked by hand against that review's body.
- `ai-review replay` must stay green. It measures recycling and not scoping, so scoping is verified by the unit tests and the real-PR check above.
- One local `ai-review review --full` pass before the first push and one on the fix batch, with each finding checked against the code.

## Known limits

- A partial review still advances the baseline. 6 of the 14 incident reviews carry the "Partial review" notice (4 of 4 on stealth-browser#1, 2 of 5 on agent-skills#10, 0 of 5 on ai-listings#74). Treating them as having no baseline would send every round of the largest incident PR back to a full scan, which is the cost this sprint removes, and a delta is smaller so its agents are more likely to finish. The agents that failed in one round have not reviewed the earlier code, and a delta round will not show it to them. This matches what KV does today. It is tracked in a new bead.
- The `path:line` suffix recovery is a regex on the rendered form. A body that predates the suffix yields title-only findings, which triage resolves by title and which cannot match an inline comment by position. A title that really ends in a backticked `path:line` pair would be split wrongly. Neither is measured.
- Inline findings dropped by the inline-comment cap are stored by KV but appear nowhere on GitHub except as a count (`not posted`). A derived baseline cannot recover them. They are the lowest-severity findings by construction.
- A restarted watcher cannot replace a review a human dismissed at an unchanged head, because `alreadyReviewed` checks the heading and sha only. The webhook path behaves the same way. Branch protection dismisses stale approvals on a push, which changes the head, so this needs a manual dismissal.
- When KV holds a sha for a review whose POST failed, KV is trusted over GitHub. Sprint 5 removes KV.
- The `diverged` rule is not reproduced against a real force-push in this sprint.
