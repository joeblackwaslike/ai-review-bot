# Diff model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic graph of PR objects (files, relocations, renames, mechanical changes, divergences inside moved blocks, test and intent facts) from patches, and render a bounded part of it into the reviewer prompt without editing any diff line.

**Architecture:** A pure `buildDiffModel()` in a new `src/diff-model/` module reads full patches before packing. A renderer produces a summary plus per-file notes. A `prepareDiffInput()` step packs the diff, reads span visibility from the packed result, and hands both prompt builders their sections. The diff text stays byte-identical. A tuning switch ships off, and the model is built and logged either way.

**Tech Stack:** TypeScript ESM (`.js` import extensions, named exports only), Vitest with colocated tests, Biome, zod config schema, pnpm.

**Spec:** [docs/superpowers/specs/2026-11-15-diff-model-design.md](../specs/2026-11-15-diff-model-design.md)

## Global Constraints

- The packed diff text is byte-identical with the model on or off. A test enforces it.
- The analysis reads full patches, not the packed prompt.
- No I/O, no model call, linear in patch size. Build and render never throw out of the review path: on error or timeout, log and omit the section.
- Everything derived from the author (file names, PR body, intent phrases, original code or comment text) passes through `fenceUntrusted()` from `src/prompt.ts`, clipped to 200 characters per value. Fixed instructions stay outside the fence.
- Section cap is `DIFF_MODEL_BUDGET_CHARS`, default 6000, separate from `REVIEW_DIFF_BUDGET_CHARS`. At most 12 operations get detail.
- Whitespace-only and "unchanged" verdicts use raw comparison unless the conservative lexical check confirms a safe context. Do not take whitespace verdicts from `classifyPush()` (bug `ai-review-bot-6je`).
- The renderer never says a change is functional. It reports a code difference.
- Test coupling in this version is PR-wide `testsChanged: boolean | "unknown"`. It is `"unknown"` when the PR file list is incomplete.
- Switch: `REVIEWER_TUNING.diffModel`, default `false`. The model is built and logged even when off.
- Repo gates before any commit: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Review Focus

- A moved block with a changed space inside a multiline template literal must not be reported unchanged.
- A moved function whose guard was deleted must report a `removed` divergence, not "unchanged".
- A file name, PR body or code comment containing `</untrusted_pr_text>` or an instruction must not escape the fence or reach the reviewer as instruction.
- An incremental round must not state "no test files changed" from the delta alone.
- A PR with 100 operations must render within the section cap, ranked, with counts for the rest.

---

### Task 1: Types and file nodes

**Files:**
- Create: `src/diff-model/types.ts`, `src/diff-model/files.ts`
- Test: `src/diff-model/files.test.ts`

**Interfaces:**
- Consumes: `PushFile` from `src/moved-blocks.ts`, `FileKind` and `classifyFile(filename: string): FileKind` from `src/push-shape.ts`.
- Produces: the spec's types exported from `types.ts` (`DiffModel`, `FileNode`, `Span`, `Operation`, `Divergence`, `PrFacts`, `IntentClaim`, `HunkRef`, `CodeRole`), and `buildFileNodes(files: PushFile[]): FileNode[]`.

- [ ] **Step 1: Write the failing tests** in `files.test.ts`: `"classifies kind by path through classifyFile"`, `"parses hunk headers into old and new ranges"` (`@@ -10,42 +10,2 @@` gives `{oldStart:10, oldLines:42, newStart:10, newLines:2}`), `"keeps a file with no patch as a node with no hunks"`, `"carries previous_filename for a rename"`.
- [ ] **Step 2: Run `pnpm vitest run src/diff-model/files.test.ts`.** Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `types.ts` exactly as the spec's model section, with `Span.shown: "full" | "partial" | "none"` and `testsChanged: boolean | "unknown"`; implement `buildFileNodes`. `FileNode.shown` defaults to `"full"` until Task 7 sets it.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(diff-model): types and file nodes`.

### Task 2: Conservative lexical check

**Files:**
- Create: `src/diff-model/lexical.ts`
- Test: `src/diff-model/lexical.test.ts`

**Interfaces:**
- Consumes: `isIndentSensitive(filename: string): boolean` from `src/moved-blocks.ts`.
- Produces: `lexicallySafe(filename: string, lines: readonly string[]): boolean` and `normalizeSafe(filename: string, lines: readonly string[]): string[]` (whitespace-collapsed lines when safe, raw lines otherwise).

- [ ] **Step 1: Write the failing tests:** `"is unsafe for an indentation-sensitive file"` (`.py`, `Makefile`), `"is unsafe when any line has a backtick"`, `"is unsafe when any line opens a triple-quoted string or heredoc"`, `"is safe for plain TypeScript statements"`, `"normalizeSafe returns raw lines when unsafe"`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** A span is unsafe if the file is indentation sensitive or any line contains a backtick, `"""`, `'''` or `<<`. This is deliberately coarse: unknown context means raw comparison. Safe spans normalize with `normalizeCodeLine` from `src/moved-blocks.ts`.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(diff-model): conservative lexical check`.

### Task 3: Relocation matcher with divergences

**Files:**
- Create: `src/diff-model/relocation.ts`
- Test: `src/diff-model/relocation.test.ts`

**Interfaces:**
- Consumes: `PushFile`, `normalizeCodeLine`, `needsSeparator` from `src/moved-blocks.ts`; `normalizeSafe` from Task 2; types from Task 1.
- Produces: `findRelocations(files: PushFile[]): Operation[]`. Each operation has `type: "relocation"`, `from` and `to` spans (base-side numbers for deleted lines, head-side for added), `exact`, `divergences`.

- [ ] **Step 1: Write the failing tests** using small inline patches: `"finds a 40-line function moved between files with no divergence"`, `"reports one changed line inside a moved block as a changed divergence with the original text"` (the `Math.floor` to `Math.round` case), `"reports an inserted line and a removed line as divergences"`, `"reports a deleted guard as a removed divergence"`, `"does not call a block unchanged when a template literal's inner whitespace changed"`, `"reports a reformatted-only move as a relocation with no divergence"`, `"ignores runs under 5 meaningful lines"`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Seed matches from exact normalized runs of at least 5 meaningful lines between deleted and added runs in different files (reuse the run-collection and matching code in `moved-blocks.ts` by exporting what it needs; do not duplicate it). Extend each seed outward over adjacent changed lines, aligning base and head with a longest-common-subsequence over normalized lines; a pair that differs is a `changed` divergence, head-only lines are `inserted`, base-only are `removed`. Tolerance: up to 3 differing lines or 20 percent of the block, whichever is smaller; beyond that, report the exact seed run only. Classify each divergence as comment-only, rename (consistent identifier substitution) or code, per the spec.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(diff-model): relocation matcher with divergences`.

### Task 4: Independent relocation checker

**Files:**
- Create: `src/diff-model/relocation-check.ts`
- Test: `src/diff-model/relocation-check.test.ts`

**Interfaces:**
- Consumes: `Operation` and `PushFile`.
- Produces: `verifyRelocation(op: Operation, files: PushFile[]): boolean`.

- [ ] **Step 1: Write the failing tests:** `"accepts a clean move"`, `"accepts a reformatted-only move"`, `"accepts a move whose divergences are all listed"`, `"rejects a claim that omits a changed line"`, `"rejects a template literal whose inner whitespace changed when the claim says unchanged"`, `"rejects a claim that omits a deleted guard"`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Read the raw lines of both spans from the patches. Every line of both spans must be accounted for exactly once as an identical pair, a whitespace-equivalent pair that `lexicallySafe` confirms, or a listed divergence. Do not call the matcher's alignment code; use a different approach (multiset of raw lines per side) so the two cannot share a bug.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(diff-model): independent relocation checker`.

### Task 5: Other operations, facts and `buildDiffModel`

**Files:**
- Create: `src/diff-model/operations.ts`, `src/diff-model/facts.ts`, `src/diff-model/index.ts`
- Test: `src/diff-model/operations.test.ts`, `src/diff-model/facts.test.ts`, `src/diff-model/index.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces: `findRenames(files: PushFile[]): Operation[]`, `findMechanical(files: PushFile[]): Operation[]`, `buildPrFacts(input: { prFiles: PushFile[]; prFilesComplete: boolean; title: string; body: string | null }): PrFacts`, and `buildDiffModel(input: { scopeFiles: PushFile[]; prFiles: PushFile[]; prFilesComplete: boolean; title: string; body: string | null }): DiffModel`. Relocation claims that fail `verifyRelocation` are dropped; the count of drops is returned on the model as `droppedClaims: number`.

- [ ] **Step 1: Write the failing tests:** `"findRenames reports a status:renamed file with its previous name"`, `"findRenames pairs a deleted and added file at similarity 0.6 or above"`, `"findMechanical reports a whitespace-only hunk only in a lexically safe file"`, `"findMechanical does not report a whitespace change inside a template literal"`, `"findMechanical reports an import-only hunk for TypeScript and Python"`, `"testsChanged is unknown when prFilesComplete is false"`, `"testsChanged is true when a test path changed"`, `"intent claims capture 'no functional change' with the PR text span"`, `"buildDiffModel drops a relocation the checker rejects and counts it"`, `"buildDiffModel never throws on a file with no patch"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the four functions. Intent claims are a fixed phrase list: "no functional change", "refactor only", "formatting only", "whitespace only", "rename". Relocation and the other operations use `scopeFiles`; facts use `prFiles`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(diff-model): renames, mechanical changes, facts and buildDiffModel`.

### Task 6: Renderer

**Files:**
- Create: `src/diff-model/render.ts`
- Test: `src/diff-model/render.test.ts`

**Interfaces:**
- Consumes: `DiffModel`, `fenceUntrusted` from `src/prompt.ts`.
- Produces: `interface RenderedDiffModel { summary: string; fileNotes: ReadonlyMap<string, string> }` and `renderDiffModel(model: DiffModel, opts: { maxChars: number; scopeLabel: string }): RenderedDiffModel`. An empty summary and empty map when there is nothing worth saying.

- [ ] **Step 1: Write the failing tests:** `"renders the spec example for a move with one changed line"` (assert base-line wording, the changed line, the intent conflict sentence, no word 'functional' asserted by the renderer), `"ranks code divergences before relocations, renames and mechanical changes"`, `"details at most 12 operations and counts the rest"`, `"stays under maxChars by dropping the lowest-ranked detail first"`, `"says deleted lines are not shown for a span with shown none"`, `"fences original code and clips each value to 200 characters"`, `"neutralizes a closing fence tag in a comment or file name"`, `"says test coupling is unknown when testsChanged is unknown"`, `"returns nothing for a PR with no operations and no claims"`, `"opens with the fixed paragraph saying the diff wins"`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** to the spec's Rendering section. The fixed paragraph carries the guidance that the reviewer cannot read other files in this version and must say what it could not check.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(diff-model): renderer`.

### Task 7: Prepared input, prompt wiring and switch

**Files:**
- Create: `src/diff-model/prepare.ts`
- Modify: `src/diff-pack.ts` (`formatPackedDiff` gains an optional notes map), `src/prompt.ts` (`PromptContext.diffModel?: RenderedDiffModel`, `AuditContext.diffModelSection?: string`), `src/reviewer-tuning.ts` (`diffModel: boolean`, default `false`), `src/config/schema.ts` and `src/config.ts` (`review.diffModelBudgetChars`, mirroring `review.diffBudgetChars`, default 6000), regenerated `docs/configuration.md`
- Test: `src/diff-model/prepare.test.ts`, `src/diff-pack.test.ts`, `src/prompt.test.ts`

**Interfaces:**
- Consumes: Tasks 5 and 6; `packDiff`, `PackedDiff` from `src/diff-pack.ts`.
- Produces: `prepareDiffInput(input: { scopeFiles: PushFile[]; prFiles: PushFile[]; prFilesComplete: boolean; title: string; body: string | null; budgetChars: number; sectionBudgetChars: number; scopeLabel: string }): { packed: PackedDiff; model: DiffModel; rendered: RenderedDiffModel }`, and `formatPackedDiff(diff: PackedDiff, notes?: ReadonlyMap<string, string>): string`.

- [ ] **Step 1: Write the failing tests:** `"formatPackedDiff output is byte-identical when notes are absent"`, `"formatPackedDiff places a file's note before its diff block and leaves every diff line unchanged"`, `"prepareDiffInput sets span visibility from the packed result"` (a dropped deletion-only hunk gives `shown: "none"` on that deleted span), `"packed diff text is identical with the model on and off"`, `"buildUserMessage puts the summary in the first block and inserts notes per file"`, `"buildAuditUserMessage appends diffModelSection after repo context and serializes files as before"`, `"config key review.diffModelBudgetChars defaults to 6000"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `prepareDiffInput` builds the model from full patches, packs with `budgetChars`, then maps packed hunks back to span `shown` values, then renders. `serializeFiles` receives the notes map. Run `pnpm docs:config` for the docs.
- [ ] **Step 4: Run `pnpm test`.** Expected: PASS, including every existing prompt and diff-pack test.
- [ ] **Step 5: Commit** `feat(diff-model): prepared input, prompt wiring and switch`.

### Task 8: Call-site wiring and logging

**Files:**
- Modify: `src/review.ts` (the two-scope message build near line 2572), `src/audit.ts` (the audit builder call near line 148)
- Test: `src/review.test.ts`, `src/audit.test.ts`

**Interfaces:**
- Consumes: `prepareDiffInput`, `REVIEWER_TUNING.diffModel`, `wholePrInputComplete` from `src/prompt.ts` for `prFilesComplete`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests:** `"dispatch builds one model per input scope and labels each section"` (a whole-PR group and a delta group get different section text), `"a delta round does not say no tests changed when the PR list is incomplete"`, `"with the switch off the user message is byte-identical to today's and a diff-model log line is still written"`, `"a throw inside the model build omits the section and the review continues"`, `"audit passes a content section only with file mix and intent claims"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `dispatch`, call `prepareDiffInput` once per scope group already used for `userMessages`. Log one `diff model built` line per scope with counts per operation type, dropped claims and whether the section was used. Wrap in try/catch that logs and falls back to no section.
- [ ] **Step 4: Run `pnpm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(diff-model): wire dispatch and audit, log counts`.

### Task 9: Seed operation truth and detection scoring

**Files:**
- Modify: `src/replay/seeds/schema.ts` (optional `operations` in truth), `src/replay/seeds/input.ts` (read `pr.json` when present), the 25 `truth.json` files under `src/replay/seeds/*/*/`
- Create: `src/replay/seeds/detect.ts`, `pr.json` for the REL-10 variants
- Test: `src/replay/seeds/detect.test.ts`, existing seed tests

**Interfaces:**
- Consumes: `buildDiffModel`, `SeedTruth`.
- Produces: `scoreDetection(truthOps: SeedOperation[], model: DiffModel): { matched: number; missing: SeedOperation[]; unexpected: Operation[]; divergenceMisses: number }`.

- [ ] **Step 1: Write the failing tests:** `"matches an expected relocation by spans and divergences"`, `"reports an unexpected operation"`, `"reports a missing divergence"`, `"SeedTruth accepts operations and still rejects unknown keys"`, and a loop test `"every committed seed's detection matches its truth operations"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the schema change and `scoreDetection`; add `operations` to all 25 truth files by reading each seed's base and head (REL-01 and REL-10: relocation, with one divergence in REL-10 originals; REL-03: rename; MEC-01: mechanical; DEL-04: none; the REL-10 clean control: an unchanged relocation of `page_bounds` with no divergence). Add `pr.json` `{ "title", "body" }` to the REL-10 variants, with "no functional change" in the body. `seedReviewInput` reads it.
- [ ] **Step 4: Run `pnpm vitest run src/replay/seeds` and `bun src/cli.ts replay --seeds --check`.** Expected: PASS, and no clean control reports a reviewer finding or an unexpected operation.
- [ ] **Step 5: Commit** `feat(replay): seed operation truth and detection scoring`.

### Task 10: Replay strategy variant

**Files:**
- Create: `src/replay/strategies/a-dm.ts`
- Modify: `src/replay/strategies/index.ts` (register `a-dm`), `src/audit.ts` (`runAuditPass` accepts `diffModelSection?: string` and forwards it)
- Test: `src/replay/strategies/a-dm.test.ts`

**Interfaces:**
- Consumes: `StrategyInput.files: PullFile[]`, `prepareDiffInput`, `strategyA` as the base.
- Produces: `strategyAdm: ReviewStrategy` named `a-dm`, identical to `a` except the audit message carries the rendered section built from `input.files`.

- [ ] **Step 1: Write the failing tests:** `"a-dm passes the section built from the fixture files to the audit builder"`, `"a-dm output equals a's message when the model renders nothing"`, `"a-dm is registered once"`, and `"buildDiffModel runs over every recorded fixture without throwing and reports relocation counts and dropped claims"` (the spec's real-code false-positive check; the test prints the counts and fails only on a throw). Follow the mocking pattern in `a0.test.ts`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** `a-dm.ts` by composing `strategyA`'s run with the extra option; do not edit the locked plan files, and do not add `a-dm` to any plan. `versions.test.ts` must still pass.
- [ ] **Step 4: Run `pnpm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): a-dm strategy for the diff model comparison`.

### Task 11: Docs and gates

**Files:**
- Modify: `CLAUDE.md` (Key files table row for `src/diff-model/`, one line in the architecture overview, the `REVIEWER_TUNING.diffModel` switch and `review.diffModelBudgetChars`), `docs/configuration.md` (regenerated)

- [ ] **Step 1: Update `CLAUDE.md`** with the new module, the two preparation contracts and the switch.
- [ ] **Step 2: Run `pnpm docs:config && pnpm config:check && pnpm typecheck && pnpm lint && pnpm test`.** Expected: all pass.
- [ ] **Step 3: Commit** `docs(diff-model): CLAUDE.md and generated configuration docs`.
- [ ] **Step 4: Run `bd update ai-review-bot-yu6 --notes "Implemented on branch diff-model-spec; a-dm replay comparison not yet run."`**
