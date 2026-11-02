# Phase C measurement: discard reasons and replay traces

Parent: [2026-10-31-verified-context-aware-reviews-design.md](2026-10-31-verified-context-aware-reviews-design.md), Phase C (beads `ai-review-bot-t0c.12`, `.13`, `.14`). This doc covers C1 and C2 and when C3 runs. C4 and C5 stay deferred.

## Why

The verifier (D1) and the tool-using agents (E2) are the expensive work, and the spec requires measurement first. Today the pipeline drops findings in six places and the record of why is a `console.log` line, or nothing. The replay harness holds only what was posted, so it cannot say what the agents proposed or what the filters removed. Without both, "the verifier dropped 40% of rejected findings" has no baseline.

## Goals

- Every finding the pipeline drops leaves one durable record with a reason.
- Replay can compare what the agents proposed with what survived the filters, per skill, with token cost.
- Clean-PR fixtures can assert that nothing is posted, and held-out fixtures keep us honest about tuning on four PRs.

## Non-goals

- The verifier, tool use, or any change to what gets posted.
- Local-run capture. `src/mistakes/` (merged in #105) owns that. A `discard` record type there is a follow-up for its owner; C1 builds the recorder so both sinks can use it.
- C3 numbers, C4, C5, and the verifier kept-real/dropped-real metric (needs D1).

## Anti-goals

- A recording failure that fails or slows a review.
- A schema that implies a discarded finding was posted.
- Counting duplicate collapses as discards. Merging two restatements removes no information.

## Approaches

1. **C1 then C2 as two PRs, C3 after data accrues.** Chosen. C1 unblocks D1, B9 and F3. C2 needs no new production data. C3's input (corpus rows written after B2, deployed 2026-11-02) is empty today.
2. **C1 only.** Smallest, but leaves replay unable to measure B3, C3 or E2 criteria.
3. **C1 to C3 in one pass.** C3 would run on an empty corpus.

## Design

### C1: discard recorder

**Reasons.** `SUPPRESSED_SETTLED`, `SUPPRESSED_OPEN`, `RETRACTION`, `OFF_DIFF` (with sub-codes `OFF_DIFF_PATH`, `OFF_DIFF_LINE`, `BAD_RANGE`), `CAP`, `DISCARDED_BY_VERIFY` (reserved, no source until D1), and `RESOLVED_LOCATION` for the resolved-key skip in `mergeReviewsDetailed`. The last is an addition to the parent spec's list: that skip silently drops findings today (bead `ai-review-bot-etv`) and measuring it is the cheapest way to size the bug.

`SUPPRESSED_OPEN` findings are held, not lost: they still count toward the verdict. They get a record with `disposition: "held"`; every other reason is `"dropped"`.

**Not recorded.** Dedupe and merge collapses (restatements, not discards), the advisory severity cap, and suggestion-block drops (the comment still posts).

**Collection.** A small `Discard` value (`reason`, `disposition`, `title`, `path`, `line`, `severity`, `skill` or null, `provider`) pushed at each drop site inside `buildReview`. Per-agent drops (settled, open, retraction) have the agent index, so they carry the skill. Later drops (off-diff, cap, resolved location) get the skill from the existing provenance map when the finding's key is found there, else null. `buildReview` returns the list on its result.

**Sinks.**

- All paths: one `console.log("finding discarded", …)` per record, next to `logAgentRecords`. Vercel logs show these.
- Hosted, when `IMPROVE_ENABLED`: insert into a new table `finding_discards` at the same call site that runs `capturePostedReview` ([src/github-app.ts](../../../src/github-app.ts)).
- The `agents` marker in the review body stays as it is, because it has a 4 KB budget.

**Deviation from the parent spec.** The spec asks for a nullable column on the corpus. `finding_catalog` holds posted comments only: `posted_at` and `natural_key` are not null and a discard has no comment id. A nullable column would force dropped findings into rows that read as posted. A separate table is the call. The acceptance criterion (a migration and a repo test) is unchanged.

**Table.** `finding_discards(id, repo, pr_number, review_sha, provider, reason, disposition, natural_key, path, line, severity, title, skill nullable, created_at)`. Migration through `pnpm db:generate`, checked in under `src/improve/db/migrations/`. Repo test follows `repo.test.ts` (`createTestDb()` on pg-mem, raw `db.execute` readback).

**Acceptance.** Each reason has a test that triggers its drop site and sees one record. A recording error is caught, logged once, and the review still posts. Migration applies on a clean test DB.

### C2: replay traces

**Fixture additions.** Each round may carry `candidates` (what the agents proposed: title, path, line, severity, skill) and `usage` (tokens per skill). A fixture may carry `expect: { clean: true }`, meaning the live run must post zero findings. Existing fixtures stay valid.

**Post-filter trace.** The live tier currently runs `runAuditPass` alone, which skips suppression, merge, the cap and anchor validation. The trace must call the same exported functions the posting path calls (`suppressInReview`, `mergeReviewsDetailed`, `dropRetractions`, `buildReviewComments`), composed in one place in `src/replay/`, never copies of their logic. If an exported function cannot be called without the whole of `buildReview`, the builder records candidates only and labels the post-filter trace approximate in the report. The builder decides this from the code.

**Join rate.** Of the live candidates in a round, the share that the ledger matcher joins to a labelled fixture claim. A low rate means the labels cannot judge what the live pipeline now says, so rejection numbers mean less. `computeMetrics` reports it.

**Fixtures to record.** At least 2 held-out PRs, chosen from merged PRs with both bots' reviews that were not used to design B1 to B6, and marked `heldOut: true`. At least 2 clean PRs: first-round approvals with no posted findings. The builder picks them with `gh` and records them with `ai-review replay --record`.

**Acceptance.** `computeMetrics` reports join rate; a clean fixture fails the run if the live pipeline posts anything; candidate and post-filter counts and token usage per skill appear in the live report; `pnpm test` covers the new fixture fields.

### C3 timing

C3 starts when the corpus holds at least 100 finding rows written after B2, and runs leave-one-lens-out once through `replay --live` with a cost cap. The 100-row threshold is my call.

## Constraints

- TDD: every behavior change has a failing test first.
- `src/mistakes/` and `src/auth.ts` stay out of webhook paths. The recorder lives with the review code and has no CLI-only imports.
- Fixture claims are small-sample (about 234 claims); results are directional.

## Delivery

C1 on this branch: spec, then plan, then code, one PR through `/no-mistakes`. C2 on its own branch and PR afterwards, same spec.

## Left to the builder

Names and file layout of the recorder, how the provenance lookup finds a skill for late drops, the exact SQL types, and the choice of held-out and clean PRs.
