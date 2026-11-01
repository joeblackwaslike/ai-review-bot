# Review Precision Phase B (second plan) Implementation Plan

> Execute with superpowers:subagent-driven-development. Branch `feat/review-precision-phase-b2` in `.worktrees/review-precision-phase-b2`. Check `pwd && git branch --show-current` before every git write.

**Goal:** Finish Phase B: stop non-defect findings from blocking (B11), repair suggestion blocks (B12), keep acknowledged-but-unfixed findings open without re-argument (B13), let finders declare relations to prior ledger entries (B7), and replace `trimPatch` with PR-wide diff packing (B10).

**Spec:** [docs/superpowers/specs/2026-10-31-verified-context-aware-reviews-design.md](../specs/2026-10-31-verified-context-aware-reviews-design.md) (Phase B; beads `ai-review-bot-t0c.29`, `.31` to `.34`). B9 (`.30`) waits for C1 and is out of scope.

**Execution order:** B11 → B12 → B13 → B7 → B10. B7 depends on B1 and B13 on B6 (both merged in PR #102). B10 is last because it is the largest and reuses `numberPatchLines`.

## Findings from reading the code

- Agent results are plain `ModelReview[]` with no skill identity by the time `mergeReviewsDetailed` runs (`src/review.ts` ~2337-2356 pushes `o.review`). B11 therefore caps at the agent layer, where `skillPath` is known, and tags the finding.
- `ModelReviewSchema` findings have no relation field. The prompt lists prior findings as `- [status] note severity — path:line — title` with no id (`src/prompt.ts:186`), so B7 must add ids to that list before an enum of ids can exist.
- `classifyReplies` (`src/ledger/disposition.ts`) tries DEFERRED, REJECTED, then FIX_REF in that order, and returns null for an agreeing reply with no commit. `LedgerStatus` has no acknowledged value; `isSettled` is `status !== "open"`, so a new status would count as settled everywhere unless handled.
- `buildCommentBody` posts `comment.suggestion` verbatim (`src/review.ts:1248`).
- `trimPatch(patch, 24000)` is applied per file in `serializeFiles` (`src/prompt.ts:151`); there is no PR-wide budget and no list of omitted files. `wholePrInputComplete` documents that a cut patch still counts as complete input; B10 must keep that true or update it.

## Decisions (override in review if wrong)

1. **B11 cap point.** Findings from `code-review-and-quality.md` and `architect-review.md` are capped at P2 and the agent's event forced to COMMENT in `dispatch`, tagged `advisory: true` (not in the zod schema; set after parsing). Body renders them in a separate "Quality and architecture notes" section. Advisory findings never feed `blocksVerdict` as new blockers.
2. **B13 status.** Add `acknowledged` to `LedgerStatus`. `isSettled` stays "not open" for suppression of re-posts, but `blocksVerdict` and the carried table treat `acknowledged` like `open`. A later reply citing a fix commit moves it to `fixed` via the existing FIX_REF rule.
3. **B7 `repeats`** feeds the existing suppression path as a declared match (still requires the id to exist in the shown ledger; unknown id is ignored). **`caused_by`** posts normally with a link line to the earlier thread's comment URL when the entry has one; no suppression.
4. **B10 ordering.** Main language by changed-line count of the extension with most additions; within it, larger patches first; deletion-only hunks dropped; omitted files named in the prompt. Budget default 200,000 characters PR-wide, configurable via `REVIEW_DIFF_BUDGET_CHARS`.

## Global constraints

- TypeScript ESM, `.js` import extensions, named exports only, tests colocated, Vitest, Biome.
- `pnpm typecheck && pnpm lint && pnpm test` green before every commit.
- Every new test is shown failing on the old code first; quote the failing assertion in the commit body.
- `src/auth.ts` is never imported from webhook paths. No banner comments; no inline comments unless unavoidable; docstrings on exported APIs.
- Conventional commits.

## Review focus

- A lone architecture or quality finding at any severity cannot yield REQUEST_CHANGES; a P0 from `code-reviewer.md` still does.
- Suggestion repair never changes a suggestion that already matches the file, and never invents lines.
- An acknowledged entry keeps the PR at REQUEST_CHANGES across a restart and is not re-posted.
- A model-declared id outside the shown set is ignored, not trusted.
- No file silently vanishes from the prompt: every omitted file is named.

---

### Task 1: Advisory findings are non-blocking (B11, `.32`)

**Interfaces:** Produces `ADVISORY_SKILLS: ReadonlySet<string>` and `capAdvisory(review: ModelReview): ModelReview` in `src/review.ts` (or a new `src/advisory.ts`); findings gain optional `advisory?: true` on `ModelFinding`/`ModelInlineComment` types (TypeScript only, not the zod schema).

- [ ] RED: `capAdvisory` lowers P0/P1 to P2, sets `advisory`, forces event COMMENT. A review test: only an `architect-review.md` agent returns a P1 REQUEST_CHANGES → final event COMMENT. A `code-reviewer.md` P1 still gives REQUEST_CHANGES.
- [ ] Apply in `dispatch` for skills in `ADVISORY_SKILLS`.
- [ ] Render advisory findings in a separate body section; keep them out of inline comments' blocking set and out of `blocksVerdict` for new findings (inline comments still post, labelled).
- [ ] Commit `feat(review): make quality and architecture findings non-blocking`.

### Task 2: Suggestion block cleanup (B12, `.33`)

**Interfaces:** `repairSuggestion(input: { suggestion: string; line: number; startLine: number | null; fileLines: Map<number, string> }): { suggestion: string; line: number; startLine: number | null } | null` in new `src/suggestion.ts`; `null` means drop the suggestion block, keep the comment.

- [ ] RED unit tests: strips a leading/trailing code fence; strips `  42 | ` style line-number prefixes; re-indents to the original line's indentation; widens or narrows the range when the suggestion's first/last lines match file lines elsewhere in a ±3 window; returns null when no alignment is found.
- [ ] Use `rightSideText(patch)` from `src/diff-lines.ts` for the file lines; call from `buildReviewComments` before `buildCommentBody`; recompute fingerprints after repair.
- [ ] Commit `feat(review): repair suggestion blocks before posting`.

### Task 3: Acknowledged disposition (B13, `.34`)

**Interfaces:** `LedgerStatus` adds `"acknowledged"`; `classifyReplies` returns it when a decider reply matches `ACKNOWLEDGED` and none matches DEFERRED/REJECTED/FIX_REF.

- [ ] RED in `disposition.test.ts`: "good catch, will fix" → acknowledged; "good catch, fixed in abc1234" → fixed; "will address later" → deferred (unchanged).
- [ ] RED in `suppress.test.ts` and `baseline.test.ts`: an acknowledged entry suppresses a restatement, holds REQUEST_CHANGES, appears in the carried table; a later fix reply releases it. Audit every `isSettled`/`status === "open"` use (`rg -n "isSettled|status === \"open\"" src`) and fix each so acknowledged counts as blocking-open where the verdict is concerned and as settled where re-posting is concerned.
- [ ] Add the status to the prompt's status legend in `src/prompt.ts` (`acknowledged`: the author agreed; it is still open, do not argue it).
- [ ] Commit `feat(ledger): track acknowledged findings`.

### Task 4: Finder-declared relation to prior entries (B7, `.29`)

**Interfaces:** `relation?: { kind: "repeats" | "caused_by"; entry_id: string }` on `findingBase`, with the id constrained at runtime by `parseRelation(raw, shownIds)`; prior-findings prompt lines gain a stable short id (`[#abc123]`).

- [ ] RED: schema accepts a relation; `parseRelation` drops an unknown id; prompt lists ids; a `repeats` finding is suppressed through the existing open-restatement path and still holds the verdict; a `caused_by` finding posts with a link line.
- [ ] Reuse `findingId` from `src/review-state.ts` for ids. Keep the schema field optional so models that omit it still validate.
- [ ] Replay: `ai-review replay` shows declared repeats suppressed on fixtures where the ledger ids exist; record numbers in the PR body.
- [ ] Commit `feat(review): let finders declare repeats and causes of prior findings`.

### Task 5: PR-wide diff packing (B10, `.31`)

**Interfaces:** `packDiff(files: PromptFile[], opts: { budgetChars: number }): { files: PackedFile[]; omitted: string[] }` in new `src/diff-pack.ts`; `serializeFiles` uses it and prints an "Omitted files" line; `trimPatch` removed.

- [ ] RED unit tests: ordering (main language, then size), budget never exceeded, deletion-only hunks dropped, omitted list exact, a truncated file keeps correct right-side line numbers.
- [ ] Asymmetric hunk context: extend each hunk 5 lines before and 1 line after toward the enclosing function only when the full file text is available; otherwise keep the patch hunks as given.
- [ ] Update `wholePrInputComplete` and its docstring: a packed or omitted file is no longer complete input; add a test.
- [ ] Verify: `ai-review replay --live --max-cost 2` stays within the budget and reports no silent truncation. Commit `feat(prompt): pack the diff PR-wide instead of trimming per file`.

### Task 6: Docs

- [ ] CLAUDE.md: key-files rows for `diff-pack.ts`, `suggestion.ts`; advisory-findings note in the merge-layer section; acknowledged status; test count. Commit `docs: describe the second Phase B plan`.

## Finish

- [ ] `pnpm typecheck && pnpm lint && pnpm test`; hostile re-read of the diff.
- [ ] `ai-review gate --base origin/main`, fix every real finding, second pass on the fix batch, then `/no-mistakes` and `/pr-loop` as for PR #102. Close beads `.29`, `.31` to `.34`; `wt-reap` the worktree.

## Self-review

- **Coverage:** B7 Task 4, B10 Task 5, B11 Task 1, B12 Task 2, B13 Task 3.
- **Risk:** B10 is the only change that alters every review's prompt; ship it last and compare replay token counts before/after.
- **Open assumption:** the 200,000-character budget is a guess to be tuned on replay.
