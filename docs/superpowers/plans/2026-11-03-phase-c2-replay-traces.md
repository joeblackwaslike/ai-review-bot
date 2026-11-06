# Phase C2 replay traces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ai-review replay` record what the agents proposed and what survived the real posting filters, report a join rate, and fail on clean-PR fixtures that would post anything.

**Architecture:** A round in a fixture may carry an optional `trace` (candidates, post-filter `posted`, per-skill token `usage`). `replay --live --save-trace` writes it. The post-filter trace is one new module, `src/replay/trace.ts`, that calls the same exported functions the posting path calls, in the posting path's order; the one inline step (the 50-comment cap) is first extracted into an exported helper. Offline `computeMetrics` reads saved traces, so join rate and the clean check cost no model calls.

**Tech Stack:** TypeScript ESM, Vitest, `gh` CLI for recording, `runAuditPass` for live review.

**Spec:** [docs/superpowers/specs/2026-11-02-phase-c-measurement-design.md](../specs/2026-11-02-phase-c-measurement-design.md) (C2 section). Bead `ai-review-bot-t0c.13`. Where this plan and the spec differ, the Rulings below record why, and Task 6 aligns the spec.

## Rulings (made while mapping the code)

1. The post-filter trace is exact, never "approximate": every posting-path step except the cap is already a standalone export, and Task 3 extracts the cap.
2. `runAuditPass` gains an additive per-skill usage field, because the spec asks for tokens per skill and today only a pass total exists.
3. Fixtures carry candidates in one optional `trace` object per round, written only by an explicit `--save-trace` flag. Plain `--live` stays read-only.
4. `--record` gains `--held-out` and `--expect-clean` flags; it cannot otherwise produce those fields.
5. The clean check can change exit codes: offline `replay` fails when a clean fixture's saved trace posted anything, and `replay --live` returns non-zero for the same reason. Neither runs in CI.
6. Join rate = share of a round's saved candidates that `isSameClaim` joins to any claim in the fixture that has an entry in its labels file (confirmed or provisional).
7. The spec's filter order was wrong. Suppression and retraction run per agent before the merge. The trace follows the real order.

## Global Constraints

- The trace calls the exported posting-path functions; it never reimplements their logic.
- The cap extraction is behavior-preserving: same sort, same stability, same overflow.
- Existing fixtures, `schemaVersion: 1` and `src/replay/__snapshots__/snapshot.test.ts.snap` stay valid and unchanged until Task 5 adds fixtures.
- `src/replay/` is local tooling: it may import `src/audit.ts` (as `live-wiring.ts` already does) and never runs on the webhook path.
- Fixture claims are small-sample (about 234 claims); results are directional.
- TypeScript ESM with `.js` import extensions, named exports only, tests colocated, Biome, no banner comments, docstrings on exports. `pnpm typecheck && pnpm lint && pnpm test` pass before every commit.
- Every new test is shown failing first; quote the failing assertion in the commit body.

## Review Focus

- A fixture with no `trace` renders byte-identical report output and snapshot (Task 1).
- `capInlineComments` keeps the exact order and overflow set the inline code produced, including severity ties (Task 3).
- The trace's step order is suppress, retraction, merge, sanitize, cap, anchor build, route; a P0/P1 dropped off-diff is promoted, not lost (Task 3).
- A clean fixture whose saved trace posted something fails offline and live; one with no trace is reported as unchecked, not as passing (Tasks 1 and 4).
- A saved trace round-trips through JSON and is written in a stable order with no tokens, paths or secrets beyond finding text (Task 4).
- Per-skill usage sums to the pass total (Task 2).

## File Structure

| File | Change |
| --- | --- |
| `src/replay/types.ts` | `CandidateRecord`, `RoundUsage`, `RoundTrace`; optional `Round.trace`, `ReplayFixture.expect`, `ReplayFixture.heldOut` |
| `src/replay/testkit.ts` | Optional overrides on `makeRound` / `makeFixture` |
| `src/replay/metrics.ts` | `joinRate` on `Metrics`; one extra report line when traces exist |
| `src/replay/guard.ts` | `checkClean(fixtures)` returning violations and unchecked ids |
| `src/audit.ts` | `usageBySkill` on the `runAuditPass` result |
| `src/review.ts` | Exported `capInlineComments`; `buildReviewInner` calls it |
| `src/replay/trace.ts` (+test) | New `postFilterTrace` |
| `src/replay/live-wiring.ts`, `live.ts` | Review callback returns findings, candidates, usage, posted; report prints them |
| `src/replay/command.ts`, `record.ts` | `--save-trace`, `--held-out`, `--expect-clean`; clean check exit codes |
| `src/replay/fixtures/` | At least 2 held-out and 2 clean fixtures with labels (Task 5) |
| `CLAUDE.md`, the C2 spec | Describe the above (Task 6) |

---

### Task 1: Trace types, join rate and the offline clean check

**Files:**
- Modify: `src/replay/types.ts`, `src/replay/testkit.ts`, `src/replay/metrics.ts`, `src/replay/guard.ts`, `src/replay/command.ts` (default replay exit code)
- Test: `src/replay/metrics.test.ts`, `src/replay/guard.test.ts`, `src/replay/command.test.ts`, `src/replay/snapshot.test.ts` (must stay green unchanged)

**Interfaces:**
- Produces in `types.ts`:
  - `interface CandidateRecord { skill: string | null; title: string; path: string | null; line: number | null; severity: string | null }`
  - `type RoundUsage = Record<string, { promptTokens: number; completionTokens: number }>` (keyed by skill file name)
  - `interface RoundTrace { candidates: CandidateRecord[]; posted: CandidateRecord[]; usage: RoundUsage }`
  - `Round.trace?: RoundTrace`; `ReplayFixture.expect?: { clean: true }`; `ReplayFixture.heldOut?: true`.
- Produces in `metrics.ts`: `Metrics.joinRate?: { joined: number; candidates: number }`, present only when at least one round has a trace. `formatReport` prints one extra line (`join rate: J/C`) only when `joinRate` is present.
- Produces in `guard.ts`: `checkClean(fixtures: ReplayFixture[]): { violations: string[]; unchecked: string[] }` — `violations` names each clean fixture id and round whose `trace.posted` is non-empty; `unchecked` names clean fixtures with no trace on any round.

- [ ] **Step 1: Write failing tests.** `metrics.test.ts`: a fixture with two rounds, a trace of 4 candidates of which 3 are `isSameClaim`-joined to labelled claims, gives `joinRate` `{ joined: 3, candidates: 4 }`; a fixture with no trace has no `joinRate` and `formatReport` output equals its output before the change (assert against a literal string from the existing format); a claim without a labels entry does not count as a join. `guard.test.ts`: `checkClean` returns the violation `"<id> round 1"` for a clean fixture whose trace posted one item, returns it in `unchecked` when no round has a trace, and returns nothing for a clean fixture whose traces posted nothing and for non-clean fixtures. `command.test.ts`: the default `replay` run exits non-zero for a clean fixture with a violation and prints the unchecked ids as a warning with exit 0.
- [ ] **Step 2: Run them; confirm they fail** (`pnpm vitest run --pool=forks src/replay`).
- [ ] **Step 3: Implement** the types, the `testkit` overrides (`makeRound(index, ids, overrides?)`, `makeFixture(rounds, overrides?)`), `joinRate` using `isSameClaim` from `src/claim-dedupe.ts` against `fixture.rounds[*].claims` that have a `LabelFile.labels` entry, `checkClean`, and the exit-code wiring.
- [ ] **Step 4: Run the whole `src/replay` suite; the snapshot test passes unchanged.**
- [ ] **Step 5: Commit** `feat(replay): add trace types, join rate and the clean-fixture check`.

### Task 2: Per-skill usage and candidate capture in the live tier

**Files:**
- Modify: `src/audit.ts` (`runAuditPass` result), `src/replay/live-wiring.ts`, `src/replay/live.ts`
- Test: `src/audit.test.ts` (or its nearest existing test), `src/replay/live-wiring.test.ts`, `src/replay/live.test.ts`

**Interfaces:**
- Consumes: Task 1's `CandidateRecord`, `RoundUsage`.
- Produces: `runAuditPass` result gains `usageBySkill: Record<string, { promptTokens: number; completionTokens: number }>` whose values sum to the existing `usage` total. `LiveOptions.review` now returns `Promise<LiveReviewOutput>` with `interface LiveReviewOutput { findings: LiveFinding[]; candidates: CandidateRecord[]; usage: RoundUsage }`. `LiveRoundReport` gains `candidates: number`, `joined: number` and `usage: RoundUsage`.

- [ ] **Step 1: Write failing tests.** Audit: with three mocked agent outcomes, `usageBySkill` has one entry per skill and its token sums equal `usage`. Wiring: a mocked `runAuditPass` result with two agent reviews gives `candidates` tagged with each agent's `skill`, one per inline comment and per general finding, in agent order. Live tier: the round report carries `candidates`, `joined` (candidates that `isSameClaim`-match a labelled claim) and `usage`; the per-round printed line includes the counts; existing `matchedFixed` / `matchedRejected` assertions are unchanged.
- [ ] **Step 2: Run them; confirm they fail.**
- [ ] **Step 3: Implement.** Update the existing `live.test.ts` and `live-wiring.test.ts` mocks to the new return type.
- [ ] **Step 4: Run `pnpm vitest run --pool=forks src/audit.test.ts src/replay`; all pass.**
- [ ] **Step 5: Commit** `feat(replay): capture candidates and per-skill usage in the live tier`.

### Task 3: Extract the cap and add the exact post-filter trace

**Files:**
- Modify: `src/review.ts` (extract and call `capInlineComments`), `src/replay/live-wiring.ts` (call the trace)
- Create: `src/replay/trace.ts`, `src/replay/trace.test.ts`
- Test: `src/review.test.ts` (existing cap tests must stay green unchanged)

**Interfaces:**
- Produces in `review.ts`: `export function capInlineComments(comments: ModelInlineComment[], max?: number): { kept: ModelInlineComment[]; overflow: ModelInlineComment[] }` with `max` defaulting to 50 and the severity-rank sort the inline block uses today; `buildReviewInner` calls it and its behavior is unchanged.
- Produces in `trace.ts`: `postFilterTrace(input: { agentReviews: { skill: string; review: ModelReview }[]; ledger: Ledger; files: PullFile[]; tuning: ReviewerTuning }): { posted: CandidateRecord[]; dropped: CandidateRecord[] }` following the posting path's order: per agent `suppressInReview` then, when `tuning.dropRetractions`, `dropRetractions`; `mergeReviewsDetailed`; `sanitizeInlineComments` against `buildValidLinesByPath(files)`; `capInlineComments`; `buildReviewComments`; `routeDroppedComments`. `posted` is the inline comments that would post plus the general findings (including promoted P0/P1); `dropped` is everything removed.
- Consumes: Task 1's `CandidateRecord`; `ledgerFromView` from `src/replay/pipeline.ts` for the ledger at round i (built from the fixture's rounds before i).

- [ ] **Step 1: Write failing tests.** `review.test.ts` / a new `capInlineComments` unit test: 52 comments with a severity mix keep the 50 highest, the overflow is the 2 lowest, a tie keeps merge order (stable), 50 or fewer returns everything in order with empty overflow. `trace.test.ts`, one case per filter, using real inputs: a settled repeat is absent from `posted` and present in `dropped`; with `dropRetractions` on, retraction filler is dropped and with it off kept; a restatement pair collapses to one posted item; an off-diff P2 is in `dropped` and an off-diff P0 is in `posted` as a general finding; 52 comments produce 50 posted inline; an empty `agentReviews` gives empty results. One parity test: build a small PR through `buildReview` with the same inputs and assert the set of posted titles equals `postFilterTrace`'s `posted` titles.
- [ ] **Step 2: Run them; confirm they fail** (`capInlineComments` and the module are missing).
- [ ] **Step 3: Implement** `capInlineComments` (move the block, no logic change), switch `buildReviewInner` to it, then `postFilterTrace`; wire it into the `review` callback so `LiveReviewOutput` also carries `posted`, and `LiveRoundReport` gains `posted: number`.
- [ ] **Step 4: Run `pnpm vitest run --pool=forks src/review.test.ts src/replay`; all pass, including every existing cap test.**
- [ ] **Step 5: Commit** `feat(replay): add an exact post-filter trace and extract capInlineComments`.

### Task 4: Save traces, flag held-out and clean fixtures, gate `--live` on clean

**Files:**
- Modify: `src/replay/command.ts`, `src/replay/record.ts`
- Test: `src/replay/command.test.ts`, `src/replay/record.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: `replay --live --save-trace` writes each round's `trace` (`candidates`, `posted`, `usage`) into that fixture's JSON, keys in a fixed order, array order preserved, 2-space indent plus trailing newline like the existing writer; `replay --record <pr> ... --held-out` sets `heldOut: true`; `--expect-clean` sets `expect: { clean: true }`; `replay --live` returns non-zero when a fixture with `expect.clean` has any round whose live `posted` is non-zero, and prints a one-line reason.

- [ ] **Step 1: Write failing tests** with the fake `GhClient` and a fake `review` callback: `--save-trace` writes the trace and a second identical run produces a byte-identical file; without the flag the fixture file is untouched; `--record --held-out --expect-clean` set both fields and a fixture recorded without them has neither; a clean fixture whose live run posts one item returns non-zero and a clean fixture that posts nothing returns 0; a non-clean fixture that posts items still returns 0.
- [ ] **Step 2: Run them; confirm they fail.**
- [ ] **Step 3: Implement.** Reuse the existing fixture writer; add no new serialization format.
- [ ] **Step 4: Run `pnpm vitest run --pool=forks src/replay`; all pass.**
- [ ] **Step 5: Commit** `feat(replay): save traces and flag held-out and clean fixtures`.

### Task 5: Record the fixtures and save their traces

**Files:**
- Create: `src/replay/fixtures/<owner>__<repo>__<pr>__<provider>.json` and `.labels.json` for at least 2 held-out and 2 clean PRs; update `src/replay/__snapshots__/snapshot.test.ts.snap`
- Test: `src/replay/snapshot.test.ts`

**Interfaces:**
- Consumes: Task 4's flags. Produces the fixtures the spec's acceptance criteria name.

- [ ] **Step 1: Choose PRs with `gh`.** Held-out: merged PRs in the user's repos with both bots' reviews that are not agent-skills#10, ai-listings#74, ai-review-bot#92 or stealth-browser#1. Clean: PRs where a bot's first review approved with no findings. Record the reasons for each choice in the commit body.
- [ ] **Step 2: Record** each with `ai-review replay --record <pr-url> --provider <p> --bot <login> --held-out` (and `--expect-clean` for the clean ones). Labels are auto-generated and stay `provisional: true`; say so in the commit body.
- [ ] **Step 3: Save traces** with `ai-review replay --live --save-trace --max-cost 3` over the new fixtures only; record the spend. If the cost cap stops a fixture, report it and keep the fixtures that finished.
- [ ] **Step 4: Run `pnpm vitest run --pool=forks src/replay`.** The snapshot changes only by the new fixtures' entries; update it and confirm the diff contains nothing else. `ai-review replay` (offline) exits 0, prints the join rate for traced fixtures, and reports the clean fixtures as passing.
- [ ] **Step 5: Commit** `test(replay): record held-out and clean-PR fixtures with traces`.

### Task 6: Docs and spec alignment

**Files:** Modify `CLAUDE.md`, `docs/superpowers/specs/2026-11-02-phase-c-measurement-design.md`.

- [ ] **Step 1:** In `CLAUDE.md`'s replay bullet, document `trace`, `--save-trace`, `--held-out`, `--expect-clean`, the join rate, and the clean check and its exit codes; add `src/replay/trace.ts` to the Key files table; update the test count.
- [ ] **Step 2:** Rewrite the spec's C2 section to match the Rulings above (exact trace, filter order, per-skill usage via `audit.ts`, cap extraction, flags, join-rate definition, clean-check exit codes).
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test` pass; quote the counts.
- [ ] **Step 4: Commit** `docs: describe replay traces`.

## Self-Review

- **Spec coverage:** fixture additions (Task 1), post-filter trace (Task 3), join rate (Task 1), held-out and clean fixtures (Task 5), live report counts and usage per skill (Task 2), clean-fixture failure (Tasks 1 and 4). The verifier kept-real/dropped-real metric stays out by the spec (needs D1).
- **Types:** `CandidateRecord`, `RoundUsage`, `RoundTrace`, `LiveReviewOutput`, `capInlineComments` and `postFilterTrace` use the same names wherever they appear.
- **Proportion:** interfaces and test assertions, not bodies.
