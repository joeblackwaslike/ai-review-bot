# Review Experiments Phase 1: Strategy Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put today's review pipeline behind a named `ReviewStrategy` interface in `ai-review replay --live`, with extended usage fields, and no change in behaviour.

**Architecture:** `runLiveTier` stops taking a `review` callback and takes a `ReviewStrategy`. Diff fetching stays in the harness (`fetchDiff`). Strategy `a` is today's `buildLiveWiring` review/estimate logic moved into `src/replay/strategies/a.ts`. A registry maps names to strategies and `--strategy <name>` selects one. `RoundUsage` gains optional cache and reasoning fields that `runAgent` fills when the provider reports them.

**Tech Stack:** TypeScript ESM, Vitest, Biome, Vercel AI SDK (`ai`).

**Spec:** [docs/superpowers/specs/2026-11-05-review-experiments-harness-design.md](../specs/2026-11-05-review-experiments-harness-design.md) (section 1, phase 1 of Phasing). Phases 2 to 6 get their own plans.

## Global Constraints

- TypeScript ESM, imports use `.js` extensions, named exports only, no default exports.
- Tests colocated as `src/**/*.test.ts`, Vitest; Biome for lint and format.
- CLI-only code: nothing here is imported from webhook paths (`api/`, `src/github-app.ts`).
- Behaviour with no `--strategy` flag is unchanged: default strategy is `a`.
- `schemaVersion` of fixtures stays 1; new `RoundUsage` fields are optional and additive.
- Every live run stays cost-capped; a strategy whose `estimateCost` is NaN, infinite or negative makes `runLiveTier` throw `InvalidEstimateError`.
- Gates before each commit: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- Work in the worktree `.worktrees/experiments-spec`, branch `docs/review-experiments-spec`.

## Review Focus

- `--strategy` given an unknown name: exits 2 with the known names listed, spends nothing.
- `--strategy` without `--live`: exits 2, as `--save-trace` does.
- A strategy that throws mid-grid: the error names the strategy and round; spend already counted is kept.
- Old fixtures with traces whose usage entries lack the new fields still load and compare.
- `estimateCost` for `a` called before `fetchDiff` ran for that round still throws the existing "fetchDiff must run first" error.

---

### Task 1: Strategy types and registry

**Files:**
- Create: `src/replay/strategy.ts`
- Test: `src/replay/strategy.test.ts`

**Interfaces:**
- Consumes: `Round`, `ReplayFixture`, `CandidateRecord`, `RoundUsage` from `./types.js`; `LiveFinding` from `./live.js`; `PullFile` from `../review.js`; `Ledger` from `../ledger/index.js` (use the same import `src/replay/trace.ts` uses).
- Produces (exact):

```ts
export interface CheckoutHandle { path: string; baseSha: string; headSha: string }
export interface FrozenHistory { ledger: Ledger }
export interface ToolCallRecord { name: string; wallMs: number; costUsd: number }
export interface StrategyInput {
  fixture: ReplayFixture; round: Round; labels: LabelFile;
  diff: string; files: PullFile[]; approximateDiff: boolean;
  checkout: CheckoutHandle | null; history: FrozenHistory;
  budget: { maxUsd: number; maxWallMs: number }; signal: AbortSignal;
}
export interface StrategyResult {
  findings: LiveFinding[]; candidates: CandidateRecord[]; posted: CandidateRecord[];
  usage: RoundUsage; toolCalls: ToolCallRecord[]; wallMs: number;
}
export interface ReviewStrategy {
  name: string; version: string; needsCheckout: boolean;
  estimateCost(input: StrategyInput): number;
  run(input: StrategyInput): Promise<StrategyResult>;
}
export function registerStrategy(s: ReviewStrategy): void;
export function getStrategy(name: string): ReviewStrategy;   // throws UnknownStrategyError
export function strategyNames(): string[];                   // sorted
export class UnknownStrategyError extends Error {}
```

- [ ] **Step 1: Write failing tests** in `strategy.test.ts`: `getStrategy("nope")` throws `UnknownStrategyError` whose message contains every registered name; registering the same name twice throws; `strategyNames()` returns sorted names; a registered stub is returned by `getStrategy`. Use a local registry reset helper exported as `resetStrategiesForTest()`.
- [ ] **Step 2: Run** `pnpm vitest run src/replay/strategy.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `strategy.ts` as above, registry is a module-level `Map`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): ReviewStrategy interface and registry`.

### Task 2: Extended usage fields

**Files:**
- Modify: `src/replay/types.ts` (the `RoundUsage` entry type, lines ~34-37), `src/audit.ts` (`PassUsage`, `addUsage`, lines ~78-120), `src/review.ts` (`runAgent` return around lines 580-586 and the `TokenUsage` type it returns), `src/replay/live-wiring.ts` (`toLiveReviewOutput`).
- Test: `src/audit.test.ts` (or the file that already tests `runAuditPass` usage), `src/replay/live-wiring.test.ts`.

**Interfaces:**
- Produces: `RoundUsage[skill]` and `PassUsage` gain optional `cachedInputTokens?: number` and `reasoningTokens?: number`. `uncachedInput` is derived, not stored: `promptTokens - cachedInputTokens`.

- [ ] **Step 1: Check the installed `ai` package's usage type** (`node_modules/ai` type definitions) for the exact names of the cached-input and reasoning fields, and for whether Anthropic's cache-read count is in `usage` or only in `providerMetadata.anthropic.cacheReadInputTokens` (it is read from there at `review.ts:570`). Use the field that is populated for each provider; record the choice in a one-line comment.
- [ ] **Step 2: Write failing tests**: (a) `runAuditPass` with a mocked agent returning `usage` with cached and reasoning counts sums them into `usageBySkill` and `usage`; (b) `toLiveReviewOutput` keeps the optional fields; (c) a usage entry without the fields still sums to the same prompt and completion totals as before.
- [ ] **Step 3: Run** the two test files. Expected: FAIL.
- [ ] **Step 4: Implement** the optional fields through `runAgent` (fill when the provider reports, leave undefined otherwise), `PassUsage` accumulation (sum only when defined), and `toLiveReviewOutput`. Hosted path behaviour must not change: nothing outside usage objects is touched.
- [ ] **Step 5: Run** `pnpm test`. Expected: PASS, no snapshot changes in existing fixtures.
- [ ] **Step 6: Commit** `feat(replay): carry cached-input and reasoning tokens in usage`.

### Task 3: Strategy `a`

**Files:**
- Create: `src/replay/strategies/a.ts`, `src/replay/strategies/index.ts`
- Modify: `src/replay/live-wiring.ts` (keep `fetchDiff`, `toLiveFindings`, `toCandidates`, `toLiveReviewOutput`; move review and estimate logic out)
- Test: `src/replay/strategies/a.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `runAuditPass`, `resolveAnthropicAuth`, `resolveOpenAIAuth`, `routeModel`, `computeCost`, `postFilterTrace`, `ledgerForRound`, `REVIEWER_TUNING` exactly as `live-wiring.ts` uses them today.
- Produces: `export const strategyA: ReviewStrategy` with `name: "a"`, `version` derived from a hash of the sorted Tier 1 skill file names plus the router tier maps, `needsCheckout: false`. `index.ts` exports `registerBuiltinStrategies(): void` that registers `a` (idempotent). The model selection that `buildLiveWiring` kept in a per-round map is now computed inside the strategy from `input.files` via the existing `routerContext`; export `routerContext` from `live-wiring.ts` for this.

- [ ] **Step 1: Write failing tests** with `runAuditPass` mocked (`vi.mock("../../audit.js")`) to return a canned `agentReviews`: `strategyA.run` returns `candidates` equal to what `toCandidates` gives for them, `posted` equal to `postFilterTrace`'s `posted`, `toolCalls` empty, `wallMs >= 0`; it throws `all N review agents failed` when `agentsSucceeded === 0` and `agentsAttempted > 0`; `estimateCost` returns the same dollars as the old formula (`diff.length / 4 * 5` prompt tokens, `2000 * 5` completion, via `computeCost`) for a fixed diff and selection.
- [ ] **Step 2: Add the equivalence test** `a reproduces a saved trace`: load `src/replay/fixtures/joeblackwaslike__ai-listings__50__anthropic.json`, take round 1's saved `trace.candidates`, build the mocked `agentReviews` from them grouped by `skill`, run `strategyA.run`, assert the returned `candidates` deep-equal the saved ones.
- [ ] **Step 3: Run** `pnpm vitest run src/replay/strategies/a.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `strategyA` by moving the bodies of `review` and `estimateCost` from `buildLiveWiring`. `run` measures `wallMs` with `Date.now()`; `toolCalls: []`.
- [ ] **Step 5: Run** the test file. Expected: PASS.
- [ ] **Step 6: Commit** `feat(replay): move the current pipeline behind strategy a`.

### Task 4: `runLiveTier` takes a strategy

**Files:**
- Modify: `src/replay/live.ts` (`LiveOptions`, `runLiveTier`, `LiveRoundReport`), `src/replay/live-wiring.ts` (`buildLiveWiring` shrinks to fetch plus compare-files cache and returns `{ fetchDiff, compareFiles }`), `src/replay/command.ts` (`liveAll`, `ReplayDeps.liveWiring`), their tests (`live.test.ts`, `live-wiring.test.ts`, `command.test.ts`).
- Test: `src/replay/live.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 3.
- Produces:

```ts
export interface LiveOptions {
  fixture: ReplayFixture; labels: LabelFile; rounds: number[]; maxCostUsd: number;
  strategy: ReviewStrategy;
  fetchDiff: (round: Round) => Promise<{ diff: string; files: PullFile[]; approximate: boolean }>;
  out?: (s: string) => void;
}
```

`LiveRoundReport` gains `wallMs: number` and `toolCalls: number`. `runLiveTier` builds the `StrategyInput` (`checkout: null`, `history: { ledger: ledgerForRound(fixture, labels, round) }`, `budget: { maxUsd: remaining cap, maxWallMs: 210_000 }`, a fresh `AbortController` signal), calls `strategy.estimateCost` for the cap check and `strategy.run` for the review. An error from `run` is rethrown as `Error("<strategy.name> round <i>: <message>")` with the original as `cause`.

- [ ] **Step 1: Migrate the tests first** so they fail for the right reason: replace the `review`/`estimateCost` stubs in `live.test.ts` with a stub `ReviewStrategy`; add tests that the stub receives `checkout: null`, a ledger in `history`, and `budget.maxWallMs === 210000`; that a throwing `run` produces the prefixed error; that `wallMs` and `toolCalls` land in the report row.
- [ ] **Step 2: Run** `pnpm vitest run src/replay`. Expected: FAIL (type and behaviour).
- [ ] **Step 3: Implement** the changes above. In `command.ts` `liveAll` passes `strategy` through; `ReplayDeps.liveWiring` keeps its injection role for `fetchDiff`.
- [ ] **Step 4: Run** `pnpm vitest run src/replay`. Expected: PASS with all pre-existing replay tests still green.
- [ ] **Step 5: Commit** `refactor(replay): runLiveTier runs a ReviewStrategy`.

### Task 5: `--strategy` flag, docs

**Files:**
- Modify: `src/replay/command.ts` (usage text near line 57, `parseArgs`, `ParsedArgs`, validation near line 422), `CLAUDE.md` (the `ai-review replay` paragraph), `docs/review-ontology/process-design.md` (section 6 note that the interface exists).
- Test: `src/replay/command.test.ts`

**Interfaces:**
- Produces: `ai-review replay --live --strategy <name>`; `parseArgs` accepts `--strategy <name>`; `ParsedArgs.strategy?: string`. `runReplay` calls `registerBuiltinStrategies()` once before `liveAll`.

- [ ] **Step 1: Write failing tests**: `--live --strategy a` runs and passes `strategy.name === "a"` to the tier; `--live` alone defaults to `a`; `--live --strategy nope` returns 2, prints the known names, and never calls the wiring; `--strategy a` without `--live` returns 2; usage text lists `--strategy`.
- [ ] **Step 2: Run** `pnpm vitest run src/replay/command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** parsing, validation, resolution via `getStrategy`, and the usage line. In `CLAUDE.md` add one sentence to the replay description: strategies run through `ReviewStrategy` (`src/replay/strategy.ts`), `a` is the default, `--strategy <name>` selects another.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm test`. Expected: all green.
- [ ] **Step 5: Smoke the offline default mode**: run `ai-review replay` from this worktree's build (the repo's CLI entry, `src/cli.ts`) with no flags. Expected: exit 0 on the committed fixtures, no OpenAI or Anthropic calls.
- [ ] **Step 6: Commit** `feat(replay): select a review strategy with --strategy`.

---

## Self-review notes

- Spec coverage for phase 1: interface (Task 1), `a` behind it with an equivalence test (Task 3), extended usage (Task 2), selection flag (Task 5). `checkout` and `history` exist in the input type but are `null` and ledger-only until phase 2, which replaces them with the real checkout manager and timestamp-frozen history.
- `StrategyResult.toolCalls` is recorded but empty for `a`; no tool code is built here.
