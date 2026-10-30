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

### Task 3: Drop self-retracted findings (amended after Task 2 data)

**Status.** Built and measured, then retired from the merge path because the margin stayed thin by the spec's rule. The rule now lives in `src/replay/retraction-rule.ts` as a measurement only, and the merge and tuning changes below were removed. The spec Results section has the numbers. The text below records the plan as it was written.

**Gate result.** First-seen rejected Claude findings, classified by Claude and Codex blind (agree on 39 of 46): contradicted 16, filler 15, other 8, unadjudicated 7, stale 0, speculative 0. Contradicted is the largest class but is author judgment, so no rule over the finding can detect it. Filler is the largest detectable class. It has two kinds: 7 short body-table findings ("No new findings beyond prior reviews") and 8 long inline findings that retract themselves in the last sentence ("No actionable defect found", "this is not itself a bug", "retracted"). Today's `isFillerText` reads only the title and first sentence and agrees with the models on 2 of 16.

**Files:**
- Create: `src/self-retraction.ts`, `src/self-retraction.test.ts`
- Modify: `src/replay/classify.ts` (`isFillerText` delegates to the shared detector so the rule and the filter are one definition), `src/review.ts` (`MergeOptions`, `MergeOutcome`, `mergeReviewsDetailed`, the call site near line 2349), `src/reviewer-tuning.ts`, `src/replay/classify.test.ts`, `src/replay/command.ts` plus a new `src/replay/filter-margin.ts`

**Interfaces:**
- Produces: `isSelfRetracted(f: { title: string; body: string }): boolean`. It strips fenced and inline code and markdown emphasis, splits the text into units (each line or list item, then each sentence), and checks the last unit of the title and of the body against a tested phrase list. A phrase family that needs the whole finding (for example "no new findings") applies only when the title or body is a single sentence. "No actionable defect" must be within four words of the end unless it opens a one-sentence finding. A contrast word before or after the phrase keeps the finding (but, however, although, though, unless, except, whereas, yet, while), as do a request after it (consider, should, just confirm) and an exception after it (beyond, other than, apart from, aside from, except).
- Produces: `droppedFamilies(f)`, the shared drop rule: only P2 and P3 findings, and never one marked `suppressible: false`.
- Produces: `MergeOptions.dropSelfRetracted?: boolean`, `MergeOutcome.retracted: number`, `ReviewerTuning.dropSelfRetracted: boolean` (true).
- Produces: `filterMargin(fixtures, labelFiles, classFiles)` returning, per fixture and total, hits among agreed-filler, hits among other classes, hits among unadjudicated labels, and hits among `fixed` claims.
- Consumes: Task 1 and 2 outputs.

**Rules:**
- The filter never drops a P0 or P1 finding, or one marked not suppressible.
- It runs before the same-claim dedupe, on both general findings and inline comments, so event aggregation sees only surviving findings. A round where every finding is dropped yields the zero-finding result the merge already handles.
- The count is returned in `MergeOutcome.retracted` and logged where `collapsed` is logged; nothing is dropped silently.
- Hard assertion in a test: zero hits among the 17 `fixed` Claude claims, over claim text (`PostedClaim.text` as body, `title` as title).
- The test pins the exact list of hit claim IDs so any change is deliberate.
- Margin report block printed by `replay`: `self-retraction filter: removes k of 15 filler, a other-rejected, u unadjudicated, 0 of 17 fixed`.
- Report per-fixture hit counts, and flag phrases that match in only one fixture.
- Real out-of-sample check is the live tier: the filter's `retracted` count and the raw finding count from the same live run give before and after at once. Live hits are then judged blind by Claude and Codex like the fixtures.

**Steps (TDD):**
- [ ] Write failing tests: positives from the fixture tails above (one per phrase family), negatives "No test coverage for the new parser", "No retry on 429", a finding whose last sentence is "no functional bug on the happy path, but a retry loses the token", a phrase only inside a code span, empty body, a P0 with a retracting tail (kept by the merge).
- [ ] Failing merge tests: option on drops a retracted inline and general finding and sets `retracted`; option off keeps them; an all-retracted round gives no findings.
- [ ] Failing margin test with the pinned hit IDs and the zero-fixed assertion.
- [ ] Implement, run, commit `feat(review): drop findings that retract themselves`.

### Task 4: Before and after, and verification against real GitHub

- [ ] **Step 1:** On `origin/main` (a clean checkout of 90b3aca), run `bun src/cli.ts replay` and `bun src/cli.ts replay --live --rounds 2 --max-cost 3`. Save both outputs to the scratchpad as the "before".
- [ ] **Step 2:** On the branch, run the same two commands. Report class counts in live output where the targeted class is text-classifiable, and the fixed-claim matches before and after. Stay inside the $6 total.
- [ ] **Step 3: Real GitHub check.** Re-run `bun src/cli.ts replay --record <pr-url> --provider anthropic --bot anthropicreviewbot --fixtures <scratch dir>` for stealth-browser#1, ai-listings#74 and agent-skills#10 and diff the claim counts against the committed fixtures. Any new code path that reads GitHub state gets a fake in its test that asserts the request shape.
- [ ] **Step 4: Agent logs.** Re-check `~/.ai-review/logs/agents.jsonl` and `gh api` for `ai-review:agents` markers on the three PRs and on recent Claude bot reviews. State what was found.
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test`. All green.
- [ ] **Step 6:** Whole-branch review on the most capable model. Fix every real finding.
- [ ] **Step 7:** `/no-mistakes` with a full intent, then `/pr-loop`. Merge when the gate clears. `bd close ai-review-bot-w9b.3`.
