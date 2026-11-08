# Review Experiments Phase 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three scorer gaps, add chained mode (recycling and convergence), then lock the plan and run the first scored grid on the enlarged fixture set.

**Architecture:** Everything lives under `src/replay/experiment/` plus small hooks in `src/replay/seeds/run.ts`, `src/replay/trace.ts` and `src/replay/command.ts`. Chained mode is a second runner path (`chained.ts`) selected by `plan.mode`; per-round code is untouched. Scoring reads stored cells and the adjudication cache and never calls a model.

**Tech Stack:** TypeScript ESM (imports use `.js`), Vitest colocated tests, zod, Biome. Run with `bun src/cli.ts replay ...`.

**Spec:** docs/superpowers/specs/2026-11-05-review-experiments-harness-design.md (section "Addendum: phase 6", plus sections 7, 8, 9 and "Rules the builder needs, settled").

## Global Constraints

- Named exports only; no default exports; no section-banner comments; comments only where unavoidable.
- A plan with `"draft": true` or without a committed `plan.lock` cannot `run` or `score`. Any plan change makes a new hash.
- OpenAI quota is rationed: no task below calls a model. Tasks 1-6 spend nothing.
- Per-round and chained results are never mixed in one plan hash or one metric.
- Unadjudicated labels, `unclear`/`unresolved` verdicts and missing verdicts leave numerator and denominator; their counts print next to every figure.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green at the end of every task.

## Review Focus

- A PR whose strategy posted nothing in every round: precision null, recycling null, convergence 0, no division by zero.
- A PR with a single round: chained recycling is null (no later round), convergence counts that round.
- A chain whose round k cannot run: rounds after k are listed missing and the chain counts as incomplete, not as converged.
- Audit cache holding `single-family` and `unresolved` entries, and entries for another labels hash: only matching, non-unresolved ones join the recall denominator.
- `seed-gates.json` already holding another strategy's gate: writing one strategy must keep the others.

---

### Task 1: Write seed gates from `--seeds`

**Files:**
- Modify: `src/replay/experiment/seed-gates.ts`, `src/replay/seeds/run.ts` (`runSeedsWithStrategy`, `SeedStrategyOptions`), `src/replay/command.ts` (flag parsing, usage text), `docs/review-experiments/protocol.md` ("Known gaps")
- Test: `src/replay/experiment/seed-gates.test.ts`, `src/replay/seeds/run.test.ts`, `src/replay/command.test.ts`

**Interfaces:**
- Produces: `writeSeedGate(root: string, planHash: string, strategy: string, gate: SeedGate): void` — read-merge-write of `<root>/<planHash>/seed-gates.json`, creating the directory, atomic via temp file + rename, keeping other strategies' entries.
- Produces: `SeedStrategyOptions.onGate?: (gate: SeedGate) => void`, called once after `seedGate(results)` and not when a seed run threw before the gate.
- Produces: flag `--gate-plan <hash>` on `replay --seeds --strategy <name>`; the command writes the gate via `writeSeedGate(defaultExperimentsDir(), hash, strategy.name, gate)`. A run stopped by the cost cap writes nothing. `--gate-plan` without `--seeds --strategy` exits 2.
- Consumes: `SeedGate` from `src/replay/seeds/score.ts`, `defaultExperimentsDir` from `store.ts`.

- [ ] **Step 1:** Write failing tests: `writeSeedGate keeps other strategies' gates` (write `a` then `a0`, read both back with `readSeedGates`), `writeSeedGate creates the plan-hash directory`, `runSeedsWithStrategy calls onGate once with the gate`, `runSeedsWithStrategy does not call onGate when the cost cap stops the run`, `--gate-plan without --strategy exits 2`.
- [ ] **Step 2:** Run `pnpm vitest run src/replay/experiment/seed-gates.test.ts src/replay/seeds/run.test.ts src/replay/command.test.ts`; expect the new tests FAIL.
- [ ] **Step 3:** Implement the interfaces above; update `readSeedGates`' doc comment and the "Known gaps" bullet and the `--seeds` bullet in protocol.md to say the flag exists.
- [ ] **Step 4:** Re-run; expect PASS. Run `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(replay): write seed gates from replay --seeds`.

### Task 2: Audit-added defects reach the scorer

**Files:**
- Modify: `src/replay/experiment/command.ts` (`realExperimentDeps.loadFixtures`), `src/replay/adjudication/audit.ts` or a new `src/replay/adjudication/audit-defects.ts` (reader), `docs/review-experiments/protocol.md`
- Test: `src/replay/adjudication/audit-defects.test.ts`, `src/replay/experiment/score.test.ts`

**Interfaces:**
- Produces: `auditDefectsFor(cache: VerdictCache<AuditStored>, snapshot: string, labelsHash: string): { path: string; line: number; title: string }[]` — every cached `kind: "audit"` record whose key carries `labelsHash`, with non-null `path` and `line`, status `agreed` or `single-family`. Records of kind `audit-run` and records for other labels hashes are ignored.
- Consumes: `ScoredFixture.extraDefects` (already read by `scorePr`), the existing labels-hash helper used by the audit (find it in `adjudication/`; reuse, do not re-derive), `snapshotId`.
- `loadFixtures` fills `extraDefects` from the adjudication cache for each fixture.

- [ ] **Step 1:** Failing tests: `auditDefectsFor returns agreed and single-family audit records for the labels hash`, `auditDefectsFor ignores audit-run records and other labels hashes`, `auditDefectsFor skips records without a path or line`, and in `score.test.ts` `recall counts an audit-added defect in the denominator` (a fixture with 1 fixed claim and 1 extra defect, posted joins only the claim, recall 0.5).
- [ ] **Step 2:** Run the two test files; expect FAIL on the new reader (score test may already pass; keep it as the pin).
- [ ] **Step 3:** Implement `auditDefectsFor`; wire into `loadFixtures`; remove the first "Known gaps" bullet in protocol.md.
- [ ] **Step 4:** Re-run; PASS. `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(replay): feed audit-added defects into experiment recall`.

### Task 3: Join rate in the scorer

**Files:**
- Modify: `src/replay/experiment/score.ts` (`PrScore`, `scorePr`, `Summary`, `aggregate`), `src/replay/experiment/report.ts`, `docs/review-experiments/protocol.md`
- Test: `src/replay/experiment/score.test.ts`, `src/replay/experiment/report.test.ts`

**Interfaces:**
- Produces: `PrScore.joinRate: { joined: number; candidates: number; matcher: string }` — distinct candidates (by path, line, title) across the strategy's stored cells that `joinsClaim` joins to any labelled claim; `matcher` is the string `"isSameClaim@JOIN_CLAIM_MATCH+JOIN_BODY_MATCH"`.
- Produces: `Summary.joinRate: { joined: number; candidates: number; matcher: string }` summed over PRs; the report prints `join rate J/N (matcher …)` on the strategy line.
- Consumes: `joinsClaim`, `labelledClaims` already imported in `score.ts`.

- [ ] **Step 1:** Failing tests: `scorePr counts a candidate once however many rounds repeat it`, `scorePr joinRate is 0 of 0 when nothing was posted`, `aggregate sums join rates`, `report prints the join rate with the matcher`.
- [ ] **Step 2:** Run `pnpm vitest run src/replay/experiment/score.test.ts src/replay/experiment/report.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement; candidates come from `rec.result.candidates`, not `posted`. Delete the "Join rate is deferred" bullet in protocol.md.
- [ ] **Step 4:** Re-run; PASS. `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(replay): report join rate in experiment scores`.

### Task 4: Chained ledger builder

**Files:**
- Modify: `src/replay/trace.ts`
- Test: `src/replay/trace.test.ts`

**Interfaces:**
- Produces: `ledgerFromPosted(fixture: ReplayFixture, labels: LabelFile, round: Round, ownPosted: { roundIndex: number; posted: CandidateRecord[] }[]): Ledger` — the ledger a review of `round` would see when the reviewer's own earlier output replaces the recorded claims. Each own posted candidate becomes a prior claim of its round; if `joinsClaim` joins it to a recorded claim of the fixture, it inherits that claim's label and replies (the author's behaviour is held fixed), otherwise it is open. The result goes through `ledgerFromView` then `holdable`, exactly like `ledgerForRound`, with labels filtered by `visibleLabels(fixture, labels, roundCutoff(round))`.
- Consumes: `ledgerFromView`, `holdable`, `visibleLabels`, `roundCutoff`, `joinsClaim`, the `PostedClaim` type used by `ledgerFromView` (read it to build claims from `CandidateRecord`; ids must be stable per `(roundIndex, path, line, title)`).

- [ ] **Step 1:** Failing tests: `ledgerFromPosted with no own output is empty`, `ledgerFromPosted settles an own finding that joins a recorded fixed claim`, `ledgerFromPosted keeps an unjoined own finding open`, `ledgerFromPosted ignores own output of rounds at or after the target round`, `ledgerFromPosted equals ledgerForRound when own output re-states the recorded claims`.
- [ ] **Step 2:** Run `pnpm vitest run src/replay/trace.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement beside `ledgerForRound`.
- [ ] **Step 4:** Re-run; PASS. `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(replay): ledger from a strategy's own earlier output`.

### Task 5: Chained runner and plan mode

**Files:**
- Create: `src/replay/experiment/chained.ts`, `src/replay/experiment/chained.test.ts`
- Modify: `src/replay/experiment/plan.ts` (`mode` enum gains `"chained"`), `src/replay/experiment/runner.ts` only to export what `chained.ts` reuses (cost gating, caps, `fetchDiff`/checkout handling)
- Test: `src/replay/experiment/plan.test.ts`

**Interfaces:**
- Produces: `planChains(plan, deps)` returning the cells as `(strategy, fixtureId, trial)` chains with a spend estimate per provider (sum of the chain's rounds), and `runChains(plan, deps, planHash): Promise<GridReport>`.
- A chain runs rounds in index order. Each round's `StrategyInput.history.ledger` is `ledgerFromPosted(fixture, labels, round, ownSoFar)`. Each finished round is appended to the store as a normal `CellRecord` whose `key.round` is the round index (key unchanged). `a` runs before `a0` per chain; `a0`'s `spendTargetUsd` is `a`'s cost for the same round in that chain.
- If a round throws, is over cap, or has no checkout (tool-using strategy), the chain stops; the remaining rounds are reported in `GridReport.missing`. Resuming skips rounds already stored and rebuilds `ownSoFar` from the stored cells.
- A plan with `mode: "chained"` and any fixture lacking at least 2 rounds still plans (single-round chains are allowed).
- Consumes: `runStrategy`, `ResultsStore`, `ledgerFromPosted` (Task 4), the per-provider cap logic of `runGrid`.

- [ ] **Step 1:** Failing tests with fake strategies: `a chain feeds a round's posted findings into the next round's ledger`, `a chain stops at a failing round and lists the later rounds as missing`, `a resumed chain skips stored rounds and rebuilds its history from them`, `a0 targets a's cost for the same round in the chain`, `an exhausted provider cap stops that provider's chains only`, and in `plan.test.ts` `mode chained is accepted and hashes differently from per-round`.
- [ ] **Step 2:** Run `pnpm vitest run src/replay/experiment/chained.test.ts src/replay/experiment/plan.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement `chained.ts` reusing the runner's helpers; keep per-round behaviour byte-identical.
- [ ] **Step 4:** Re-run plus the whole `src/replay/experiment/` suite; PASS. `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(replay): chained experiment runner`.

### Task 6: Recycling and convergence scoring

**Files:**
- Create: `src/replay/experiment/chain-score.ts`, `src/replay/experiment/chain-score.test.ts`
- Modify: `src/replay/experiment/report.ts`, `src/replay/experiment/score.ts` (`scoreExperiment` branches on `plan.mode`)
- Test: `src/replay/experiment/report.test.ts`

**Interfaces:**
- Produces: `scoreChain(args: { strategy; fixtureId; records: StoredCell[]; fx: ScoredFixture; plannedRounds: number }): ChainScore` with `recycling: number | null` (posted findings in rounds after the first that `isSameClaim`-restate a finding the strategy itself posted earlier in the chain and the author settled or left open, over all posted findings in rounds after the first; null when none), `convergenceRound: number` (index of the first round posting nothing; `plannedRounds` when never), `complete: boolean` (all planned rounds stored), `recall` as in `scorePr` over the whole chain.
- Produces: macro means over PRs and a paired bootstrap difference for recycling and convergence using `pairedBootstrap`, reported with recall and the incomplete-chain rate. In chained mode `scoreExperiment` does not emit per-round precision, cost or latency; the report header says "chained: recycling and convergence only".
- Consumes: `joinsClaim`/`isSameClaim`, `pairedBootstrap`, `StoredCell`.

- [ ] **Step 1:** Failing tests: `recycling counts a later-round restatement of the strategy's own earlier finding`, `recycling is null when no later round posted anything`, `convergence is the first empty round`, `convergence equals plannedRounds when no round is empty`, `an incomplete chain is flagged and not counted as converged`, `chained report omits precision and cost`.
- [ ] **Step 2:** Run the two files; expect FAIL.
- [ ] **Step 3:** Implement and wire `scoreExperiment`.
- [ ] **Step 4:** Re-run; PASS. `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(replay): score recycling and convergence in chained mode`.

### Task 7: Command wiring and protocol

**Files:**
- Modify: `src/replay/experiment/command.ts` (`plan`/`run` pick `planChains`/`runChains` when `plan.mode === "chained"`; `score` unchanged otherwise), `docs/review-experiments/protocol.md` (Modes section: per-round and chained, results key, "recycling and convergence are measured only in a chained plan"), `CLAUDE.md` (`ai-review replay` bullet: one sentence on `--gate-plan` and chained mode)
- Create: `docs/review-experiments/plan-chained.json` (draft, `mode: "chained"`, same fixtures, strategies and caps as `plan.json`, its own seed string `review-experiments-2026-11-chained`; splits recomputed from that seed)
- Test: `src/replay/experiment/command.test.ts`

**Interfaces:**
- `--plan-file <path>` already selects the plan; a chained plan prints `chains` instead of `cells` in its first line.
- Consumes: `planChains`, `runChains` (Task 5), `scoreExperiment` (Task 6).

- [ ] **Step 1:** Failing tests: `plan on a chained plan prints chains and the estimate`, `run on a chained plan calls runChains`, `score on a chained plan prints recycling and convergence`.
- [ ] **Step 2:** Run `pnpm vitest run src/replay/experiment/command.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement, generate `plan-chained.json` with the same script approach as `plan.json` (splits from `splitOf`, OpenAI fixtures test-split only), update docs.
- [ ] **Step 4:** `gates/verify.sh`; PASS. `bun src/cli.ts replay --experiment plan --plan-file docs/review-experiments/plan-chained.json` prints a chain count and estimate and runs nothing.
- [ ] **Step 5:** Commit `feat(replay): chained mode in the experiment command`.

---

## Operational steps (controller, after Task 7; not subagent work)

1. Show `--experiment plan` for `plan.json`; Joe's caps stand ($150 Anthropic, $20 OpenAI). Remove `draft`, commit `plan.json` and `plan.lock` (hash from `plan`).
2. `adjudicate --plan` per fixture and show the call counts; run Anthropic judges first, OpenAI cross-check under its cap; report `single-family`/`unresolved` counts.
3. `run` (Anthropic, all splits); `score` (tuning and validation only). `replay --seeds --strategy a --gate-plan <hash>` and again for `a0` (seed spend shown with `--plan` first).
4. OpenAI test-split `run` only for strategies that cleared on Anthropic, under its own cap.
5. Chained plan: show `plan` output, get Joe's approval, then lock and run. `score --final` only on Joe's go.
