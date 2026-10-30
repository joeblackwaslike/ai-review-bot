# Claude first-pass accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify why authors rejected Claude's first-seen findings on the replay fixtures, then ship a fix for the largest class a heuristic can detect, with a measured margin.

**Architecture:** A pure classifier module (`src/replay/classify.ts`) reads fixtures and labels, applies deterministic filler and stale rules, merges them with two blind model labelings stored in `*.classes.json` files, and feeds a report section in `ai-review replay`. The fix is chosen from the counts and gated by the recall guard.

**Tech Stack:** TypeScript ESM, Vitest, Biome, pnpm. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-10-29-claude-first-pass-accuracy-design.md](../specs/2026-10-29-claude-first-pass-accuracy-design.md)

## Global Constraints

- Named exports only, `.js` import suffixes, tests colocated (`src/replay/*.test.ts`).
- pnpm only. Implementers run no installs and use scoped biome fixes (`pnpm exec biome check --write <files>`), never unscoped.
- Every behavior test is written first and seen failing; the red output is quoted in the task report.
- Classes are mutually exclusive, first match wins: filler, stale, contradicted, speculative, other.
- Disagreement between the two model labelers makes a claim `unadjudicated`; the count is reported; nothing goes to Joe.
- A fix ships only with zero removals of fixed claims. Recall guard and `negativePairs` keep passing.
- Sprint cost cap for the live tier: `--max-cost 6`.
- Classification files are provisional until Codex has cross-checked them.
- Work in `.worktrees/sprint4-claude-accuracy` on branch `sprint4-claude-accuracy`. Verify `pwd` and branch before each git write.

## Review Focus

- A real finding whose title starts with "No" ("No test coverage for the new parser") must not be classed or filtered as filler. Filler means the text says nothing is wrong, not that it names an absence.
- A filler phrase inside a quoted code string or a suggestion block in an otherwise real finding.
- Empty or missing `text`, and body-table claims with `commentId: null` and no thread.
- A claim labeled `fixed` that matches a filler phrase must never be dropped (recall).
- A `.classes.json` file in the fixtures directory must not be loaded as a fixture by `replayAll` or `liveAll`.

## File Structure

- Create `src/replay/classify.ts`: types, deterministic rules, summary, agreement.
- Create `src/replay/classify.test.ts`.
- Modify `src/replay/command.ts`: exclude `.classes.json` from `FIXTURE_FILE`; print the class report in `replayAll`.
- Modify `src/replay/command.test.ts`.
- Create `src/replay/fixtures/<fixtureId>.classes.json` for the three Claude fixtures.
- Task 3 files are decided from the counts (see Task 3).

### Task 1: Classifier module and fixture-file hygiene

**Files:**
- Create: `src/replay/classify.ts`, `src/replay/classify.test.ts`
- Modify: `src/replay/command.ts:41` (`FIXTURE_FILE`), `src/replay/command.test.ts`

**Interfaces:**
- Produces:
  - `type FalsePositiveClass = "filler" | "stale" | "contradicted" | "speculative" | "other"`
  - `interface ClassRecord { claimId: string; rules: FalsePositiveClass | null; claude: FalsePositiveClass | null; codex: FalsePositiveClass | null; final: FalsePositiveClass | "unadjudicated"; reactionOnly: boolean }`
  - `interface ClassFile { fixtureId: string; provisional: boolean; records: ClassRecord[] }`
  - `isFillerText(title: string, text: string): boolean`
  - `ruleClass(f: ReplayFixture, c: PostedClaim, label: ClaimLabel): "filler" | "stale" | null`
  - `firstSeenRejected(f: ReplayFixture, labels: LabelFile): PostedClaim[]` (rejected label, not the `later` side of any repeat pair, confirmed or proposed)
  - `resolveFinal(r: Pick<ClassRecord, "claude" | "codex">): FalsePositiveClass | "unadjudicated"` (equal non-null labels win; anything else is `unadjudicated`)
  - `summarizeClasses(files: ClassFile[], rejectedTotal: number, unadjudicatedLabels: number): ClassSummary` with counts per class, `classified`, `unadjudicated`, `agreement: { agreed: number; of: number }`
  - `formatClassReport(s: ClassSummary): string`
- Consumes: `ReplayFixture`, `PostedClaim`, `ClaimLabel`, `LabelFile` from `src/replay/types.ts`.

- [ ] **Step 1: Write failing tests** in `classify.test.ts`, using fixture-shaped literals from `src/replay/testkit.ts`:
  - `isFillerText` is true for "No new findings beyond prior reviews", "Nothing to flag", "matches the design", "No code changes this round".
  - `isFillerText` is false for "No test coverage for the new parser", "No retry on 429", and for a real finding that quotes "nothing to flag" inside a code span.
  - `ruleClass` returns `stale` when the thread has `isOutdated: true` at the cutoff and when a reply cites a commit SHA older than the round's head; returns `null` when only a hunk in the round's own delta touches the anchor.
  - `firstSeenRejected` excludes a claim that is the `later` side of a repeat pair.
  - `resolveFinal`: `{claude:"filler",codex:"filler"}` gives `filler`; `{claude:"filler",codex:"speculative"}` and any `null` give `unadjudicated`.
  - `summarizeClasses` counts add up: sum of class counts plus `unadjudicated` equals the number of records.
  - A test that loads the three committed Claude label files and asserts `firstSeenRejected(...).length` totals 46 (22, 10 and 29 raw rejected labels, minus 15 repeats).
- [ ] **Step 2: Run** `pnpm test src/replay/classify.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the interfaces above in `classify.ts`. `isFillerText` is a tested phrase list applied to the title and to the first sentence of the text only, with fenced and inline code removed first. `ruleClass` uses `ThreadEvidence.isOutdated` and reply text containing a commit SHA found in `commitsSince` of rounds before `c.roundIndex`.
- [ ] **Step 4: Failing test for hygiene.** In `command.test.ts`, add a `.classes.json` file to the temp fixtures dir and assert `runReplay` still replays the same fixture count and does not fail. Run, see it FAIL.
- [ ] **Step 5: Change** `FIXTURE_FILE` to also exclude `.classes.json`. Run `pnpm test src/replay` and see PASS.
- [ ] **Step 6: Commit** `feat(replay): classify rejected findings by cause`.

### Task 2: Classification data and report

**Files:**
- Create: `src/replay/fixtures/joeblackwaslike__{agent-skills__10,ai-listings__74,stealth-browser__1}__anthropic.classes.json`
- Modify: `src/replay/command.ts` (`replayAll`), `src/replay/command.test.ts`, `src/replay/snapshot.test.ts` if its snapshot covers the report

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: a class report block printed after `formatReport(...)` when any `*.classes.json` exists.

- [ ] **Step 1 (orchestrator, not a subagent): build the worklist.** Run a small script that writes `rules` for every claim from `firstSeenRejected`, and a blind input file per fixture holding claim text, title, anchor, severity, round, thread replies, and commit metadata, with the `rules` result removed.
- [ ] **Step 2: Claude subagent labels** every claim in the worklist, one class each, using the spec's definitions, writing `claude` into the records. It does not see `rules`.
- [ ] **Step 3: `codex:codex-rescue` labels** the same worklist blind, writing `codex`. Keep the labels as `unadjudicated` where `resolveFinal` says so.
- [ ] **Step 4: Write the `.classes.json` files** with `provisional: true`, `reactionOnly` set for low-confidence rejected labels, and `final` from `resolveFinal`.
- [ ] **Step 5: Failing test** in `command.test.ts`: with a `.classes.json` present, `runReplay` output contains `classified`, a count per class, `agreement`, and `unadjudicated`. Run, see it FAIL.
- [ ] **Step 6: Print the report** in `replayAll` via `formatClassReport`. Run `pnpm test src/replay`, PASS. Update the snapshot only if a snapshot test covers this output, and say why in the commit.
- [ ] **Step 7: Run** `bun src/cli.ts replay`. Record the class table, `classified of 46`, agreement k of n, and the unadjudicated count.
- [ ] **Step 8: Check rule accuracy leave-one-fixture-out** (tune phrase list on two fixtures, score on the third, rotating). Record per-fold agreement between `rules` and the model labelers for filler and stale.
- [ ] **Step 9: Commit** `feat(replay): add false-positive class files and report`.

### Task 3: Fix the largest fixable class (gated by Task 2 data)

**Gate (the orchestrator decides after Task 2, and amends this task in writing before dispatch):**
1. Rank the classes by count. Apply the spec's fixable rule.
2. If the winning class has fewer than ten members, or any candidate rule would remove a `fixed` claim on the fixtures, ship no heuristic. Skip to Task 4 with a recommendation.
3. Otherwise write the amended task with exact files and signatures.

**Expected shape if filler wins** (a guess until the counts exist):
- Create `src/filler-filter.ts` exporting `isFillerFinding(f: { title: string; text: string }): boolean`, reusing `isFillerText` from `src/replay/classify.ts` (move the phrase list to a shared module if the import direction is wrong; webhook code must not import from `src/replay/`).
- Apply it in the merge path in `src/review.ts` (`mergeReviews`) before inline and general findings are deduplicated, so a dropped finding never affects event aggregation. An all-filler round returns `APPROVE` as today's zero-finding case does.
- Tests, each written first: fixture filler claims are dropped; every `fixed` claim in the three Claude fixtures survives; "No test coverage for the new parser" survives; `REQUEST_CHANGES` is not produced from a lone filler finding.
- Offline margin check as a test: run the filter over all 139 labeled Claude claims; assert zero removals among `fixed` claims, and print removals among rejected and unadjudicated claims.

### Task 4: Before and after, and verification against real GitHub

- [ ] **Step 1:** On `origin/main` (a clean checkout of 90b3aca), run `bun src/cli.ts replay` and `bun src/cli.ts replay --live --rounds 2 --max-cost 3`. Save both outputs to the scratchpad as the "before".
- [ ] **Step 2:** On the branch, run the same two commands. Report class counts in live output where the targeted class is text-classifiable, and the fixed-claim matches before and after. Stay inside the $6 total.
- [ ] **Step 3: Real GitHub check.** Re-run `bun src/cli.ts replay --record <pr-url> --provider anthropic --bot anthropicreviewbot --fixtures <scratch dir>` for stealth-browser#1, ai-listings#74 and agent-skills#10 and diff the claim counts against the committed fixtures. Any new code path that reads GitHub state gets a fake in its test that asserts the request shape.
- [ ] **Step 4: Agent logs.** Re-check `~/.ai-review/logs/agents.jsonl` and `gh api` for `ai-review:agents` markers on the three PRs and on recent Claude bot reviews. State what was found.
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test`. All green.
- [ ] **Step 6:** Whole-branch review on the most capable model. Fix every real finding.
- [ ] **Step 7:** `/no-mistakes` with a full intent, then `/pr-loop`. Merge when the gate clears. `bd close ai-review-bot-w9b.3`.
