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

`SUPPRESSED_OPEN` findings are held, not lost: the entry they restate stays open and carried, so they are not re-posted. They get a record with `disposition: "held"`; every other reason is `"dropped"`. `held` means "restated an open entry". It does not promise the entry blocks the verdict: an advisory or pathless P2/P3 restatement is also `held`.

**Not recorded.** Dedupe and merge collapses (restatements, not discards), the advisory severity cap, and suggestion-block drops (the comment still posts).

**Collection.** A small `Discard` value (`reason`, `code` for `OFF_DIFF` and null otherwise, `disposition`, `title`, `path`, `line`, `severity`, `skill` or null, `provider`) pushed at each drop site inside `buildReview`. The repo owner and PR come from the review context when the record is written. Per-agent drops (settled, open, retraction) have the agent index, so they carry the skill. Later drops (off-diff, cap, resolved location) get the skill from the existing provenance map when the finding's key is found there, else null. `buildReview` still returns `ReviewDecision | null`; it flushes the list in a `finally` through an optional `recordDiscards` callback on its context, so a run that posts nothing or throws still records.

**Sinks.**

- All paths: one `console.log("finding discarded", …)` per record, next to `logAgentRecords`. Vercel logs show these.
- Hosted, when `IMPROVE_ENABLED`: insert into a new table `finding_discards` at the same call site that runs `capturePostedReview` ([src/github-app.ts](../../../src/github-app.ts)).
- The `agents` marker in the review body stays as it is, because it has a 4 KB budget.

**Deviation from the parent spec.** The spec asks for a nullable column on the corpus. `finding_catalog` holds posted comments only: `posted_at` and `natural_key` are not null and a discard has no comment id. A nullable column would force dropped findings into rows that read as posted. A separate table is the call. The acceptance criterion (a migration and a repo test) is unchanged.

**Table.** `finding_discards(id, provider, owner, repo, pr, review_sha, reason, code nullable, disposition, natural_key, path nullable, line nullable, severity nullable, title, skill nullable, created_at)`, with a unique index over provider, owner, repo, pr, review sha, reason, natural key, `coalesce(skill, '')` and `coalesce(line, -1)`. The skill is in the key so five skills restating one finding stay five rows, which C3 needs; the line is in the key because the natural key hashes only path and title. Migration through `pnpm db:generate`, checked in under `src/improve/db/migrations/`. Repo test follows `repo.test.ts` (`createTestDb()` on pg-mem, raw `db.execute` readback).

**Acceptance.** Each reason has a test that triggers its drop site and sees one record. A recording error is caught, logged once, and the review still posts. Migration applies on a clean test DB.

### C2: replay traces

**Fixture additions.** A round may carry `trace: {candidates, posted, usage}`. `candidates` holds what the agents proposed (title, path, line, severity, skill), `posted` what survived the filters, and `usage` tokens per skill. Skills are named by file, with the `.md` suffix, as the hosted corpus names them. A fixture may carry `expect: {clean: true}` and `heldOut: true`. `schemaVersion` stays 1 and existing fixtures stay valid.

**Live tier.** The model is routed per round from that round's real compare files, so a large round no longer runs on the cheapest tier. The agents see a diff numbered on its right side, as in production. `runAuditPass` returns an additive `usageBySkill`, and the live report prints candidate and posted counts and token usage per skill.

**Post-filter trace.** `postFilterTrace` in `src/replay/trace.ts` calls the posting-path functions in production order: per agent `suppressInReview` and, when `REVIEWER_TUNING.dropRetractions` is on, `dropRetractions`; then `mergeReviewsDetailed`, `sanitizeInlineComments`, `capInlineComments`, `buildReviewComments` and `routeDroppedComments`. The cap was inline in `buildReview`, so it moved into an exported `capInlineComments` in `src/review.ts` with no change in behaviour. These filter steps are exact. The ledger they read is approximate. The trace skips the `withFingerprints` pre-step, neutralises `resolveRelations`, builds round i's ledger from the fixture's earlier rounds with `holdable()` in `src/replay/pipeline.ts` instead of production's `holdableLedger`, has no triage or resolved-location step, and validates anchors against all compare files.

**Join rate.** `computeMetrics` reports `joinRate {joined, candidates}` for fixtures with a trace. It counts distinct candidates (by path, line, title) that `isSameClaim` joins to any labelled claim of the fixture. The join uses `JOIN_CLAIM_MATCH`: the same path and a title similarity of 0.33 within 3 lines, looser than the 0.5 bar used for same-review dedupe. That bar is provisional because one fixture produced it, and the rate is a lower bound. A test-gap candidate anchored on the source line misses a claim in the test file, and a candidate title under 3 tokens never joins. A low rate means the labels cannot judge what the live pipeline now says.

**Clean check.** A fixture with `expect.clean` makes offline `ai-review replay` exit 1 when any saved trace round posted something, and `ai-review replay --live` exit 1 when the fixture would post. A clean fixture with no trace gets an "unchecked" warning offline. A clean fixture without a labels file fails live. The check shows disagreement with the old bot's clean approval and does not prove a false positive. ai-review-bot#80 was approved clean, contained a real defect (bead `ai-review-bot-5c4`), and lost its `expect.clean`.

**Flags.** `--live --save-trace` writes traces into the fixtures through a temp file and rename, keeping the file mode and key order. `--record ... --held-out` and `--expect-clean` set the fixture flags. A re-record keeps `heldOut` and `expect`, drops saved traces and says so. A flag outside its mode exits 2.

**Fixtures.** Held-out, both providers: ai-review-bot#70 and ai-review-bot-demo#2, labels provisional. Clean: ai-review-bot-demo#3 (anthropic, untraced until the Claude subscription session is renewed) and ai-review-bot#94 (openai, passes). ai-review-bot#80 (openai) stays without `expect` as a data point.

**Findings from the first traces.**

- The live tier always ran on the cheapest model. Per-round routing fixed that.
- ai-review-bot#80, approved clean by the old bot, contained a real defect that today's pipeline flags.
- On demo#2 (openai) the join rate was 0/8 under the 0.5 title bar and is 1/4 under `JOIN_CLAIM_MATCH` with distinct counting.
- The Anthropic traces are not recorded yet. Old-format severities are recorded as P3 (bead `ai-review-bot-980`).

**Side effect on production.** `claimTitle` and `splitInlineClaims` in `src/replay/claims.ts` also feed the ledger rebuild and the posted-comment key. Recovering real titles from old-format reviews changes ledger titles on PRs that still carry them, so a one-word title such as "Medium" can no longer sit in the ledger unmatched. `src/claim-dedupe.ts` gained an optional `nearby` match option, and its default behaviour is unchanged.

**Acceptance.** `computeMetrics` reports join rate. A clean fixture fails the run when its trace shows anything posted. Candidate and posted counts and token usage per skill appear in the live report. `pnpm test` covers the new fixture fields.

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
