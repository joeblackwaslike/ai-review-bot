# Vercel parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carried findings stop blocking once their thread is settled or their file leaves the PR, and `buildReview` takes review state only from GitHub, so a deployment with KV unset or failing decides the same way.

**Architecture:** A pure function maps each carried finding's path through the PR's renames and retires findings whose file is not in the PR. `buildReview` calls it before ledger reconciliation and prints retired findings in a short note. The KV read and write of `ReviewState` come out of `buildReview`; the in-memory `state` stays and is filled by `deriveBaseline`.

**Tech Stack:** TypeScript ESM, vitest, biome, pnpm. Named exports only, `.js` import extensions, tests colocated.

**Spec:** `docs/superpowers/specs/2026-10-30-vercel-parity-design.md`

## Global Constraints

- pnpm only. Never npm, npx, yarn or tsx. Run tests with `pnpm test` (a hook blocks commands naming the test-runner binary). Scoped lint fix: `pnpm exec biome check --write <files>`.
- No installs, no push. Commit only your own files. Work in `.worktrees/vercel-parity` on branch `feat/vercel-parity`; run `pwd` and `git branch --show-current` before every commit.
- Quality gates before the branch is done: `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm exec ai-review replay` (default run) green. Record the replay numbers before the first change and after the last.
- Tests are written first and must be seen failing. Quote the red output in the task report.
- Test fakes that stand in for GitHub assert the request shape (REST parameters, GraphQL variables). A mock that ignores its arguments hid a production bug in sprint 2.
- Spec rules, verbatim: "A carried finding whose path is not in the PR file set cannot anchor to the head. It is retired." "If `deriveBaseline` or the ledger fetch fails, the round degrades to a full review that suppresses nothing. It never degrades to a skipped review, and it never errors." Retirement applies only to carried findings, never to findings from the current round.
- Do not start sprint 6. Do not touch the feedback loop or carrier comment KV use. Do not run `ai-review watch`.
- No ASCII banner comments. Comments only where the code cannot say it.

## Review Focus

- A prior review at REQUEST_CHANGES whose only blocking findings are all retired, with a clean delta: the round must post (APPROVE or COMMENT), not stay silent, so the stale CHANGES_REQUESTED clears. Test in Task 2.
- A carried finding on a file renamed from a base file (`previous_filename` set): kept, with the new path, and settled if its thread is settled. Test in Task 1.
- A path-less carried finding: untouched by retargeting. Test in Task 1.
- `kv` set but every call throws, versus `kv` null: identical event and body. Test in Task 3.
- Baseline derivation throws or the ledger times out: a full, unsuppressed review, no error. Test in Task 3.

---

## File structure

- Create `src/ledger/retarget.ts` and `src/ledger/retarget.test.ts`: pure path mapping and retirement.
- Modify `src/review.ts`: call retarget where `survivingPrior` is built (`~1848`), thread `retiredPrior` into the body builder (`~902`, rendered next to the "Still open" block `~1067`), remove KV state I/O (`~1633-1652`, `~1714-1727`, `~2653-2712`), narrow the `ScopeNote` type (`~926`).
- Modify `src/review.test.ts`: new #92-shaped and KV-off tests; migrate the 33 `kv: client` tests.
- Modify `src/testing.ts`: a helper that builds a prior own review body carrying the `ai-review:` markers and a findings table, if none exists.
- Modify `CLAUDE.md`, `docs/` mentions of KV state; add the replay fixture under `src/replay/fixtures/`.

### Task 1: Retarget carried findings

**Files:**
- Create: `src/ledger/retarget.ts`
- Test: `src/ledger/retarget.test.ts`

**Interfaces:**
- Consumes: `PersistedFinding` and `findingId` from `src/review-state.ts`.
- Produces:
  - `export interface PathFile { filename: string; previous_filename?: string }`
  - `export interface RetargetResult { kept: PersistedFinding[]; retired: PersistedFinding[] }`
  - `export function retargetCarried(prior: readonly PersistedFinding[], files: readonly PathFile[]): RetargetResult`

- [ ] **Step 1: Write the failing tests** in `retarget.test.ts`:
  - `keeps a finding whose path is in the PR unchanged`
  - `maps a finding through previous_filename and recomputes its id with findingId(newPath, line, title)`
  - `retires a finding whose path is neither a filename nor a previous_filename` (the #92 case: file list holds `src/replay/retraction-rule.ts` as added, finding path is `src/self-retraction.ts`)
  - `leaves a path-less finding in kept`
  - `returns kept and retired in the input order`
- [ ] **Step 2: Run** `pnpm test src/ledger/retarget.test.ts`. Expected: FAIL, module not found. Quote it.
- [ ] **Step 3: Implement** `retargetCarried` in `src/ledger/retarget.ts`. Build one `Map` from `previous_filename` to `filename` and one `Set` of filenames; a path in the set wins over the map.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ledger): retarget carried findings through PR renames and retire the ones whose file left the PR`

### Task 2: Wire retargeting into buildReview and the review body

**Files:**
- Modify: `src/review.ts` (`~1848` where `survivingPrior` is built; body builder options `~902`; "Still open" block `~1067`)
- Test: `src/review.test.ts`

**Interfaces:**
- Consumes: `retargetCarried` and `PathFile` from Task 1; `reconcileSurvivingPrior` from `src/ledger/live.ts`; `files` (full paginated `PullFile[]`, `review.ts:1510`).
- Produces: a `retiredPrior: PersistedFinding[]` option on the body builder; body text `#### Retired, file no longer in this PR` followed by one row per retired finding (severity, title, old path), printed only when non-empty. Retired findings do not enter `survivingPrior`, `blockingPrior`, the persisted list, or the readiness score.

- [ ] **Step 1: Write the failing test** `a prior REQUEST_CHANGES review whose carried findings are all on a file that left the PR posts a non-blocking review`. Fixture shape from PR #92: PR files contain `src/replay/retraction-rule.ts` (added, no `previous_filename`); the prior own review body carries markers plus three findings at `src/self-retraction.ts:49`, `:73` and one P2; the delta is clean and agents return no findings. Assert: the decision is not null, `event` is not `REQUEST_CHANGES`, the body contains `Retired, file no longer in this PR` and does not contain `Still open from the previous review`.
- [ ] **Step 2: Write the failing test** `retargets through previous_filename so a settled thread still suppresses`: finding at the old path, `files` has the new name with `previous_filename`, the ledger holds a settled entry at the new path with the same title. Assert the finding is not carried.
- [ ] **Step 3: Run** `pnpm test src/review.test.ts -t "left the PR"` and the second test. Expected: FAIL (event is REQUEST_CHANGES; no Retired note). Quote it.
- [ ] **Step 4: Implement.** At `~1848` call `retargetCarried(state.findings.filter(open), files)`, pass `kept` to `reconcileSurvivingPrior`, keep `retired` as `retiredPrior`. Check how the triage gate and `markResolved` key prior findings by id before this line; retargeting changes an id only for a renamed path, so keep every later lookup on the retargeted list. Render the note beside the "Still open" block. Verify that the silence branch at `~2503` does not swallow the round: `needsFreshApprove` must be true when the standing verdict is changes-requested; fix the condition if the new test shows a silent return.
- [ ] **Step 5: Run** `pnpm test src/review.test.ts`. Expected: PASS, no other review test changes.
- [ ] **Step 6: Commit** `fix(review): retired findings no longer hold a PR at CHANGES_REQUESTED`

### Task 3: Review state comes only from GitHub

**Files:**
- Modify: `src/review.ts` (`~1633-1652` load, `~1653` `baselineSource`, `~1714-1727` `carryVerdictForward`, `~2653-2712` save, `~926` `ScopeNote`), `src/testing.ts`, `src/review.test.ts`
- Keep: `src/review-state.ts` types and `findingId`; remove `loadReviewState`/`saveReviewState` and their tests only if nothing else imports them (`grep` first).

**Interfaces:**
- Consumes: `deriveBaseline` (`src/baseline.ts`), `context.kv` stays on `ReviewContext` for the claim and feedback code in `github-app.ts`.
- Produces: `buildReview` never calls `context.kv`; `ScopeNote` is `` `scope: delta from ${string} (github)` | `scope: full (${ScopeReason})` ``; `carryVerdictForward(event)` only restamps the check run.

- [ ] **Step 1: Write the failing tests** in `review.test.ts`:
  - `a throwing kv does not fail a non-forced review` (client whose every method rejects; today this throws at `review.ts:1643`).
  - `kv set and kv null give the same event, body and scope note for the same prior review`.
  - `a failing baseline derivation falls back to a full review without error` (ledger fetch rejects).
  - `buildReview makes no kv calls` (client methods are spies; assert none called).
- [ ] **Step 2: Run** them. Expected: FAIL (the throwing-kv test throws; the spy test sees calls). Quote it.
- [ ] **Step 3: Implement** by deleting the KV load, both `saveReviewState` blocks and the KV guard in `carryVerdictForward`; keep `state` as the in-memory variable filled by `deriveBaseline`; set `baselineSource` to `"github"`.
- [ ] **Step 4: Migrate the 33 `kv: client` tests.** A test that seeded `saveReviewState` now seeds a prior own review body (markers plus findings table) through the helper in `src/testing.ts`; a test that asserted a KV write now asserts the posted body markers (`ai-review:sha`, `ai-review:review`, `agents`). Do not delete a test to make it pass; if one only asserted KV persistence, replace it with the marker assertion or drop it and say why in the report.
- [ ] **Step 5: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 6: Commit** `refactor(review): take review state from GitHub only; KV stays for the claim and feedback`

### Task 4: Real GitHub and replay evidence

**Files:**
- Create: `src/replay/fixtures/joeblackwaslike__ai-review-bot__92__anthropic.json` and the `openai` twin, recorded with `pnpm exec ai-review replay --record https://github.com/joeblackwaslike/ai-review-bot/pull/92 --provider anthropic --bot anthropicreviewbot` (and `--provider openai --bot codexreviewbot`).
- Modify: `CLAUDE.md` (KV description in "Environment variables" and the baseline row), `docs/` pages that describe KV review state.

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: fixtures that the default replay run loads; labels stay provisional.

- [ ] **Step 1: Record** the replay numbers on `origin/main` behavior: run `pnpm exec ai-review replay` before Task 1's change on a clean checkout of the branch base, save the output under the scratchpad.
- [ ] **Step 2: Record** the PR #92 fixtures (read only, `gh`). Re-run the default replay. Expected: green, recall guard and negativePairs unchanged; compare with Step 1 and report both.
- [ ] **Step 3: Real-GitHub read-only check.** Run `deriveBaseline` and `loadLedger` against PR #92 and the three incident PRs with a throwaway script in the scratchpad (not committed); report, per PR, whether the baseline is complete and which carried findings `retargetCarried` would retire, using `GET /pulls/<n>/files`.
- [ ] **Step 4: Update docs** for the KV change and the retired-findings note. State that KV remains for the claim and feedback only.
- [ ] **Step 5: Commit** `test(replay): record PR #92 and document GitHub-only review state`

## Self-review

- Spec coverage: goal 1 and 2 (Tasks 1, 2), goal 3 (Task 2 test), goal 4 (Task 3), verification section (Task 4), `bne` closure and the post-deploy review happen outside code tasks at the finish.
- Types: `retargetCarried`, `PathFile`, `RetargetResult` and `retiredPrior` are named the same in Tasks 1 and 2.
- Risk: Task 3 step 4 is the largest edit (33 tests). It is the reason this task gets the most capable model.
