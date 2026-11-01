# Review Precision Phase B (core) Implementation Plan


**Goal:** Remove the deterministic false-positive sources in the merge, anchor and suppression layers: folded findings, re-anchored comments, un-numbered diffs, reworded repeats, restated open entries, and retraction filler.

**Spec:** [docs/superpowers/specs/2026-10-31-verified-context-aware-reviews-design.md](../specs/2026-10-31-verified-context-aware-reviews-design.md) (Phase B; beads `ai-review-bot-t0c.6` to `.11`)

**Execution order:** B5 → B3 → B4 → B1 → B2 → B6 (B5 independent; B3 before B4; B1 before B2 and B6). Branch `feat/review-precision-phase-b` in `.worktrees/review-precision-phase-b`. Check `pwd && git branch --show-current` before every git write.

## Findings from reading the code (these change the stories)

- **B5 reverses a recorded decision.** `src/replay/retraction-rule.ts` was pulled out of the merge in 0e2f1ae because PR #92 reviewers kept finding false-drop shapes (labels in `src/replay/fixtures/*92__openai.labels.json`). The spec still approves wiring it. Ship it behind a `REVIEWER_TUNING` switch, log every drop with title, and expect the PR's own reviews to probe it again.
- **B2 touches more than `mergeReviewsDetailed`.** Three things key on `path:line` and would collide once two comments share a line: `commentProvenance` (review.ts ~2456-2477), `inlineAliases` (review.ts ~646-651), and `dropped` via `postedKeys` (review.ts ~2582). GitHub comments are paired back to provenance by `path:line` in `src/improve/capture.ts:57` and `src/feedback/persist.ts:45`. One `commentKey` helper (path, line, normalized title) replaces all five.
- **B4 would create unsettleable blockers if done literally.** `baseline.ts` re-reads the `> - 🟡 **title** (\`path:line\`)` bullets of the "could not be anchored" notice as carried findings with a path, and `blocksVerdict` makes any pathed finding block at every severity. A dropped P3 has no thread, so it would block until triage resolves it. Fix: P0/P1 off-diff become general findings (they block by severity and carry through the findings table); P2/P3 off-diff are listed in one plain sentence that the baseline parsers do not match.
- **B6's durable link is mostly there already.** Open entries ride in the body's carried table, which `deriveBaseline` re-reads. The marker is still required by the epic (and by the Codex note on `.11`), so write the multi-round tests first and add `ai-review:carry` as the explicit link; the tests decide what they prove.
- **B1 cannot be measured on replay.** Fixtures predate the marker and hold no anchor code, so B1 is covered by unit tests only. Say so in the PR.
- `collectRightSideLines` lives in `src/review.ts`, which imports `src/prompt.ts`. B3 needs the walk in `prompt.ts`, so it moves to a new `src/diff-lines.ts`.

## Decisions made (override in review if wrong)

1. Legacy merged threads (several claims in one comment, posted before B2) are **left open by design**. They are fail-safe today and finite. A test pins the behavior. This closes PR #100 gaps 1 and 2 for new threads; no durable per-claim settled state is built.
2. The retraction filter runs per agent result, right after `suppressInReview`, same event-downgrade rule (REQUEST_CHANGES becomes COMMENT only if it removed every finding).
3. Fingerprint matching is a candidate generator with a relaxed claim bar, never sufficient alone.

## Global constraints

- TypeScript ESM, `.js` import extensions, named exports only, tests colocated, Vitest, Biome.
- `pnpm typecheck && pnpm lint && pnpm test` green before every commit.
- **Every new test is shown failing on the old code first** and the red output quoted in the commit body. Phase A had a vacuous-test finding; for each test, name the assertion that fails.
- `src/auth.ts` never imported from webhook paths. No banner comments; no inline comments unless unavoidable; docstrings on exported APIs.
- Conventional commits.

## Review focus

- Two distinct claims at one line produce two comments, each with its own provenance, posted key and drop accounting.
- An off-diff P2/P3 never becomes a carried finding; an off-diff P0/P1 does.
- A repeat-only round holds `REQUEST_CHANGES` when the matched open entry blocks, across a restart.
- Identical anchor code or identical suggestion code with a different defect never matches.
- A real finding whose last sentence quotes retraction-like program output survives the filter.

## File structure

| File | Change |
| --- | --- |
| `src/retraction.ts` (+test) | Moved from `src/replay/retraction-rule.ts`; `dropRetractions(review)` |
| `src/replay/{classify,live,filter-margin}.ts` | Import from `../retraction.js`; fix the "measurement only" line |
| `src/reviewer-tuning.ts` | `dropRetractions` switch |
| `src/diff-lines.ts` (+test) | `collectRightSideLines` moved here; `numberPatchLines`; `rightSideText` |
| `src/prompt.ts` | `serializeFiles` numbers lines; replace the "count from @@" rule |
| `src/review.ts` | Remove `nearestValidLine`; off-diff routing; `commentKey`; merge without folding; fingerprints in `buildCommentBody`; open-restatement suppression and carry ids |
| `src/ledger/fingerprint.ts` (+test) | Anchor-code hash, occurrence suffix, suggestion hash, marker read/write |
| `src/ledger/{types,github,match,suppress}.ts` | `fp`/`sfp` on entries and claims; rule 0; `suppressOpenRestatements` |
| `src/claim-dedupe.ts` | `ClaimLike` gains optional `fp`, `sfp` |
| `src/baseline.ts`, `src/review-metadata.ts` | Read `ai-review:carry` |
| `src/improve/capture.ts`, `src/feedback/persist.ts` | Pair by `commentKey` |
| `src/resolve-threads.test.ts` | Pin legacy merged-thread behavior |
| `CLAUDE.md` | Merge-layer, anchor-validation, key-files rows, test count |

---

### Task 1: Retraction filter in the posting path (B5, `.10`)

**Interfaces:** Produces `dropRetractions<R extends { event: string; general_findings: DroppableFinding[]; inline_comments: DroppableFinding[] }>(review: R): { review: R; dropped: DroppableFinding[] }`. Consumes `candidateFamilies`.

- [ ] Move `retraction-rule.ts` and its test to `src/retraction.ts`; update the three replay importers; delete the old file. Run `pnpm test` (stays green: pure move).
- [ ] RED: `src/retraction.test.ts` cases for `dropRetractions`: drops a P3 whose last unit is "No issues found."; keeps a P1 with the same text; keeps a `suppressible: false` P2; keeps a finding whose closing sentence quotes program output (the PR #92 shape); downgrades REQUEST_CHANGES only when it removed every finding. Add a `review.test.ts` case that the posting path drops it and logs title and family.
- [ ] Add `dropRetractions: true` to `REVIEWER_TUNING` for both providers; call it after `suppressInReview` in the agent map (review.ts ~2328), logging each drop.
- [ ] Change `formatMargin`'s "measurement only, not applied in production" line and the doc comment on `isRetractionCandidate`.
- [ ] Verify: `ai-review replay` filter-margin still reports 5 of 15 filler removed, 0 fixed claims hit. Commit `feat(review): drop strict retraction filler in the posting path`.

### Task 2: Numbered diff lines (B3, `.8`)

**Interfaces:** Produces in `src/diff-lines.ts`: `collectRightSideLines(patch): Set<number>` (moved), `rightSideText(patch): Map<number, string>`, `numberPatchLines(patch): string`. Format per line: right-side number right-aligned in 5 columns, ` | `, then the original line; deletions and `\` lines get blank margin; `@@` headers unchanged.

- [ ] Move the walk; update importers (`review.ts`, `review.test.ts`) and refactor `collectRightSideLines` onto one shared walk.
- [ ] RED: `diff-lines.test.ts` for numbering across two hunks, deletions, `\ No newline`, and a patch ending in `[patch truncated]` (marker unnumbered). `prompt.test.ts`: `buildUserMessage` output contains numbered lines and no longer says to count from `@@`.
- [ ] Number after `trimPatch`, so the 24k budget is unchanged and a truncated prefix keeps correct numbers. Replace the rule at prompt.ts ~299.
- [ ] Measure: run `ai-review replay --live --max-cost 2` before and after. Check the live output surfaces the `anchor adjusted (fuzzy)` count; if it does not, count those log lines in the run. AC: at least 80% fewer adjustments, prompt tokens up at most 15%. Record numbers in the PR body. Commit `feat(prompt): number right-side diff lines`.

### Task 3: Drop instead of re-anchoring (B4, `.9`)

- [ ] RED in `review.test.ts`: a comment 2 lines off the diff is dropped (today it is moved); an off-diff P2 appears in the body only as plain text and `deriveBaseline` does not return it; an off-diff P0 becomes a general finding and blocks.
- [ ] Delete `nearestValidLine` and the ±5 branch; `sanitizeInlineComments` keeps the `start_line` clears. `buildReviewComments` logs a reason code per drop (`OFF_DIFF_PATH`, `OFF_DIFF_LINE`, `BAD_RANGE`) for C1 to persist later.
- [ ] After `buildReviewComments`, route dropped P0/P1 into `modelReview.general_findings` with the `(\`path:line\`)` title suffix `withRecoveredPath` already understands; render P2/P3 drops as one `> ℹ️` sentence, not `> - emoji` bullets.
- [ ] Commit `fix(review): drop off-diff comments instead of moving them`.

### Task 4: Anchor-code fingerprint (B1, `.6`)

**Interfaces:** Produces in `src/ledger/fingerprint.ts`: `anchorFingerprint(input: { category: string; path: string; line: number; patch: string }): string | null` returning `category|path|hash.n` (hash of the whitespace-stripped ~100-char window starting at the anchor line over right-side text; `n` = index among identical windows in that patch), `suggestionFingerprint(code: string): string`, `formatFpMarkers`, `readFpMarkers(text)`. `ClaimLike` and `LedgerEntry` gain optional `fp`, `sfp`.

- [ ] RED unit tests: stable under reformatting and line shift; differs for different code; occurrence suffix separates two identical lines; `null` off-diff.
- [ ] Write markers in `buildCommentBody` (HTML comment lines; `claimTitle` ignores them): pass the file patch from `buildReviewComments`.
- [ ] Read them in `buildLedger` from `c.text` (review.ts is untouched there: `body: c.text` at ledger/github.ts:61).
- [ ] Compute `fp`/`sfp` on each agent inline comment before `suppressInReview`, from the full PR `files` (not the delta patch).
- [ ] Rule 0 in `findMatch`: `fp` or `sfp` equal AND `isSameClaim` at a relaxed bar (`CROSS_ROUND_MATCH` with title and identifier similarity 0.5, named constant, provisional). P0 keeps `P0_RULES` without rule 0.
- [ ] RED negatives: same anchor, two different defects (no match); two findings with identical suggestion code and different claims (no match); reworded same claim with the same `fp` (match); existing `match.test.ts` unchanged and green.
- [ ] Commit `feat(ledger): fingerprint anchor code as a match candidate`.

### Task 5: Stop folding distinct findings (B2, `.7`)

**Interfaces:** `export function commentKey(c: { path: string; line: number; title: string }): string`.

- [ ] RED: `mergeReviewsDetailed` with two distinct claims at one `path:line` returns two inline comments (today one with `---` body); restatements still collapse; `isSameClaim` unchanged.
- [ ] RED: provenance has two entries; `pairWithProvenance` and `persistPostedComments` pick the right entry when two GitHub comments share a line (key from `claimTitle(body)`); `dropped` keeps a dropped comment when a sibling at the same line posted.
- [ ] Remove the append-with-separator branch (review.ts 615-634); order by severity. Replace the five `path:line` keys with `commentKey`; `inlineAliases` uses `commentKey` of `from` and `into`.
- [ ] Pin legacy: `resolve-threads.test.ts` case `leaves a legacy merged thread open when its claims resolve in different rounds`.
- [ ] Update CLAUDE.md's merge-layer bullet. Commit `fix(review): post distinct findings at one line separately`. Close PR #100 notes on `.7`.

### Task 6: Suppress restatements of open entries (B6, `.11`)

**Interfaces:** `suppressOpenRestatements<T extends ClaimLike>(findings, ledger): { kept: T[]; suppressed: Suppressed<T>[] }`; `suppressInReview` returns `restatedOpen: Suppressed<ClaimLike>[]` and keeps the event when a suppressed open entry blocks (pathed, or P0/P1). New body marker `<!-- ai-review:carry=<id>,<id> -->` (max 50), read by `deriveBaseline`.

- [ ] RED in `suppress.test.ts`: an open restatement is dropped; event stays REQUEST_CHANGES when the matched entry blocks and the only finding was suppressed; a settled match still downgrades as before.
- [ ] RED in `review.test.ts` and `baseline.test.ts`: repeat-only round posts nothing new yet holds REQUEST_CHANGES; a restart (fresh derive from the posted body) still holds it; a later resolution releases it; a later clean round approves.
- [ ] Implement; write the marker from `suppressedOpenEntryIds ∪ survivingPrior ids`; read it in `deriveBaseline` into `fromLedger` (deduped by `findingId`). Add the held count to `ledgerNote`.
- [ ] Verify with `ai-review replay`: `restated-open` about 0, no change in other metrics. Commit `feat(ledger): suppress restatements of open entries without losing the verdict`.

### Task 7: Docs

- [ ] CLAUDE.md: anchor validation (no ±5 move), key-files rows for `retraction.ts`, `diff-lines.ts`, `ledger/fingerprint.ts`, test count. Commit `docs: describe the Phase B merge and anchor behavior`.

## Finish

- [ ] `pnpm typecheck && pnpm lint && pnpm test`; re-read the diff as a hostile reviewer.
- [ ] `ai-review gate --base origin/main` before the first push; fix every real finding; second pass on the fix batch.
- [ ] `/no-mistakes` (after the PR exists, `--skip ci`). `daemon shutting down` → `no-mistakes daemon start`, retry; diverged history → back up the head, then `git checkout -B <branch> origin/<branch>`.
- [ ] `/pr-loop` to merge. Run `ai-review watch --pr <n> --provider openai` for a confirmation pass; kill it before each fix push. Stale CHANGES_REQUESTED re-listing removed code: record the decision in a PR comment and merge.
- [ ] Close beads `.6` to `.11`; `wt-reap` the worktree.
- [ ] Owed from Phase A once deployed: throwaway PR, human `**nit:**` thread stays open, fixed single-finding bot thread closes.

## Second plan (after this merges)

B7 `.29`, B10 `.31`, B11 `.32`, B12 `.33`, B13 `.34`. B9 `.30` waits for C1 and is left out. B10 replaces `trimPatch` and reuses `numberPatchLines`; B13 builds on Task 6's open-entry handling.

## Self-review

- **Coverage:** B1 Task 4, B2 Task 5 (including both PR #100 gaps), B3 Task 2, B4 Task 3, B5 Task 1, B6 Task 6.
- **Deviations from the spec:** B4 splits P0/P1 from P2/P3 off-diff handling to avoid unsettleable blockers; B1 is unit-tested only; B6 writes the marker even though the carried table already holds most of the link; B5 ships behind a switch.
- **Known out-of-scope:** `resolvedKeys` still suppresses by `inline:path:line` location, so a resolved finding at a line can hide a new distinct one there. Worth a bead after B2.
