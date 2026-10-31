# No-mistakes gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ai-review gate` runs the multi-agent review on a branch's changes before a PR exists and reports findings to no-mistakes as a custom gate.

**Architecture:** A new `src/gate/` module wraps the existing review pass. The provider loop in `runLocalReview` is extracted so the gate can reuse it without writing a report. A per-repo-and-branch JSON store holds ledger entries; each round matches new findings to open entries (lineage ids), suppresses against entries settled before the round, and infers fixes from changed diffs. Output is the no-mistakes findings JSON.

**Tech Stack:** TypeScript ESM (`.js` import specifiers, named exports only), Vitest, Biome, pnpm. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-no-mistakes-gate-design.md`

## Global Constraints

- pnpm only. Never npm, npx or yarn. Run tests with `pnpm test` (a hook blocks command text that names the test-runner binary).
- Named exports only; imports use `.js` extensions.
- Gate ids: `ai-review-` + 12 hex chars; no commas; `-2`, `-3` suffix on collision in body-hash order.
- Severity map: P0 and P1 give `error` + `ask-user`; P2 gives `warning` + `ask-user`; P3 gives `info` + `no-op`.
- Findings file: `{"findings":[...]}`, unknown fields rejected, at most 500 findings and 1 MiB. Cap order: drop lowest severity first; an `error` goes last.
- Exit 0 whenever the report is written. Non-zero only when no provider authenticates or every agent fails (the existing `runLocalReview` throws).
- With `NO_MISTAKES_FINDINGS_FILE` unset: print findings as text to stdout, exit 1 if any `error` finding exists, else 0.
- Entry evidence strings: `head:<sha>`, `diff:<sha1 of git diff <merge-base> HEAD -- <path>>`; inferred fix appends `inferred: absent after diff changed`.
- Never import the gate from webhook paths. No KV. No GitHub reads or writes.
- `ai-review review` output must not change.
- Subagents: commit only your own files, no push, scoped `pnpm exec biome check --write <files>`.

## Review Focus

- Detached HEAD with several local branches pointing at the same commit: store key falls back to the merge-base sha, never another branch's file.
- A paraphrased title on a still-open finding keeps its id and is not marked fixed.
- Rebase onto a moved base with the file untouched: not treated as a fix.
- One provider missing or one agent failing in round 2: nothing is inferred fixed.
- Corrupt store file: moved aside, run continues, warning printed.

---

### Task 1: Extract the review pass from runLocalReview

**Files:**
- Modify: `src/audit.ts` (around `runLocalReview`, lines 638-765)
- Test: `src/audit.test.ts`

**Interfaces:**
- Produces, exported from `src/audit.ts`:
  - `ReviewPassResult = { merged: ModelReview; costUsd: number; providersRun: Provider[]; models: string[]; agentsAttempted: number; agentsSucceeded: number }`
  - `runReviewPasses(opts: { files: AuditFile[]; meta: { owner: string; repo: string; ref: string }; extraInstructions?: string; resolveAuthFor?: (p: Provider) => Promise<ResolvedAuth> }): Promise<ReviewPassResult>`. It holds the provider loop, the "no provider authenticated" throw, the "every agent failed" throw and `mergeReviews`. It writes nothing.
- Consumes: existing `runAuditPass`, `routeModel`, `computeCost`, `mergeReviews`.

- [ ] **Step 1: Write the failing test** in `src/audit.test.ts`, named `runReviewPasses returns the merged review and agent counts without writing a report`. Use the existing mock style in that file. Assert `result.merged` equals the mocked merge, `result.agentsSucceeded === result.agentsAttempted`, `result.providersRun` lists the authenticated providers, and no file appears under a temp `docsDir`.
- [ ] **Step 2: Run** `pnpm test src/audit.test.ts` → FAIL: `runReviewPasses` is not exported.
- [ ] **Step 3: Move** lines 670-726 of `runLocalReview` into `runReviewPasses`, keeping both throw messages verbatim. `runLocalReview` calls it, then keeps the report writing. `ReviewScope`/`LocalReviewResult` unchanged.
- [ ] **Step 4: Run** `pnpm test src/audit.test.ts` → all pass, including the untouched `runLocalReview` tests.
- [ ] **Step 5: Commit** `refactor(audit): extract runReviewPasses from runLocalReview`.

### Task 2: Match a finding against open ledger entries

**Files:**
- Modify: `src/ledger/match.ts` (`findSettledMatch`, line 145)
- Test: `src/ledger/match.test.ts`

**Interfaces:**
- Produces: `findOpenMatch(finding: ClaimLike, ledger: Ledger): LedgerEntry | null`. It uses the same rules, filters, ranking and tie-break as `findSettledMatch`, but candidates are entries where `!isSettled(e)`.
- `findSettledMatch` keeps its signature and behavior; both call one private `findMatch(finding, ledger, pick)`.

- [ ] **Step 1: Write failing tests** `findOpenMatch returns an open entry that restates the finding`, `findOpenMatch ignores settled entries`, `findSettledMatch ignores open entries` (the existing guarantee, pinned), and `a test-gap finding does not match an open defect entry`.
- [ ] **Step 2: Run** `pnpm test src/ledger/match.test.ts` → FAIL (`findOpenMatch` undefined).
- [ ] **Step 3: Refactor** into `findMatch` with a `pick: (e: LedgerEntry) => boolean` parameter; export `findOpenMatch`.
- [ ] **Step 4: Run** `pnpm test src/ledger` → pass.
- [ ] **Step 5: Commit** `feat(ledger): match findings against open entries`.

### Task 3: Range scope and base resolution

**Files:**
- Modify: `src/sources.ts`
- Test: `src/sources.test.ts`

**Interfaces:**
- Consumes: `GitRunner`, `AuditFile`, `hasCodeExtension`.
- Produces:
  - `resolveBase(runGit: GitRunner, explicit?: string): string`: `explicit`, else target of `refs/remotes/origin/HEAD`, else `origin/main`, else `origin/master` (the first that `git rev-parse --verify` accepts); throws `No base branch found` otherwise.
  - `RangeChange = { path: string; oldPath: string | null; status: "A" | "M" | "D" | "R" }`
  - `listRangeChanges(runGit: GitRunner, base: string): { mergeBase: string; changes: RangeChange[] }` from `git diff -M --name-status <merge-base> HEAD`, code extensions only (for a rename, the new path decides).
  - `diffHash(runGit: GitRunner, mergeBase: string, path: string): string` (sha1 of `git diff <mergeBase> HEAD -- <path>`).
  - `collectFilesFromRange(opts: { cwd: string; changes: RangeChange[]; only?: ReadonlySet<string>; runGit?: GitRunner }): Promise<AuditFile[]>`: reads non-deleted files at `HEAD` with `git show HEAD:<path>`, restricted to `only` when given.

- [ ] **Step 1: Write failing tests** with a fake `GitRunner`: `resolveBase prefers an explicit ref`, `resolveBase falls back to origin/main then origin/master`, `listRangeChanges reports renames with the old path`, `listRangeChanges drops non-code files`, `diffHash is stable for equal diffs and differs when the diff changes`, `collectFilesFromRange skips deleted files and honors only`.
- [ ] **Step 2: Run** `pnpm test src/sources.test.ts` → FAIL.
- [ ] **Step 3: Implement** the five functions above in `src/sources.ts`.
- [ ] **Step 4: Run** `pnpm test src/sources.test.ts` → pass.
- [ ] **Step 5: Commit** `feat(sources): range scope for pre-PR review`.

### Task 4: Gate store

**Files:**
- Create: `src/gate/store.ts`
- Test: `src/gate/store.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `LedgerEntry` from `src/ledger/types.ts`; `Provider` type used by `src/audit.ts`.
- Produces:
  - `GateStore = { version: 1; providers: Provider[]; lastHead: string | null; entries: Ledger }` and `emptyStore(): GateStore`
  - `storeKey(runGit: GitRunner, owner: string, repo: string, mergeBase: string): string`: branch from `git for-each-ref --points-at HEAD refs/heads/` when exactly one; otherwise the merge-base sha; returns `sha256(owner/repo)` hex (first 16) + `__` + percent-encoded branch-or-sha.
  - `gateStorePath(key: string, dir?: string): string`: dir defaults to `AI_REVIEW_GATE_DIR` or `~/.ai-review/gate`.
  - `loadStore(path: string): Promise<{ store: GateStore; warning: string | null }>`: ENOENT gives an empty store, no warning. Malformed JSON or invalid entries: rename the file to `<path>.corrupt-<timestamp>`, return an empty store and a warning that says history was reset.
  - `saveStore(path: string, store: GateStore): Promise<void>`: temp name with pid and random suffix, atomic rename, creates the directory.

- [ ] **Step 1: Write failing tests**: `storeKey uses the single branch pointing at HEAD`, `storeKey falls back to the merge base when two branches point at HEAD`, `storeKey never puts a slash from a branch name in the file name`, `loadStore returns an empty store when the file is missing`, `loadStore moves a corrupt file aside and warns`, `saveStore then loadStore round-trips`, `two saves in one process do not collide on the temp name`.
- [ ] **Step 2: Run** `pnpm test src/gate/store.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the functions above; reuse the entry validation from `src/ledger/file.ts` (export `isEntry` from there rather than copying).
- [ ] **Step 4: Run** `pnpm test src/gate/store.test.ts src/ledger` → pass.
- [ ] **Step 5: Commit** `feat(gate): per-branch ledger store`.

### Task 5: Findings report

**Files:**
- Create: `src/gate/report.ts`
- Test: `src/gate/report.test.ts`

**Interfaces:**
- Produces:
  - `GateFinding = { id: string; severity: "error" | "warning" | "info"; description: string; file?: string; line?: number; action: "ask-user" | "no-op" }`
  - `toGateFinding(entry: LedgerEntry, suggestion?: string | null): GateFinding`: severity map from Global Constraints; description is title, body, suggestion; `file`/`line` omitted when the entry has no path.
  - `capFindings(findings: GateFinding[], max = 500): { kept: GateFinding[]; dropped: number }`
  - `formatReport(findings: GateFinding[]): string` (JSON, `{"findings":[...]}`)
  - `validateReport(json: string): string[]`: returns problems; it mirrors the documented schema (required fields, enum values, comma-free unique ids, non-negative line, unknown fields, 1 MiB, 500). Used by tests and as a runtime guard before writing.

- [ ] **Step 1: Write failing tests**: `maps P0 and P1 to error ask-user`, `maps P2 to warning ask-user`, `maps P3 to info no-op`, `omits file and line for a general finding`, `capFindings drops info before warning before error`, `capFindings drops an error only when nothing else is left`, `validateReport rejects an id with a comma`, `validateReport rejects an unknown field`, `formatReport output passes validateReport`.
- [ ] **Step 2: Run** `pnpm test src/gate/report.test.ts` → FAIL.
- [ ] **Step 3: Implement** the four functions.
- [ ] **Step 4: Run** → pass.
- [ ] **Step 5: Commit** `feat(gate): no-mistakes findings report`.

### Task 6: Round logic

**Files:**
- Create: `src/gate/round.ts`
- Test: `src/gate/round.test.ts`

**Interfaces:**
- Consumes: `findOpenMatch`, `suppressInReview` (applied to the merged review against settled entries only), `GateStore`, `ModelReview`, `Provider`.
- Produces:
  - `RoundInput = { merged: ModelReview; store: GateStore; head: string; round: number; hashes: ReadonlyMap<string, string>; renames: ReadonlyMap<string, string>; reviewedPaths: ReadonlySet<string> | "all"; complete: boolean; providers: Provider[]; fullRescope: boolean }`. `hashes` is path → current `diffHash` for every path in range; `renames` is oldPath → newPath.
  - `applyRound(input: RoundInput): { store: GateStore; emitted: { entry: LedgerEntry; suggestion: string | null }[]; suppressed: number; warnings: string[] }`

Behavior (spec, "What the gate can see"), in order: apply renames to entry paths (ids kept); match each finding to an open entry with `findOpenMatch` (keep its id, refresh title, line, body, evidence; one finding per entry); take the unclaimed rest: a match on an entry inferred fixed (`decidedBy` null) reopens it under its id and emits it, a match on an entry a person settled before the round is suppressed with `suppressInReview`; mint a new entry for what is left (`ai-review-` + sha1 over path, title, head, 12 hex; collisions get `-2`, `-3` in body-hash order); infer `fixed` for unmatched open entries only when `complete`, `!fullRescope`, `providers` equals `store.providers`, and (the entry's `diff:` evidence differs from `hashes.get(path)` or the path is absent from `hashes`); entries whose path is outside `reviewedPaths` are neither matched nor inferred. Inferred entries do not suppress in the same round. `fullRescope`, an incomplete round or a provider mismatch adds a warning and leaves every unmatched entry `open`. The returned store records `providers` and `lastHead: head` only when `complete`.

- [ ] **Step 1: Write failing tests**: `a new finding becomes an open entry with a minted id`, `a paraphrased title on an open finding keeps its id`, `an unmatched open entry whose diff changed becomes fixed`, `an unmatched open entry whose diff is unchanged stays open`, `a rebase that moves the base but not the file's diff does not mark it fixed` (same hash), `a file that left the range is fixed`, `a rename keeps the id and moves the path`, `a finding already settled before the round is suppressed`, `an entry inferred fixed this round does not suppress a paraphrase in the same round`, `an incomplete round infers nothing and warns`, `a provider-set change infers nothing and warns`, `fullRescope infers nothing`, `entries for files outside reviewedPaths are left alone`, `two findings with the same hash input get -2 in body-hash order regardless of input order`.
- [ ] **Step 2: Run** `pnpm test src/gate/round.test.ts` → FAIL.
- [ ] **Step 3: Implement** `applyRound` as a pure function (no I/O, no clock).
- [ ] **Step 4: Run** `pnpm test src/gate` → pass.
- [ ] **Step 5: Commit** `feat(gate): round logic with lineage ids and inferred fixes`.

### Task 7: Gate command, CLI wiring, repo config, docs

**Files:**
- Create: `src/gate/run.ts`, `src/gate/run.test.ts`
- Modify: `src/cli.ts` (add `gate` to the command switch near line 1223 and the usage text), `.no-mistakes.yaml` (create), `CLAUDE.md` (Key files row, subcommand paragraph, test count), `README.md` (short section: config snippet, the `NO_MISTAKES_FINDINGS_FILE` behavior, the known limit)

**Interfaces:**
- Consumes: Tasks 1 to 6.
- Produces: `runGate(opts: { cwd: string; owner: string; repo: string; base?: string; extra?: string; findingsFile?: string; storeDir?: string; runGit?: GitRunner; review?: (files: AuditFile[]) => Promise<ReviewPassResult> }): Promise<{ exitCode: 0 | 1; stdout: string; findings: GateFinding[] }>`. `review` defaults to `runReviewPasses` with `ref: "range"`. It throws only where `runReviewPasses` throws.
- Flow: `resolveBase`, `listRangeChanges`, `storeKey`, `loadStore`; no code files gives an empty report without calling `review`; `fullRescope` unless `store.lastHead` is an ancestor of HEAD (`git merge-base --is-ancestor`); `only` is every path on the first or full round, else paths whose `diffHash` differs from the entry evidence or are new; `collectFilesFromRange`, `review`, `applyRound`, `saveStore`, `capFindings`, `formatReport`, `validateReport`; write to `findingsFile` when given, else print and set `exitCode` from `error` findings.
- `.no-mistakes.yaml` contents: `agent: claude`, a `gates:` entry `{name: ai-review, after: review, command: "ai-review gate"}`, and `auto_fix: { gates: { ai-review: 0 } }`. Preserve any keys the verification run needs; do not add `commands`.

- [ ] **Step 1: Write failing tests** in `src/gate/run.test.ts` with a fake `GitRunner`, a fake `review` and a temp `storeDir`: `writes a schema-valid report to the findings file`, `an empty range writes an empty report and never calls review`, `round 2 reviews only files whose diff changed`, `round 2 after a rebase that dropped the stored head reviews the full range and infers nothing`, `a fixed finding is absent from round 2 and marked fixed in the store`, `without a findings file it prints text and exits 1 on an error finding`, `without a findings file and no error finding it exits 0`, `a corrupt store prints the reset warning and continues`.
- [ ] **Step 2: Run** `pnpm test src/gate/run.test.ts` → FAIL.
- [ ] **Step 3: Implement** `runGate` and `cmdGate` in `src/cli.ts` (`--base`, `--extra`, owner/repo from `originSlug()`, findings file from `process.env.NO_MISTAKES_FINDINGS_FILE`), then the config and docs. Update the test count in `CLAUDE.md` from the real `pnpm test` total.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm test` → all pass.
- [ ] **Step 5: Commit** `feat(gate): ai-review gate command for the no-mistakes pipeline`.

### Task 8: Verification

**Files:** none (evidence goes in the PR and on the bead).

- [ ] **Step 1:** `pnpm build && node dist/cli.js replay`; compare with `/private/tmp/claude-501/-Users-joe-github-joeblackwaslike-ai-review-bot/25f9f5bb-a21f-4e9a-8fe6-4d015bc3b601/scratchpad/replay-before.txt`. Expected: same fixture count, recall guard and `negativePairs` green.
- [ ] **Step 2:** In the scratch repo from the spike, point the gate at `ai-review gate` and drive two rounds through `no-mistakes axi run` (finding parks the gate; a fix commit passes). Record the protocol path as unverified if no-mistakes is still v1.75.2.
- [ ] **Step 3:** Whole-branch review on the most capable model, then fix real findings.

---

## Self-review notes

- Spec coverage: contract and fallback (Task 7), scope and base (3), store, key, concurrency, corrupt (4), ids, matching, suppression, inference, partial rounds, rename (6), severity, cap, description, exit (5, 7), dogfood config (7), cost note (README, 7), verification (8). Non-goals have no task by design.
- Types: `ReviewPassResult` (1) feeds `RoundInput.providers`/`complete` (6, 7); `GateStore` (4) is used in 6 and 7; `GateFinding` (5) is used in 7.
