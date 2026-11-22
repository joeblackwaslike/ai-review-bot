# Diff Model Matching v2 Implementation Plan

> **Historical implementation plan.** Review changed thresholds, language scope and class rules after it was written, so the spec and the code are authoritative wherever they differ, including this plan's Global Constraints and thresholds.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the diff model so it finds same-file moves, blocks down to one line, reformatted and re-indented moves, function-to-method conversions, and patch-visible copies.

**Architecture:** Keep the line matcher as the first pass. Add distinctiveness-based acceptance, then a token-stream pass over unclaimed lines, then reshape (signature and receiver) handling, then a copy pass. Every new equivalence gets its own independent implementation in the checker. One shared work budget bounds a whole change.

**Tech Stack:** TypeScript, Vitest, pnpm, Biome. Code in `src/diff-model/` and `src/moved-blocks.ts`.

**Spec:** `docs/superpowers/specs/2026-11-21-diff-model-matching-v2-design.md`

## Global Constraints

- `findMovedBlocks()` in `src/moved-blocks.ts` and `push-shape.ts` behavior must not change. New matcher behavior is behind options that only `findRelocations` passes.
- No operation may say "safe", "unchanged behavior" or "functional".
- A claim the checker cannot verify independently is dropped and counted in `droppedClaims`. The checker must not call matcher functions for an equivalence it verifies. Sharing a data constant such as the operator table is allowed.
- Thresholds err toward a miss. The bar is zero added operations over the last 150 commits that are not a true move or copy. Starting values: 30 non-space characters for a 1 to 4 line seed, 40 for a definition, 5 counted lines or a 3-line definition for copies.
- Work budget limits per change: 200,000 tokens, 5,000 candidates, 16,000,000 alignment cells, counted in work units, never time. The 2,000 ms post-hoc cap stays.
- Unknown extensions are line-significant. Quote swaps only in JS, TS and Python, only when the string has no quote, backslash or interpolation marker. Blocks failing literal-context safety compare by raw lines.
- `DivergenceClass` gains `signature` and `receiver`. `OperationType` gains `copy`. `Operation.shape?: { reindent?: number; sourceNew?: boolean }`.
- No comments in code except where nothing else works. No section-banner comments. Docstrings on exported functions. Tests are named by behavior.
- Gates after every PR group: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm config:check`, `pnpm replay --seeds --check`.
- Commit groups map to PRs (A: tasks 1 to 4, B: tasks 5 to 9, C: tasks 10 to 14). Do not interleave.

## Review Focus

- A one-line move of a line that also appears elsewhere in the patch must not match (uniqueness).
- Two identical short helper definitions, one deleted and one added elsewhere, must not pair.
- An import line moved between files must not produce an operation.
- A `-old / +new` edit of one spot must not become a same-file move.
- `a + ++b` against `a++ + b` must not be exact.
- `authorize(user)` becoming `this.authorize(user)` must appear as a `receiver` divergence with the original text.
- The same new handler added in two files must say both are new and keep full review weight.
- A reformatted template literal must stay unmatched.
- A change with thousands of unique one-line moves must stay within the work budget and return deterministic output.

## Shared fixtures

Seeds live under `src/replay/seeds/<OP-ID>/<variant>/` with `truth.json`. `src/replay/seeds/detect.test.ts` asserts the seed count and that detection equals truth. Measurement script: `/private/tmp/claude-501/-Users-joe-github-joeblackwaslike-ai-review-bot/4ca962c7-f964-42ea-b84a-88651a1a4a2d/scratchpad/measure.ts` (runs `findRelocations` over the last 150 commits). Copy it to the same scratchpad path for each PR group if it is missing.

---

# PR A: same-file moves and small blocks

### Task 1: Change regions and same-file pairing

**Files:**
- Modify: `src/moved-blocks.ts` (`Run`, `extractRuns`, `collectCandidates`, `selectMatches`)
- Test: `src/moved-blocks.test.ts`

**Interfaces:**
- Produces: `Run.region: number` (equal for runs between the same two context lines or hunk boundaries). `selectMatches(deleted, added, minLines, accept?, options?: { allowSameFile?: boolean })`. `collectCandidates` skips a same-file pair unless `allowSameFile` and the two runs have different `region` values.
- Consumes: existing `Run`, `Candidate`.

- [ ] **Step 1: Write failing tests** in `src/moved-blocks.test.ts`: "pairs a deleted and an added block in different regions of one file when allowSameFile is set", "does not pair runs of one change region", "keeps findMovedBlocks cross-file only".
- [ ] **Step 2: Run** `pnpm vitest run src/moved-blocks.test.ts --reporter=dot` and confirm the first two fail.
- [ ] **Step 3: Implement.** Increment a region counter at every context line and hunk header in `extractRuns`. Thread `options` through `selectMatches` to `collectCandidates`.
- [ ] **Step 4: Run** the file's tests and `pnpm vitest run src/push-shape.test.ts --reporter=dot`; both pass.
- [ ] **Step 5: Commit** `feat(moved-blocks): optional same-file pairing across change regions`.

### Task 2: Work budget

**Files:**
- Create: `src/diff-model/budget.ts`
- Test: `src/diff-model/budget.test.ts`

**Interfaces:**
- Produces: `class WorkBudget { constructor(limits?: Partial<BudgetLimits>); spendTokens(n: number): boolean; spendCandidates(n: number): boolean; spendCells(n: number): boolean; readonly exhausted: boolean }` with default limits 200_000 / 5_000 / 16_000_000. Each `spend*` returns false and sets `exhausted` when the limit would be exceeded, and spends nothing then.

- [ ] **Step 1: Write failing tests**: "returns false and marks exhausted when a limit is exceeded", "does not spend on a refused request", "keeps the three pools separate".
- [ ] **Step 2: Run, confirm fail. Step 3: Implement. Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit** `feat(diff-model): work budget for one change`.

### Task 3: Distinctiveness acceptance

**Files:**
- Create: `src/diff-model/acceptance.ts`
- Modify: `src/diff-model/relocation.ts` (replace `isCompactDefinition`, `acceptSeed`, `MIN_*` constants; pass `{ allowSameFile: true }` and a `WorkBudget`; alignment draws cells from the budget)
- Modify: `src/diff-model/declarations.ts` (allow same-file only across different regions)
- Test: `src/diff-model/acceptance.test.ts`, `src/diff-model/relocation.test.ts`

**Interfaces:**
- Produces: `lineInformation(line: string): number` (non-space characters when the line has a non-keyword identifier or a string or number literal that is not the whole line, 0 for closers, bare keywords, imports, requires, uses, re-exports, bare literals). `isUnique(c: Candidate, deleted: Run[], added: Run[]): boolean` (joined normalized text occurs at most once per side across all runs). `acceptSeed(c: Candidate, ctx: { deleted: Run[]; added: Run[] }): boolean`.
- Rule: counted >= 5 keeps today's rule. 1 to 4 counted lines: total information >= 30 and unique. Whole definition (opener keyword, closer outside indent-sensitive files) from 1 line: >= 40 non-space characters and unique.

- [ ] **Step 1: Write failing tests** in `acceptance.test.ts` and `relocation.test.ts`, each named by behavior: "accepts a distinctive one-line statement moved between files", "rejects a repeated line", "rejects two identical short definitions", "rejects an import line", "rejects a bare literal line", "accepts a two-line definition", "reports a block moved within one file", "does not report an in-place edit as a same-file move", "ranks one-line moves below larger ones" (ranking is in `render.ts`, Task 4).
- [ ] **Step 2: Run** `pnpm vitest run src/diff-model --reporter=dot`; confirm the new tests fail.
- [ ] **Step 3: Implement** the three functions. Seed index for 1 to 4 line seeds keys on joined normalized text and skips keys seen more than once per side. Draw tokens, candidates and cells from `WorkBudget`; on exhaustion stop and return verified operations so far.
- [ ] **Step 4: Run** all `src/diff-model` tests; existing relocation tests still pass, adjusting only tests that assert the old floor.
- [ ] **Step 5: Commit** `feat(diff-model): accept small blocks by distinctiveness, allow same-file moves`.

### Task 4: Checker, ranking, seeds, measurement (PR A close)

**Files:**
- Modify: `src/diff-model/relocation-check.ts` (same-file spans; its own information and uniqueness check for seeds under 5 lines), `src/diff-model/render.ts` (rank by lines covered then code divergences; "moved within `file`" wording), `src/diff-model/relocation-check.test.ts`, `src/diff-model/render.test.ts`
- Create seeds: `src/replay/seeds/REL-11/{original,v1}` (same-file reorder, one-line move), `src/replay/seeds/REL-12/{original,v1}` (two-line definition move, repeated-line negative). Update `src/replay/seeds/detect.test.ts` seed count and each `truth.json` (format with `jq --tab`).
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-11-15-diff-model-design.md` threshold paragraph to point at the v2 spec.

- [ ] **Step 1: Write failing tests**: checker "verifies a same-file relocation", "drops a one-line claim whose text occurs twice", render "orders by lines covered", "words a same-file move as moved within".
- [ ] **Step 2: Implement.** Checker implements its own information and uniqueness test; it does not import `acceptance.ts`.
- [ ] **Step 3: Add the seeds** by copying the shape of an existing seed (read `REL-10/original` first), write truth, run `pnpm replay --seeds --check`.
- [ ] **Step 4: Run the 150-commit measurement.** Every operation not a true move is logged with its commit. If any, move a threshold toward a miss and re-run. Record the result in the PR body notes file `.superpowers/sdd/2026-11-21-diff-model-matching-v2/measure-A.md`.
- [ ] **Step 5: Run all gates, commit** `feat(diff-model): same-file and small-block moves with seeds and checker support`.

---

# PR B: token streams, reformat, re-indent

### Task 5: Tokenizer and normalizations

**Files:**
- Create: `src/diff-model/tokens.ts`
- Test: `src/diff-model/tokens.test.ts`

**Interfaces:**
- Produces: `type NewlineClass = "free" | "significant"`; `newlineClass(filename: string): NewlineClass` (free for js, ts, jsx, tsx, java, c, h, cpp, cs, rs, php, css; significant otherwise); `tokenize(lines: readonly string[], filename: string): { tokens: string[]; lineOf: number[] }` using whole multi-character operators longest first and dropping line breaks in free files except after `return`, `throw`, `break`, `continue`, `yield`; in significant files, grouping raw lines into logical lines by bracket depth outside strings and emitting a newline token between logical lines; `normalizeTokens(tokens: string[], filename: string): string[]` (drops a trailing comma before a closing bracket, a trailing semicolon in JS and TS, swaps single for double quotes in JS, TS and Python only for strings with no quote, backslash or interpolation marker).

- [ ] **Step 1: Write failing tests**: "tells a + ++b from a++ + b", "drops line breaks in a free-newline file", "keeps the line break after return", "keeps line breaks outside brackets in Python", "joins a Black-wrapped call into one logical line", "ignores a trailing comma before a closing bracket", "swaps quote style in TypeScript", "keeps quote style in Ruby", "treats an unknown extension as line-significant".
- [ ] **Step 2: Run, confirm fail. Step 3: Implement. Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit** `feat(diff-model): token stream with operator-aware tokens and newline classes`.

### Task 6: Split lexical safety, add relative indentation

**Files:**
- Modify: `src/diff-model/lexical.ts`, `src/diff-model/lexical.test.ts`

**Interfaces:**
- Produces: `literalSafe(lines: readonly string[]): boolean` (no backtick, triple quote, heredoc or `/`); `lexicallySafe` keeps its signature and meaning (literal-safe and not indent-sensitive) so existing callers are unchanged. `relativeIndent(lines: readonly string[]): { shape: string[]; base: number } | null` returns each non-empty line's text prefixed with its indentation minus the block's smallest indent, or null when any line uses a tab or mixes tabs with spaces.

- [ ] **Step 1: Write failing tests**: "literalSafe accepts a Python block", "relativeIndent is equal for a block shifted four columns", "relativeIndent returns null for tabs", "lexicallySafe still rejects indentation-sensitive files".
- [ ] **Step 2 to 4: red, implement, green.**
- [ ] **Step 5: Commit** `feat(diff-model): separate literal safety from indentation, add relative indent`.

### Task 7: Token pass discovery

**Files:**
- Create: `src/diff-model/token-pass.ts`
- Modify: `src/diff-model/relocation.ts` (run the pass after the line matcher on unclaimed lines; claim lines; budget)
- Test: `src/diff-model/token-pass.test.ts`, `src/diff-model/relocation.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `normalizeTokens`, `literalSafe`, `relativeIndent`, `WorkBudget`, `acceptSeed`-style rule from `acceptance.ts` applied to the token range's lines.
- Produces: `findTokenMatches(deleted: Run[], added: Run[], budget: WorkBudget): Candidate[]`. Windows of 8 normalized tokens hashed per run, windows occurring more than twice on a side skipped, cross-run matches merged into maximal ranges, a line joining only when all its tokens fall in the range, resolved largest first, unclaimed lines only. Indent-sensitive files compare `relativeIndent` shapes and set the shift. Blocks failing `literalSafe` are skipped.

- [ ] **Step 1: Write failing tests** (each builds patches with the existing test helpers): "matches a move that was reformatted by Prettier", "matches a Black-wrapped Python call", "matches a Python block moved one level deeper and reports the shift", "matches a YAML block moved one level deeper", "leaves a reformatted template literal unmatched", "does not claim lines the line matcher claimed", "returns exact with no divergence for a reformat-only move".
- [ ] **Step 2 to 4: red, implement, green.** Set `Operation.shape.reindent` (head indent minus base indent).
- [ ] **Step 5: Commit** `feat(diff-model): token-stream pass for reformatted and re-indented moves`.

### Task 8: Checker token equivalence

**Files:**
- Create: `src/diff-model/token-check.ts`
- Modify: `src/diff-model/relocation-check.ts`, `src/diff-model/relocation-check.test.ts`

**Interfaces:**
- Produces: `tokenEquivalent(baseLines: string[], headLines: string[], baseFile: string, headFile: string): boolean`, written independently of `tokens.ts` (own tokenizer and normalizations; may import only the operator-table constant).
- The checker uses it only when line comparison fails and both blocks are literal-safe; indent-sensitive files also require `relativeIndent` equality computed by its own code.

- [ ] **Step 1: Write failing tests**: "drops a claim where only operator order differs (a + ++b)", "drops a claim over a template literal reformat", "verifies a reformatted move", "verifies a re-indented Python move", "drops a tab-indented re-indent claim".
- [ ] **Step 2 to 4: red, implement, green. Step 5: Commit** `feat(diff-model): checker verifies token-level equivalence independently`.

### Task 9: Render, seeds, measurement (PR B close)

**Files:**
- Modify: `src/diff-model/render.ts` ("re-indented N levels" from `shape.reindent` using 4 columns per level, falling back to "N columns"), `src/diff-model/render.test.ts`
- Create seeds: `REL-13/{original,v1}` (Prettier reformat after move, template-literal negative), `REL-14/{original,v1}` (Python re-indent, YAML re-indent). Update detect count and truth.
- Modify: spec threshold paragraph pointer, `CLAUDE.md`.

- [ ] **Step 1: Write failing render test** "says a move was re-indented".
- [ ] **Step 2: Implement, add seeds, run `pnpm replay --seeds --check`.**
- [ ] **Step 3: Run the 150-commit measurement** as in Task 4 step 4, notes to `measure-B.md`. Also run the two adversarial budget tests (thousands of unique one-line moves, many repeated candidates) added to `relocation.test.ts`; assert determinism by running the same input twice.
- [ ] **Step 4: Gates, commit** `feat(diff-model): reformat and re-indent seeds, render, measurement`.

---

# PR C: function-to-method and copies

### Task 10: Signature and receiver reshape in the matcher

**Files:**
- Create: `src/diff-model/reshape.ts`
- Modify: `src/diff-model/types.ts` (new classes and `OperationType`, `Operation.shape`), `src/diff-model/relocation.ts` (use reshape on blocks whose first line is a definition), `src/diff-model/token-pass.ts` (receiver tokens removed from one side to nominate)
- Test: `src/diff-model/reshape.test.ts`, `src/diff-model/relocation.test.ts`

**Interfaces:**
- Produces: `signatureRange(lines: readonly string[], filename: string): { start: number; end: number } | null` (decorators or attributes directly above the opener, plus the opening logical line by bracket depth); `receiverLines(base: string[], head: string[]): number[]` indices of body lines that match only after removing a `self.`, `this.`, `cls.` or `Self::` prefix from one side.
- Each physical signature line becomes one `signature` divergence with its original text. Each receiver line becomes a `receiver` divergence with its original text, excluded from the divergence limit; weight is at least 1 when any exist.

- [ ] **Step 1: Write failing tests**: "pairs a function with the method it became despite a new name and parameters", "reports every line of a four-line signature", "reports a gained this. prefix as a receiver divergence with the original line", "reports a self. prefix removed in method-to-function", "keeps weight at least 1 when only receiver lines differ", "does not pair unrelated functions that share a short body".
- [ ] **Step 2 to 4: red, implement, green. Step 5: Commit** `feat(diff-model): reshape matching for function-to-method conversions`.

### Task 11: Checker for signature and receiver

**Files:**
- Modify: `src/diff-model/relocation-check.ts`, `src/diff-model/relocation-check.test.ts`

**Interfaces:**
- The checker derives signature boundaries from patch text with its own code (decorators, bracket depth) and requires a `signature` divergence on every physical signature line, and a `receiver` divergence on every body line that matches only after prefix removal. It drops a claim that lacks either.

- [ ] **Step 1: Write failing tests**: "drops a claim that hides a receiver change", "drops a claim missing a signature line", "verifies a full function-to-method claim".
- [ ] **Step 2 to 4: red, implement, green. Step 5: Commit** `feat(diff-model): checker verifies signature and receiver divergences`.

### Task 12: Copy pass

**Files:**
- Create: `src/diff-model/copies.ts`
- Modify: `src/moved-blocks.ts` (collect context runs, exported as `collectContextRuns`), `src/diff-model/relocation.ts` or `src/diff-model/index.ts` (run copies after relocation and declarations, on unclaimed lines), `src/diff-model/types.ts`
- Test: `src/diff-model/copies.test.ts`

**Interfaces:**
- Produces: `findCopies(files: PushFile[], claimed: ClaimedLines, budget: WorkBudget): Operation[]` returning `type: "copy"` operations with head-side `from` and `to` spans. Floor is 5 counted lines or a 3-line definition, with the line-matcher alignment and divergence limits. A context source sets no `shape.sourceNew`; an added-block source sets `shape.sourceNew: true`. Review weight for `sourceNew` is max(1, divergences).

- [ ] **Step 1: Write failing tests**: "reports a block that copies visible context lines", "reports a duplicated added block as sourceNew with full weight", "lists edits in a copied block as divergences", "does not copy-match lines a relocation claimed", "ignores a 4-line duplicate that is not a definition", "does not copy against code outside the hunks".
- [ ] **Step 2 to 4: red, implement, green. Step 5: Commit** `feat(diff-model): copy operation for patch-visible sources`.

### Task 13: Checker for copies

**Files:**
- Modify: `src/diff-model/relocation-check.ts` (or new `copy-check.ts`), tests

**Interfaces:**
- Verifies the `from` span exists in the head as added or context lines, the `to` span is added lines, the texts are equal apart from listed divergences, and that `sourceNew` matches whether the source lines are added.

- [ ] **Step 1: Write failing tests**: "drops a copy whose source lines do not exist in the head", "drops a copy that mislabels an added source as context", "verifies a context-source copy".
- [ ] **Step 2 to 4: red, implement, green. Step 5: Commit** `feat(diff-model): checker verifies copy operations`.

### Task 14: Render, seeds, measurement, docs (PR C close)

**Files:**
- Modify: `src/diff-model/render.ts` and tests: `signature` and `receiver` divergences listed with code divergences and original text; copy lines "copied from <span> (source visible in this diff only)"; for `sourceNew`, "duplicate: both occurrences are new"; copies rank below relocations; the 12 operation and 6000 character limits hold.
- Create seeds: `REL-15/{original,v1}` (function to method with new name and receiver prefix), `COP-01/{original,v1}` (context copy, duplicate addition). Update detect count and truth.
- Modify: spec follow-ups pointer, `CLAUDE.md`.

- [ ] **Step 1: Write failing render tests**: "lists a receiver divergence with its original line", "says a duplicate addition is new in both places", "ranks copies below relocations", "keeps the section under the character budget with many copies".
- [ ] **Step 2: Implement, add seeds, run replay check.**
- [ ] **Step 3: Run the 150-commit measurement and the adversarial budget tests**, notes to `measure-C.md`.
- [ ] **Step 4: Gates, commit** `feat(diff-model): render, seeds and measurement for reshape and copy`.

---

# Landing

After task 14 the controller runs the whole-branch review, applies one fix wave, then lands the work as three stacked PRs cut by commit group (A, B, C, with the earlier diff-model commits already on the branch landing first as the earlier stack). Each PR goes through `/self-review`, then `/pr-loop`. The worktree is removed with `wt-reap` after the last merge.
