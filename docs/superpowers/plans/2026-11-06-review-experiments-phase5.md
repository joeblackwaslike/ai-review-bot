# Review experiments harness, phase 5 plan

Spec: `docs/superpowers/specs/2026-11-05-review-experiments-harness-design.md` (sections 1, 7, 8, 9
and the "Rules the builder needs" list: A0 spend matching, posting path, per-round mode, the test
set opens once, OpenAI quota, unresolved items, too few fixtures)

Goal: strategy A0, then the experiment layer (plan file, splits, paired runner, results store,
scoring with bootstrap) in per-round mode. No model call happens in this phase. The first scored
grid is phase 6, after fixtures are recorded and Joe's `claude` login is live.

Two PRs, stacked in order, because the whole phase is well past the 400-line review gate:

- **5a** (Tasks 1 to 3): cache-aware cost, the common posting path in the harness, strategy A0.
- **5b** (Tasks 4 to 8): plan file, splits, results store, runner, scoring, CLI, protocol doc.

## Global Constraints

- TypeScript ESM, `.js` import suffixes, named exports only, Biome, Vitest colocated tests.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green before each PR.
- Every test uses a stub strategy, stub model or recorded data. No test, and no step of this plan,
  calls a model API or the network. The first real run is phase 6.
- CLI-only: nothing here is imported from webhook paths; auth goes through `src/auth.ts`.
- OpenAI is rationed. The plan carries a hard `maxOpenAiUsd` separate from `maxAnthropicUsd`, the
  runner refuses to start a cell that would pass either, and OpenAI strategy cells run only on
  the test split. Anthropic is primary everywhere else.
- Judge spend is its own line, outside strategy cost.
- Scoring never mutates raw results. Raw results are append-only.
- Unresolved, unadjudicated and `single-family` counts are printed next to every precision and
  recall figure. Unresolved items leave numerator and denominator.
- Below 30 PRs (10 per split, 5 repositories) every report is labeled directional and makes no go
  or no-go claim.
- Per-round mode only. Chained mode (recycling, convergence) is phase 6; reports say so.

## Task 1 (5a): Cache-aware cost

Files: modify `src/models.ts`, `src/models.test.ts`; create `src/replay/cost.ts`, `cost.test.ts`.

Interfaces:
- `TOKEN_RATES` gains `cachedInput` per model (Anthropic cache reads 0.1x input, OpenAI cached
  input at the published ratio; cite the page in the comment like the existing rates).
- `computeCost(usage: { promptTokens; completionTokens; cachedInputTokens? }, model)`: uncached
  input = `promptTokens - cachedInputTokens` at `input`, cached at `cachedInput`. A call without
  `cachedInputTokens` prices exactly as today, so every existing caller is unchanged.
- `roundCostUsd(usage: RoundUsage, model: string): number` in `cost.ts`: sums `computeCost` over
  skills. `usageSummary(usage)`: totals of prompt, cached, completion, reasoning.

Steps: red tests first (cached tokens price lower; absent field unchanged; cached greater than
prompt clamps to prompt; unknown model 0). Then implement. Note in the comment that cache writes
are not recorded, so cost undercounts the write premium on cold runs.

## Task 2 (5a): Common posting path in the harness

Files: modify `src/replay/strategy.ts`, `strategies/a.ts`, `strategies/a.test.ts`; create
`src/replay/run-strategy.ts`, `run-strategy.test.ts`.

Interfaces:
- `StrategyResult` gains `agentReviews: { skill: string; review: ModelReview }[]` (candidates
  grouped by producing agent; a single-agent strategy is one group). `posted` stays on the type
  but the harness owns it.
- `runStrategy(strategy, input): Promise<StrategyResult>`: calls `strategy.run`, then recomputes
  `posted` and `candidates` from `agentReviews` through `postFilterTrace` with `input.history.ledger`,
  `input.files` and `REVIEWER_TUNING`, so ledger suppression applies to every strategy and
  `posted` means the same thing for all. A strategy that returns its own `posted` is overridden;
  a result with empty `agentReviews` posts nothing.
- `live.ts` and `seeds/run.ts` call `runStrategy`, not `strategy.run`.
- Strategy `a` stops calling `postFilterTrace` itself.

Steps: red test that a stub strategy returning a bogus `posted` gets the filtered one, that a
settled ledger entry is suppressed for a stub strategy, and that strategy `a` on a saved trace
still yields the same candidates and posted set as before (the phase 1 snapshot test must not
change). Then implement.

## Task 3 (5a): Strategy A0

Files: create `skills/a0-single-reviewer.md`, `src/replay/strategies/a0.ts`, `a0.test.ts`,
`a0-repeats.ts`, `a0-repeats.test.ts`; modify `strategies/index.ts`.

Interfaces:
- `skills/a0-single-reviewer.md`: one neutral reviewer prompt. No persona split, no information
  A's agents do not get; it asks for the same `ModelReview` output and covers correctness,
  failure handling, tests and security in one pass. It is not in `TIER1_SKILLS`.
- `repeatsForBudget(args: { targetUsd: number; perRunUsd: number; tolerance: number; max: number
  }): number`: the integer `n >= 1` whose `n * perRunUsd` is closest to `targetUsd`, capped at
  `max`; the result reports whether it landed inside `tolerance` (default 0.10).
- Strategy `a0`: `needsCheckout: false`; `version` = hash of the a0 skill text and the tier maps.
  Its `run` gets A's cost for the same round from `input.budget.maxUsd`, which the grid runner
  sets from A's recorded result in the same run (recorded traces from older runs are never used).
  It measures its own first run's cost with `roundCostUsd`, then chooses `n` and runs the rest
  through `runAgent` with `mapWithConcurrency` at `AGENT_CONCURRENCY`. Each repeat is one entry
  in `agentReviews` with skill name `a0-run-<k>`. Wall time is measured at that concurrency.
  The result reports achieved spend and whether it was within tolerance.
- The router model is the one A uses for the round (`routeModel(routerContext(files), provider)`).
- Registered in `strategies/index.ts`. `estimateCost` = one run times the target repeat count.

Steps: red tests with a stubbed `runAgent`: n chosen from a target (3 runs when the target is 3x
one run; at least 1 when the target is below one run; capped at max), tolerance flag false when
spend lands outside 10%, every repeat appears as its own agent group, merged output equals
`mergeReviewsDetailed` over the groups, `version` changes when the skill text changes. Then
implement. The a0 skill text is reviewed for the "no persona split, nothing extra" rule by
reading it against `skills/code-reviewer.md` and the other four Tier 1 files.

## Task 4 (5b): Plan file, hash, splits

Files: create `src/replay/experiment/plan.ts`, `plan.test.ts`, `splits.ts`, `splits.test.ts`.

Interfaces:
- `ExperimentPlan` (zod, one source of truth): `{ planVersion; mode: "per-round"; strategies:
  { name; version }[]; models: Record<string,string>; providers: ("anthropic"|"openai")[];
  budgets: { maxAnthropicUsd; maxOpenAiUsd; perCellUsd; perCellWallMs }; trials: number;
  seed: string; fixtures: { id; split: "tuning"|"validation"|"test"; provider }[]; metrics:
  string[]; thresholds: { precisionBootstrap: { level: number; resamples: number };
  maxRecallDropPoints: number; hostedFitShare: number; hostedFitSeconds: number };
  a0Tolerance: number; selectionRule: string }`.
- `planHash(plan): string`: sha256 over canonical JSON of the whole plan, first 16 hex.
- `loadPlan(path)`, `assertCommittedPlan(plan, committedHash)`: the runner refuses to score
  against a plan whose hash differs from the one in `plan.json`'s sibling `plan.lock` (a file
  holding the hash, committed before the first scored run).
- `splitOf(fixtureId: string, seed: string): "tuning"|"validation"|"test"`: deterministic from
  sha256 of `seed + owner/repo#pull`, thirds by hash value. Same input, same split, any order.
- `splitCounts(plan)` and `isDirectional(plan)`: true below 30 PRs, 10 per split or 5 repos.

Steps: red tests for hash stability and sensitivity (change a threshold: new hash), split
determinism and rough balance over 300 fake ids, `isDirectional` boundaries, schema rejects an
OpenAI cell on a non-test split. Then implement.

## Task 5 (5b): Results store

Files: create `src/replay/experiment/store.ts`, `store.test.ts`.

Interfaces:
- `CellKey = { strategy; version; fixtureId; round; trial }`. `CellRecord` holds the key, the
  full `StrategyResult` fields (candidates, posted, findings, usage, toolCalls, wallMs, a0 spend
  fields), cost in USD, `fitIn210s`, `failedAttempts`, `cacheTemperature: "cold"|"warm"|"unknown"`,
  provider, version metadata, the plan hash and a timestamp.
- Directory `~/.ai-review/experiments/<plan-hash>/results.jsonl` (`AI_REVIEW_EXPERIMENTS_DIR`
  overrides; a blank value falls back). `append(record)` writes one whole line in one call;
  `readAll()` skips unreadable lines and counts them; nothing is ever rewritten or deleted.
- `hasCell(key)`: a cell present is not re-run, so an interrupted grid resumes.
- A record whose strategy version differs from the registered one is flagged stale on read.

Steps: red tests for append and read, resume skipping, two concurrent appends both survive,
corrupt line skipped and counted, stale flag. Then implement.

## Task 6 (5b): Runner

Files: create `src/replay/experiment/runner.ts`, `runner.test.ts`.

Interfaces:
- `planGrid(plan)` returns the cells in randomized order from `plan.seed` (seeded shuffle, same
  seed same order) and an estimate in USD per provider from each strategy's `estimateCost`.
- `runGrid(plan, deps: { registry; fixtures; runStrategy; store; now })` runs cells paired
  (every strategy on every fixture round, `trials` times). A runs before A0 for the same round
  so A0's target exists; the order shuffle is across rounds, not within a round. Before each
  cell it checks the Anthropic and OpenAI running totals plus the cell's estimate against the
  caps and stops, writing the list of missing cells; the report says "partial". An OpenAI cell on
  a non-test split is refused. Checkout-needing strategies on a round without a checkout are
  listed as unavailable, not failed.
- Builds `FrozenFixture` per round with `freezeFixture` and passes `ledgerForRound` as history.
- `--plan` mode prints count, estimate per provider and caps and runs nothing.

Steps: red tests with stub strategies and a stub store: order is deterministic from the seed;
A precedes A0 in a round; a cap stops the grid and lists missing cells; OpenAI refused off the
test split; resume skips stored cells; unavailable checkouts are listed. Then implement.

## Task 7 (5b): Scoring, bootstrap, reports

Files: create `src/replay/experiment/score.ts`, `score.test.ts`, `bootstrap.ts`,
`bootstrap.test.ts`, `report.ts`, `report.test.ts`, `final-guard.ts`, `final-guard.test.ts`.

Interfaces:
- Per PR, per strategy, per provider: precision (real posted over posted, using labels, then
  `joinsClaim`, then cached adjudication verdicts read through `VerdictCache` with `claimKey`),
  recall (found over labelled real plus `auditAdded`; seeds use `scoreSeed`), wrong or
  irrelevant findings with a separate "moved or reformatted" count, cost from `roundCostUsd`,
  median latency, share inside 210 seconds, join rate `{joined, candidates}` with the matcher
  version. Unresolved, unadjudicated and `single-family` counts travel with every figure.
- `pairedBootstrap(perPr: {a:number; b:number}[], opts: { level; resamples; seed })` resamples
  PRs, never claims, and returns the difference estimate and interval. Seeded, so the same
  input gives the same interval.
- `verdictFor(strategyPair, metrics, thresholds)` applies section 9: precision interval excludes
  zero and recall point estimate drops no more than 5 points, cost-competitive rule, 90% inside
  210 seconds, seeds gate. A result confirmed only on Anthropic reads "Anthropic-only,
  unconfirmed on OpenAI" with no go or no-go claim. Directional plans print no verdict.
- `final-guard.ts`: `experiment score --final` writes a marker file next to the results; a
  second final score for the same plan hash is refused. Non-final scoring never reads test-split
  cells. A scored test set cannot be reused: a revised plan hash that shares test fixtures with a
  scored plan is labeled exploratory.
- `report.ts` renders a Markdown report: per provider, per split, the counts above, the
  incomplete-review rate, the intersection size for tool-using versus diff-only comparisons,
  "per-round mode only", and the directional or exploratory label.

Steps: red tests with hand-built cell records: a known precision and recall; unresolved items
leave both sides; paired bootstrap on a toy set is reproducible and its interval contains the
true difference; the second `--final` is refused; test cells hidden from non-final scoring;
directional label below the minimum. Then implement.

## Task 8 (5b): CLI, protocol, docs

Files: modify `src/cli.ts` and `src/replay/command.ts` (or the file that parses replay flags),
their tests; create `docs/review-experiments/protocol.md`, `plan.json`, `plan.lock`; modify
`CLAUDE.md` replay paragraph and the bead.

Interfaces:
- `ai-review replay --experiment plan` prints the grid estimate; `--experiment run` runs it under
  the caps; `--experiment score [--final]` writes the report. Combined with other mode flags
  exits 2; a plan whose hash differs from `plan.lock` exits 1; a missing plan exits 1.
- `protocol.md` carries the spec's metrics, thresholds, split rule, the pre-registered selection
  rule for fixtures (language and operation spread, no peeking at outcomes), the A0 tolerance
  and the statement that nothing is scored until `plan.lock` is committed.
- `plan.json` is a real draft with the current fixture list and placeholders for fixtures to be
  recorded; it is marked `draft` and `plan.lock` is not created in this phase, so no scoring is
  possible yet. Phase 6 records fixtures, finalizes the plan and commits the lock.

Steps: red CLI tests (exit codes, no-model paths). Then implement. Run the full suite, build,
and `node dist/cli.js replay --experiment plan` against the draft as a smoke check.

## Out of scope

Chained mode, fixture recording, the first scored grid, the verifier, F and tool strategies.
Phase 6 does recording, finalizes and locks the plan, then runs the first grid.
