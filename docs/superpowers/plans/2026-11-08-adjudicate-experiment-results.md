# Adjudicate Experiment Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ai-review replay --adjudicate-results` judge the findings a strategy actually posted in an experiment run, so the scorer's precision is not limited to findings that restate a labelled claim.

**Architecture:** `runAdjudication` (src/replay/adjudication/run.ts) already judges a list of unmatched candidates against cached per-snapshot verdicts. Task 1 lets its caller supply the candidates and report its judge spend. Task 2 adds a driver that walks a committed plan's fixtures, builds candidates from the results store, and runs Task 1's hook with shared caps. The scorer already reads `cache.get(snapshotId(fixture), claimKey(posted))`, so it does not change.

**Tech Stack:** TypeScript ESM (`.js` import extensions), Vitest colocated tests, Biome. Run with `bun src/cli.ts replay ...`.

**Spec:** docs/superpowers/specs/2026-11-05-review-experiments-harness-design.md (section 5, section 7, and "Addendum: adjudicating experiment output").

## Global Constraints

- Named exports only; no section-banner comments; comments only where unavoidable.
- No task calls a model in tests; judges are fakes. Nothing in this plan spends money.
- A draft plan or a plan without a matching committed lock is refused, as `run` and `score` do.
- For a test-split fixture the command prints only the number of judge calls, never real/not-real/unclear counts.
- Caps (`--max-anthropic`, `--max-openai`) are totals for the whole command. Defaults: `DEFAULT_MAX_ANTHROPIC` (40) and `DEFAULT_MAX_OPENAI` (0).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green at the end of every task. Do not run `biome --write` on `src/replay` broadly (it reformats fixtures).

## Review Focus

- A fixture whose cells posted nothing, or whose every posted finding joins a labelled claim: zero candidates, no judge built, no error.
- The same finding posted in several rounds and by both strategies: judged once.
- A cached current verdict is reused, not re-judged; a verdict from an older prompt hash is judged again.
- The cap runs out partway through the fixture list: remaining fixtures report "deferred", the command still exits 0 and says how many findings are unjudged.
- A stored cell for a strategy version the plan no longer lists (stale): not judged.

---

### Task 1: Candidate override and spend report in `runAdjudication`

**Files:**
- Modify: `src/replay/adjudication/run.ts` (`AdjudicationRun`, `runAdjudication`)
- Test: `src/replay/adjudication/run.test.ts` (create if absent; follow the existing adjudication tests for fakes)

**Interfaces:**
- Produces: `AdjudicationRun.candidates?: (fixture: ReplayFixture, labels: LabelFile) => Located[]` — when set it replaces the saved-trace `unmatchedCandidates(fixture, labels)` source. `Located` (currently private to run.ts) becomes an exported type `AdjudicationCandidate = AdjCandidate & { roundIndex: number }`.
- Produces: `AdjudicationRun.onSpend?: (spend: { anthropic: number; openai: number }) => void` — called once per non-`plan`, non-`audit` run with the calls made, including 0, and also when the run ends in an unavailable-judge error.
- Produces: `AdjudicationRun.quiet?: boolean` — when true the `verdicts:` summary line is replaced by `judge calls made` only (no real/not-real/unclear counts); every other output line that does not reveal verdicts is unchanged. Used for test-split fixtures.
- Default behavior with none of the three set is byte-identical to today; existing tests stay green and unchanged.

- [ ] **Step 1:** Write failing tests: `candidates override replaces the saved-trace source` (fake judges, a fixture with no trace, an override returning one candidate, assert the judge ran once), `onSpend reports calls made` (assert `{anthropic: 1, openai: 0}`), `onSpend reports 0 when everything is cached`, `quiet hides verdict counts` (output contains `judge calls made` and does not match `/real=|not-real=|unclear=/`).
- [ ] **Step 2:** Run `pnpm vitest run --reporter=verbose src/replay/adjudication/run.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement the three optional fields; export `AdjudicationCandidate`; thread `candidates` into the `unmatchedCandidates` call site (line ~185) and `planLines`; report spend where `spend` is already accumulated.
- [ ] **Step 4:** Re-run the file plus `src/replay/adjudication/`; expect PASS. `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(replay): let adjudication take candidates and report spend`.

### Task 2: `--adjudicate-results` driver and command

**Files:**
- Create: `src/replay/adjudication/from-results.ts`, `src/replay/adjudication/from-results.test.ts`
- Modify: `src/replay/command.ts` (flag parsing, usage text, misuse checks, dispatch), `docs/review-experiments/protocol.md` (Commands list), the `ai-review replay` bullet in `CLAUDE.md` (one sentence)
- Test: `src/replay/command.test.ts`

**Interfaces:**
- Consumes: Task 1's `candidates`, `onSpend`, `quiet`, `AdjudicationCandidate`; `loadPlan`, `assertCommittedPlan`, `planHash` from `src/replay/experiment/plan.ts`; `ResultsStore` and `defaultExperimentsDir` from `src/replay/experiment/store.ts`; `joinsClaim` and `labelledClaims` from `src/replay/claims.ts`; `splitOf`/`Split` from `splits.ts`; `runAdjudication`, `DEFAULT_MAX_ANTHROPIC`, `DEFAULT_MAX_OPENAI`.
- Produces: `postedCandidates(cells: StoredCell[], fixture: ReplayFixture, labels: LabelFile): AdjudicationCandidate[]` — distinct (path, line, title) over non-stale cells' `result.posted`, minus those `joinsClaim` joins to a labelled claim; `roundIndex` is the cell's `key.round`; the first round a finding appeared in is kept.
- Produces: `runResultsAdjudication(args: { planFile: string; root: string; fixturesDir: string; caps: { anthropic: number; openai: number }; plan: boolean; client: GhClient; out: (s: string) => void; cacheDir?: string; judges: AdjudicationRun["judges"] }): Promise<number>` — refuses a draft plan or a missing/mismatched lock (exit 1, message as in `runExperiment`); reads the store for the plan hash; for each plan fixture with at least one candidate calls `runAdjudication` with the remaining caps (`caps` minus spend reported by earlier fixtures), `quiet` set for `splitOf(...) === "test"` fixtures; prints one header line per fixture and a final line `total judge calls: anthropic=A openai=O, unjudged (deferred by cap): N`; with `plan: true` prints per-fixture plan lines and a total, builds no judge. Exit 0 on success, 1 on a refused plan or an unavailable judge.
- Produces: CLI `replay --adjudicate-results [--plan-file <path>] [--max-anthropic <n>] [--max-openai <n>] [--plan]`, default plan file as for `--experiment`; combining it with any other mode flag, with `--audit`, or with `--adjudicate` exits 2; `--plan-file` requires `--experiment` or `--adjudicate-results`.

- [ ] **Step 1:** Write failing tests in `from-results.test.ts`: `postedCandidates drops findings that join a labelled claim`, `postedCandidates counts a finding once across rounds and strategies`, `postedCandidates ignores stale cells`, `runResultsAdjudication refuses a draft plan`, `runResultsAdjudication refuses a plan without a matching lock`, `runResultsAdjudication shares the caps across fixtures` (fake judge, cap 1, two fixtures with one candidate each: second reports deferred), `runResultsAdjudication --plan builds no judge`, `runResultsAdjudication prints no verdict counts for a test-split fixture`. In `command.test.ts`: `--adjudicate-results with --audit exits 2`, `--adjudicate-results dispatches with default caps`.
- [ ] **Step 2:** Run both files; expect FAIL.
- [ ] **Step 3:** Implement `from-results.ts` and the command wiring; document the command in protocol.md's Commands list (what it reads, the caps are totals, the test-split rule) and one sentence in CLAUDE.md.
- [ ] **Step 4:** `pnpm typecheck && pnpm lint && pnpm test`; PASS. Smoke: with a temp results dir and `--plan`, `bun src/cli.ts replay --adjudicate-results --plan --plan-file <draft plan>` exits 1 with the draft message and calls no model.
- [ ] **Step 5:** Commit `feat(replay): adjudicate the findings a strategy posted`.
