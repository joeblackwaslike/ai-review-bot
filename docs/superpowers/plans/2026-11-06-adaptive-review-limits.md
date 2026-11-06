# Adaptive review limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before each review the bot tightens its severity floor and findings budget from how earlier rounds went, with no input from the developer.

**Architecture:** Three pure modules (`trajectory.ts`, `push-shape.ts` with `moved-blocks.ts`, `adaptive-limits.ts`) turn ledger history and the last push into limits. One call at the existing cap site in `src/review.ts` applies them behind a `REVIEWER_TUNING` switch, and the replay trace calls the same functions so the effect can be measured.

**Tech Stack:** TypeScript ESM, Vitest, Biome, Drizzle (one enum migration).

**Spec:** [docs/superpowers/specs/2026-11-06-adaptive-review-limits-design.md](../specs/2026-11-06-adaptive-review-limits-design.md). Bead `ai-review-bot-t0c.30`.

## Global Constraints

- Branch `feat/adaptive-review-limits` in `.worktrees/adaptive-review-limits`. Run `pwd && git branch --show-current` before every git write.
- `pnpm typecheck && pnpm lint && pnpm test` pass before every commit. Conventional commits.
- TypeScript ESM, `.js` import extensions, named exports only, tests colocated (`src/*.test.ts`), no banner comments, docstrings on exported APIs, no inline comments unless unavoidable.
- Every new test is shown failing first. Quote the red output in the commit body and name the assertion that failed.
- New modules are pure (no I/O) and do not import `src/review.ts`, so `review.ts` and the replay trace can import them without a cycle. They define their own `Sev = "P0" | "P1" | "P2" | "P3"` and rank map (P0 4, P1 3, P2 2, P3 1).
- `src/auth.ts` is never imported from webhook paths.
- P0 and P1 are never removed by either limit.
- Bands (provisional constants in `src/reviewer-tuning.ts`): score below 0.35 gives no floor and no budget; 0.35 up to 0.6 gives no floor and budget 10; 0.6 and above gives floor P2 and budget 5. The 50-comment payload cap stays as the outer limit.
- Round weight is `0.5^a`, with `a = 0` for the most recent earlier round. Deferred counts as half a rejection. Friction is `(rejected + 0.5 * deferred) / (accepted + rejected + deferred)`.
- Push-shape budget: `clamp(ceil(reviewableWeight / 8), 2, budgetFromBand)`. It applies only when the band gives a budget and the review is incremental. Kind weights: code and shell 1, test 0.7, config and infra 0.5, docs 0.3, generated, lockfile and binary 0. A moved block is at least 5 consecutive normalized lines.
- Rollout switch `REVIEWER_TUNING.adaptiveLimits` defaults to `false`.
- Removed findings are `Discard` records with reason `ADAPTIVE_LIMIT`, disposition `dropped`. They never reach the carry marker or the ledger and never hold the verdict.
- The body notice is one plain sentence with no `> - ` bullet and no marker the baseline parsers read.

## Review Focus

- All earlier findings unanswered or bot-settled: no friction value, no limits (Task 1).
- One bad round followed by good ones: the old round decays instead of dominating (Task 1).
- A function moved with different indentation still counts as moved; a move inside one file does not (Task 2).
- A push of only renames, lockfiles or binaries (no patch text) gives weight 0 and a budget of 2, never 0 or a crash (Task 3).
- Every new finding removed while a carried P2 entry still blocks: the event stays `REQUEST_CHANGES` (Task 4).
- A limited review's notice sentence is not read back as a finding by `deriveBaseline` (Task 6).

---

### Task 1: Trajectory scorer and tuning constants

**Files:**
- Create: `src/trajectory.ts`, `src/trajectory.test.ts`
- Modify: `src/reviewer-tuning.ts` (add `adaptiveLimits: boolean` to `ReviewerTuning`, default `false`, and export `ADAPTIVE_LIMIT_BANDS`)

**Interfaces:**
- Produces:
  - `type Sev = "P0" | "P1" | "P2" | "P3"` and `SEV_RANK: Record<Sev, number>` (P0 4, P1 3, P2 2, P3 1), exported for the later tasks
  - `type FindingOutcome = "accepted" | "rejected" | "deferred" | "unanswered"`
  - `classifyFinding(entry: LedgerEntry, reactions: Verdict[]): FindingOutcome`
  - `interface RoundFriction { round: number; age: number; friction: number; answered: number }`
  - `scoreTrajectory(entries: Ledger, reactionsFor: (e: LedgerEntry) => Verdict[], currentRound: number): { score: number | null; rounds: RoundFriction[] }` where `currentRound` is the number of earlier own reviews.
  - `ADAPTIVE_LIMIT_BANDS: { edges: [0.35, 0.6]; budgets: [null, 10, 5]; floors: [null, null, "P2"]; decay: 0.5; deferredWeight: 0.5 }` in `src/reviewer-tuning.ts`.
  - `limitsForScore(score: number | null): { floor: Sev | null; budget: number | null }`
- Consumes: `LedgerEntry`, `Ledger` from `src/ledger/types.ts`; `Verdict` from `src/feedback/types.ts`.

- [ ] **Step 1: Write the failing tests** in `src/trajectory.test.ts`:
  - `classifyFinding`: status `fixed`/`resolved`/`acknowledged` with `decidedBy: "author"` is `accepted`; the same statuses with `decidedBy: "reviewer"` is `unanswered`; `rejected` is `rejected`; `deferred` is `deferred`; `open` with no reactions is `unanswered`; `open` with `["down"]` is `rejected`; `open` with `["up"]` is `accepted`; a status always beats a reaction (`rejected` plus `["up"]` is `rejected`); `open` with only `["confused"]` is `unanswered`.
  - `scoreTrajectory`: no entries gives `{ score: null }`; one round of 3 rejected and 1 accepted gives `0.75`; two rounds (older 4 rejected of 4, newer 0 of 4) gives `(0.5 * 1 + 1 * 0) / 1.5` rounded to 4 places `0.3333`; a round whose entries are all unanswered is skipped and does not dilute; `age` of the newest earlier round is `0`.
  - `limitsForScore`: `null` and `0.34` give `{ floor: null, budget: null }`; `0.35` and `0.59` give budget 10; `0.6` and `1` give floor `P2` and budget 5.
- [ ] **Step 2: Run** `pnpm test src/trajectory.test.ts` and confirm failure (module not found).
- [ ] **Step 3: Implement** the functions above and the constants. Round age is `currentRound - 1 - entry.round`; entries with `round >= currentRound` are ignored.
- [ ] **Step 4: Run** the same command; all pass. Then `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** `feat(review): score the review trajectory from ledger outcomes`.

### Task 2: Moved-block detection

**Files:**
- Create: `src/moved-blocks.ts`, `src/moved-blocks.test.ts`

**Interfaces:**
- Produces:
  - `interface PushFile { filename: string; status: string; previous_filename?: string; patch?: string; additions: number; deletions: number }` (exported from this file; Task 3 imports it)
  - `interface MovedBlock { from: string; to: string; lineCount: number }`
  - `findMovedBlocks(files: PushFile[], minLines?: number): MovedBlock[]` with `minLines` defaulting to 5.

- [ ] **Step 1: Write the failing tests:**
  - 6 identical lines deleted in `a.ts` and added in `b.ts` give one block `{ from: "a.ts", to: "b.ts", lineCount: 6 }`.
  - The same block re-indented (tabs vs spaces, trailing whitespace) still matches.
  - 4 lines moved give `[]`.
  - Lines deleted and added in the same file give `[]`.
  - A block whose lines are all blank or a lone `}` or `)` gives `[]`.
  - Two files with no `patch` give `[]` and do not throw.
  - Run-order: consecutive means consecutive in the patch's deleted lines and in the other file's added lines; a block interrupted by one changed line splits into two runs and only a run of at least `minLines` counts.
- [ ] **Step 2: Run** `pnpm test src/moved-blocks.test.ts`; confirm failure.
- [ ] **Step 3: Implement** `findMovedBlocks`. Normalize each line by trimming and collapsing runs of whitespace, and ignore normalized lines shorter than 3 characters when counting but not when breaking a run. Index every added-line run per file by joined normalized text of each window; match deleted runs of length at least `minLines` against added runs in other files, longest first, each line used once.
- [ ] **Step 4: Run** tests, typecheck, lint; pass.
- [ ] **Step 5: Commit** `feat(review): detect code moved between files in a push`.

### Task 3: Push-shape classifier

**Files:**
- Create: `src/push-shape.ts`, `src/push-shape.test.ts`

**Interfaces:**
- Consumes: `PushFile`, `findMovedBlocks` from `src/moved-blocks.ts`; `isGeneratedFile` from `src/diff-pack.ts`.
- Produces:
  - `type FileKind = "code" | "test" | "docs" | "config" | "infra" | "shell" | "binary" | "generated" | "lockfile"`
  - `interface FileShape { filename: string; kind: FileKind; weight: number; whitespaceOnly: boolean; renameOnly: boolean; deletionOnly: boolean }`
  - `interface PushShape { files: FileShape[]; reviewableWeight: number; fileCount: number; moved: MovedBlock[] }`
  - `classifyFile(filename: string, hasPatch: boolean): FileKind`
  - `classifyPush(files: PushFile[]): PushShape`
  - `shapedBudget(shape: PushShape, bandBudget: number): number` returning `clamp(ceil(reviewableWeight / 8), 2, bandBudget)`.

- [ ] **Step 1: Write the failing tests:**
  - `classifyFile` table: `src/a.ts` code; `src/a.test.ts` and `tests/x.ts` test; `README.md` and `docs/x.md` docs; `package.json`, `tsconfig.json`, `.github/dependabot.yml` config; `Dockerfile`, `.github/workflows/ci.yml`, `main.tf` infra; `scripts/run.sh` shell; `pnpm-lock.yaml` lockfile; `logo.png` binary; a path where `isGeneratedFile` is true generated.
  - Whitespace-only: a patch whose `-` and `+` lines are equal after whitespace normalization gives `whitespaceOnly: true` and weight 0.
  - `renameOnly`: status `renamed` with 0 additions and 0 deletions gives weight 0.
  - `deletionOnly`: additions 0, deletions 40 gives `deletionOnly: true` and weight counted at the kind weight times the deleted lines.
  - Weight: 20 changed lines of docs is `6`; of code is `20`; of lockfile is `0`.
  - Moved lines are subtracted from the destination file's added-line count, so 20 added lines of which 10 are a moved block weigh `10`.
  - `fileCount` counts files; 20 files of 2 lines each and 1 file of 40 lines both weigh `40` for code but differ in `fileCount`.
  - `shapedBudget`: weight 0 with band 10 gives `2`; weight 40 with band 10 gives `5`; weight 400 with band 5 gives `5`; weight 3 with band 10 gives `2`.
  - A file with no `patch` (binary or oversized) does not throw and weighs 0.
- [ ] **Step 2: Run** `pnpm test src/push-shape.test.ts`; confirm failure.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** tests, typecheck, lint; pass.
- [ ] **Step 5: Commit** `feat(review): classify what a push changed`.

### Task 4: Applying and resolving the limits

**Files:**
- Create: `src/adaptive-limits.ts`, `src/adaptive-limits.test.ts`

**Interfaces:**
- Consumes: `scoreTrajectory`, `limitsForScore` (Task 1); `classifyPush`, `shapedBudget` (Task 3); `PushFile` (Task 2).
- Produces:
  - `interface Limitable { severity: Sev; confidence: number; path?: string | null; line?: number | null }`
  - `interface LimitableReview<G extends Limitable, I extends Limitable> { event: string; general_findings: G[]; inline_comments: I[] }`
  - `interface ResolvedLimits { floor: Sev | null; budget: number | null; score: number | null; rounds: RoundFriction[]; shape: PushShape | null }`
  - `resolveLimits(input: { entries: Ledger; reactionsFor: (e: LedgerEntry) => Verdict[]; currentRound: number; delta: PushFile[] | null }): ResolvedLimits` where `delta` is `null` for a non-incremental review, which skips `shapedBudget`.
  - `applyLimits<G, I, R extends LimitableReview<G, I>>(review: R, limits: { floor: Sev | null; budget: number | null }, supportOf: (f: G | I) => number, carriedBlocks: boolean): { review: R; removed: (G | I)[] }`

- [ ] **Step 1: Write the failing tests** (`applyLimits`):
  - P0 and P1 are never removed, even with floor `P2` and budget 1.
  - Floor `P2` removes P3 and keeps P2.
  - Budget 3 over 2 P1 and 4 P2 keeps both P1 plus the one highest-ranked P2; rank is severity, then `confidence`, then `supportOf`, then original position.
  - The pool spans `general_findings` and `inline_comments` together.
  - With `budget: null` and `floor: null`, nothing changes and `removed` is empty.
  - Event: `REQUEST_CHANGES` with every finding removed and `carriedBlocks: false` becomes `COMMENT`; the same with `carriedBlocks: true` stays `REQUEST_CHANGES`; with any finding left posted it stays `REQUEST_CHANGES`; `COMMENT` is never changed.
  - Input arrays are not mutated.
  - `resolveLimits`: `delta: null` with a band budget of 10 returns budget 10; `delta` of a docs-only push with band budget 10 returns the shaped budget `2`; a null score returns `floor: null, budget: null` whatever the delta.
- [ ] **Step 2: Run** `pnpm test src/adaptive-limits.test.ts`; confirm failure.
- [ ] **Step 3: Implement** both functions. `applyLimits` never mutates.
- [ ] **Step 4: Run** tests, typecheck, lint; pass.
- [ ] **Step 5: Commit** `feat(review): apply a severity floor and findings budget`.

### Task 5: `ADAPTIVE_LIMIT` discard reason and migration

**Files:**
- Modify: `src/discards.ts` (add `"ADAPTIVE_LIMIT"` to `DISCARD_REASONS`), `src/discards.test.ts`, `src/improve/db/schema.ts` only if the enum needs more than the shared constant
- Create: one Drizzle migration under `src/improve/db/migrations/` that adds the value to the `discard_reason` enum

**Interfaces:**
- Produces: `DiscardReason` now includes `"ADAPTIVE_LIMIT"`; a `Discard` with that reason has `code: null` and `disposition: "dropped"` (it falls in the existing `Exclude<...>` branch).

- [ ] **Step 1: Write the failing test** in `src/discards.test.ts` that builds a `Discard` with `reason: "ADAPTIVE_LIMIT"` (type check) and asserts `DISCARD_REASONS` contains it; add the schema test that the `discard_reason` enum values equal `DISCARD_REASONS`.
- [ ] **Step 2: Run** `pnpm test src/discards.test.ts src/improve/db/schema.test.ts`; confirm failure.
- [ ] **Step 3: Add the reason, then generate the migration** with the repo's Drizzle command (see `package.json` scripts and `src/improve/db/migrate.ts`). Do not apply it to any database.
- [ ] **Step 4: Run** tests, typecheck, lint; pass.
- [ ] **Step 5: Commit** `feat(improve): add the ADAPTIVE_LIMIT discard reason`. Note in the body that the migration is generated and not applied.

### Task 6: Wire the limits into the review

**Files:**
- Modify: `src/review.ts` (cap site around `capInlineComments(sanitizedComments, MAX_INLINE_COMMENTS)`), `src/review.test.ts`, `src/baseline.test.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: `resolveLimits`, `applyLimits` (Task 4); `toDiscard`, `discards`, `ledger`, `incrementalPass`, `scopedFiles`, `tuning` already in `buildReviewInner`.
- Produces: `limitNotice(limits: ResolvedLimits, removedCount: number): string | null` exported from `src/adaptive-limits.ts` (add test there): returns one plain sentence such as "Showing the 5 highest-severity findings this round (P2 and up), because most findings in earlier rounds were declined." and `null` when `removedCount` is 0.

- [ ] **Step 1: Write the failing tests** in `src/review.test.ts` with `tuning.adaptiveLimits: true` and a ledger of two earlier rounds that are mostly `rejected`:
  - Agents return 1 P1 and 8 P2; the posted review keeps the P1 and 4 P2 (floor P2, budget 5) and the other 4 appear as `ADAPTIVE_LIMIT` discards.
  - With `tuning.adaptiveLimits: false` the same input posts all 9.
  - Round 1 (no earlier own reviews) posts all 9 with the switch on.
  - When every new finding is removed and a carried P2 entry blocks, the event stays `REQUEST_CHANGES`; with no carried blocker it becomes `COMMENT`.
  - The review body contains the notice sentence, and `deriveBaseline` on that body returns no finding from it (add to `src/baseline.test.ts`).
  - A non-incremental review (forced rerun) uses the band budget unscaled.
- [ ] **Step 2: Run** `pnpm test src/review.test.ts src/baseline.test.ts`; confirm the new tests fail.
- [ ] **Step 3: Implement.** Move the `skillsByKey` map ahead of the cap site so `supportOf` can use it. Call `resolveLimits` with `ledger`, `currentRound` = the loaded ledger's `reviewIds.length` (the same indexing `LedgerEntry.round` uses), `delta = incrementalPass ? scopedFiles : null`. Call `applyLimits` on `{ event, general_findings, inline_comments: sanitizedComments }` before `capInlineComments`, set `carriedBlocks` from the surviving prior blockers (`survivingPrior` plus held entries), push one `ADAPTIVE_LIMIT` discard per removed finding per flagging skill, add the notice to the body, and log `console.log("adaptive limits", { score, rounds, floor, budget, removed })`. Skip all of it when `tuning.adaptiveLimits` is false.
- [ ] **Step 4: Run** the full suite; pass. Update `CLAUDE.md`: merge-layer paragraph, key-files rows for the four new modules, and the discard reason list.
- [ ] **Step 5: Commit** `feat(review): tighten findings from the PR's review trajectory`.

### Task 7: Reactions as an optional signal

**Files:**
- Create: `src/feedback/reactions-for.ts`, `src/feedback/reactions-for.test.ts`
- Modify: `src/review.ts` (pass `reactionsFor` into `resolveLimits`), `src/review.test.ts`

**Interfaces:**
- Consumes: `PostedCommentRecord` (`lastSeenReactions`, `path`, `line`, `title`) from `src/feedback/types.ts`. Match on `path`, `line` and the lowercased trimmed `title`, the normalization `discardKey` in `src/discards.ts` uses.
- Produces: `reactionsFor(records: PostedCommentRecord[]): (e: LedgerEntry) => Verdict[]`, joining a ledger entry to a record by path, line and normalized title and returning the values of `lastSeenReactions`; unmatched entries return `[]`.

- [ ] **Step 1: Write the failing tests:** an entry joins its record and returns `["down"]`; an unmatched entry returns `[]`; two reactors return both verdicts; no records returns a function that always returns `[]`. In `src/review.test.ts`: with KV returning a record whose reactions are `down` on an `open` entry, the entry counts as rejected in the score; with KV unset or throwing, the review proceeds on ledger statuses alone.
- [ ] **Step 2: Run** `pnpm test src/feedback/reactions-for.test.ts src/review.test.ts`; confirm failure.
- [ ] **Step 3: Implement.** In `buildReviewInner`, when `feedbackEnabled` and KV is configured, load the active records with `listActiveComments`, keep those for this owner, repo and PR, and wrap the call in try/catch so a KV failure logs and falls back to no reactions. Records expire, so older rounds may have none; that is expected.
- [ ] **Step 4: Run** the full suite; pass.
- [ ] **Step 5: Commit** `feat(review): read author reactions into the trajectory score`.

### Task 8: Replay trace runs the limits

**Files:**
- Modify: `src/replay/trace.ts`, `src/replay/trace.test.ts`

**Interfaces:**
- Consumes: `resolveLimits`, `applyLimits` (Task 4); fixture rounds, claims, labels and recorded reactions.
- Produces: `postFilterTrace` input gains optional `adaptive?: { entries: Ledger; reactionsFor: (e: LedgerEntry) => Verdict[]; currentRound: number; delta: PushFile[] | null }`; with it set and `tuning.adaptiveLimits` true, the trace applies `applyLimits` after `sanitizeInlineComments` and before `capInlineComments`, and every removed finding lands in `dropped` with `reason` visible to the report. A new `adaptiveInputForRound(fixture, labels, round)` builds `adaptive` from the fixture's earlier rounds only, the way `ledgerForRound` does.

- [ ] **Step 1: Write the failing tests:** a fixture whose earlier rounds are mostly rejected makes round `i` post fewer findings with the switch on than off; the removed candidates appear in a new `adaptiveRemoved` array returned beside `posted` and `dropped`; round 0 is unchanged; P0 and P1 candidates always appear in `posted`; `adaptiveInputForRound` for round `i` never reads round `i` or later.
- [ ] **Step 2: Run** `pnpm test src/replay/trace.test.ts`; confirm failure.
- [ ] **Step 3: Implement** the optional input and `adaptiveInputForRound`. The ledger it passes is all settled and open entries of earlier rounds, not only the holdable ones. Fixtures carry no push file list, so `delta` is `null` unless the round's compare files are present.
- [ ] **Step 4: Run** the full suite; pass.
- [ ] **Step 5: Commit** `feat(replay): run adaptive limits in the post-filter trace`.

### Task 9: Replay report and gate

**Files:**
- Create: `src/replay/adaptive-report.ts`, `src/replay/adaptive-report.test.ts`
- Modify: the replay CLI entry that prints the classification and filter-margin reports, `CLAUDE.md` (replay bullet)

**Interfaces:**
- Consumes: traces from Task 8; labels; the existing adjudication verdict cache reader in `src/replay/adjudication/` (read-only, no model calls).
- Produces: `adaptiveReport(fixtures): { perFixture: AdaptiveRow[]; gate: "pass" | "fail" | "inconclusive"; text: string }` where a row has `removedReal`, `removedRejected`, `removedUnjoined`, `postedBefore`, `postedAfter` per round and `roundsToClean`. Gate rules: `inconclusive` when fewer than 10 removed candidates carry a label or an adjudicated verdict; `fail` when any confirmed-real finding is removed on a held-out fixture; otherwise `pass`. Printed by default replay when any fixture has traces; it changes no exit code.

- [ ] **Step 1: Write the failing tests:** 12 removed candidates all labelled rejected gives `pass`; one removed candidate labelled real on a held-out fixture gives `fail`; 9 labelled or adjudicated gives `inconclusive`; an adjudicated `real` verdict counts as real; unadjudicated candidates are listed separately and do not count.
- [ ] **Step 2: Run** `pnpm test src/replay/adaptive-report.test.ts`; confirm failure.
- [ ] **Step 3: Implement** the report and print it from the default replay run next to the filter-margin report. Update the `ai-review replay` bullet in `CLAUDE.md`.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm test`, then run `ai-review replay` and confirm it prints the new section without error.
- [ ] **Step 5: Commit** `feat(replay): report what adaptive limits would remove`.

## Finish

- [ ] Re-read the diff as a hostile reviewer; run `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] `ai-review review --full` before the first push; fix every real finding; one more pass on the fix batch.
- [ ] Run `ai-review replay` and record the adaptive report in the PR body. The switch stays `false` until the gate says `pass`.
- [ ] `/no-mistakes --skip ci` after the PR exists, then `/pr-loop`. The migration is committed, not applied.
- [ ] Close `ai-review-bot-t0c.30` and `ai-review-bot-t0c.41`; `wt-reap adaptive-review-limits` from the main checkout.
