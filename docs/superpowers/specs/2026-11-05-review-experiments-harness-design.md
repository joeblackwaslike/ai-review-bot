# Review experiments harness and protocol

Bead: ai-review-bot-t0c.46. Parent epic: t0c. Source of the questions:
[docs/review-ontology/process-design.md](../../review-ontology/process-design.md) sections 5, 5a and 6.

## Intent

Joe wants to replace today's pipeline (five Tier 1 persona agents plus conditional Tier 2
agents, merged) with one main reviewer that has runbooks and tools (candidate F). Nobody
knows yet whether that is better, equal or worse. The evidence so far (three PRs of
precision data, a 34% restatement rate) shows overlap, not its cause.

This spec defines the machinery that answers the question: a way to run any review strategy
on the same recorded PRs, score them fairly, and report a go or no-go on F against the
baselines. It does not build F, the verifier or the context pre-pass. Those get their own
specs once the harness can run them.

## Goals

1. Run any named review strategy through `ai-review replay --live` on the same fixture
   snapshots, with identical inputs, budgets and frozen history.
2. Run A (today) and A0 (one diff-only reviewer, spend matched to A, run several times) as
   the first two strategies. A0 is the proof that the interface holds and the baseline every
   later candidate must beat.
3. Give strategies with tools a real checkout of the repository at the round's head commit.
4. Score every run for precision, recall, wrong or irrelevant findings, recycling and
   convergence, cost and latency, in the shape section 6 of the process doc lists.
5. Explain the out-of-sample join rate of 0 of 15 (anthropic) and 0 of 5 (openai) on
   ai-listings#50 before any recall figure is reported.
6. Judge unmatched findings blind, so a correct finding the old bot never made is not
   counted as a false positive.
7. Provide seeded synthetic fixtures with known right answers and clean controls.
8. Fix the metrics, thresholds, splits and analysis before the first scored run, and refuse
   to report a result that skips them.

## Non-goals

- Building F, the verifier, the context pre-pass, the planner (B) or any scanner tool.
  Each gets a spec after this one. The harness only defines the interface they plug into.
- Changing the hosted review path. Nothing here ships to production.
- Replacing `ai-review replay` default mode (offline, deterministic, runs in CI).
- A leaderboard or dashboard. Output is a report file and a table.

## Anti-goals

The harness fails even if it runs when any of these hold.

- It rewards reproducing the old bot. Precision and recall computed only against historical
  labels do this, because the labels come from what the old reviewers said.
- A strategy passes by pattern matching one seeded example, by flagging everything, or by
  saying less and calling it convergence.
- A result is reported from the tuning set, from one provider, or with uncertainty computed
  over claims instead of PRs.
- A strategy sees information from after the round it reviews.
- Two strategies are compared under different models, budgets or prompts without that being
  the variable under test.

## Constraints

- TypeScript ESM, Vitest, Biome, named exports only. The CLI-only rule applies: nothing in
  this work is imported from webhook paths.
- Local subscription auth for runs (as `review`, `audit`, `watch`). The hosted path is
  API-key only and stays untouched.
- Every live run is cost-capped (`--max-cost`), and a strategy that cannot estimate its cost
  refuses to run, as `InvalidEstimateError` does today.
- The hosted function budget is 210 seconds of agent time. Every run records wall time and
  whether it would have fit.
- Fixtures may come from private repositories. Checkouts and results stay on the local disk
  and out of git, except fixtures and reports that are already committed.
- Reuse the existing metric, join, ledger and trace code. One definition of a match.

## Approaches considered

1. **Widen the replay live tier (chosen).** Replace the `review(diff, round)` callback in
   `src/replay/live.ts` with a named `ReviewStrategy`, and add an experiment layer on top.
   Reuses `isSameClaim`, `countJoined`, `postFilterTrace` and the cost accounting. The cost
   is a bigger contract in `live.ts` and migrating its tests.
2. **A separate experiments runner beside replay.** Cleaner isolation but a second copy of
   the match, adjudication and trace logic that would drift from the first.
3. **Strategies as external processes (JSON in, JSON out).** Lets F be anything, but cost
   and cache numbers become self-reported, and those are what the experiments measure.

Joe picked option 1 on 2026-11-05.

## Design

### 1. The strategy interface

```ts
interface StrategyInput {
  round: Round;
  fixture: ReplayFixture;
  diff: string;                 // right-side numbered, as production shows it
  approximateDiff: boolean;
  checkout: CheckoutHandle | null;   // null for strategies that declare needsCheckout: false
  history: FrozenHistory;       // reviews and threads as of this round's time, nothing later
  budget: { maxUsd: number; maxWallMs: number };
  signal: AbortSignal;
}

interface StrategyResult {
  candidates: CandidateRecord[];   // everything any agent or step produced
  posted: CandidateRecord[];       // what the posting path would post
  findings: LiveFinding[];
  usage: RoundUsage;               // extended below
  toolCalls: ToolCallRecord[];     // empty for strategies without tools
  wallMs: number;
}

interface ReviewStrategy {
  name: string;                    // "a", "a0", later "f"
  version: string;                 // changes whenever prompts, model map or code change
  needsCheckout: boolean;
  estimateCost(input: StrategyInput): number;
  run(input: StrategyInput): Promise<StrategyResult>;
}
```

`RoundUsage` today is per skill prompt and completion tokens. It grows to carry cached
input, uncached input, output and reasoning tokens, so cold-cache and warm-cache runs can be
told apart. This is a change to a type the existing fixtures store inside traces, so the
extension is additive and optional, and `schemaVersion` stays 1.

Strategies register in a map in `src/replay/strategies/index.ts`. `ai-review replay --live
--strategy <name>` picks one; the default stays `a`, so today's behaviour is unchanged.

Strategy `a` is today's pipeline moved behind the interface with no behaviour change. A
test proves it by replaying a saved trace and getting the same candidates.

Strategy `a0` runs one reviewer on the same model the router picks for the round, with the
union of the five Tier 1 prompts' guidance reduced to one neutral prompt, and repeats it `n`
times where `n` is set so total spend matches A's recorded spend for that round, within a
tolerance the protocol file sets. Its results merge through the same `mergeReviewsDetailed`
path. A0 answers one question only: does splitting into personas help, or does A just spend
more.

### 2. Checkouts

`needsCheckout` strategies get a worktree of the fixture's repository at the round's head
commit, plus the base commit for diffing.

- A cache of bare clones lives under `~/.ai-review/checkouts/<owner>__<repo>.git`, filled
  with `gh repo clone` or `git fetch` on demand.
- Each run gets a throwaway worktree, created read-only in practice (the harness removes
  write permission after checkout) and deleted when the run ends.
- If a commit is no longer fetchable (force-pushed away), the round is marked
  `checkoutUnavailable` and excluded from tool-using strategies. It still runs for
  diff-only strategies, and the report states how many rounds each strategy could not run.
- The harness never executes code from the checkout. Tools that need execution (tests,
  coverage) are a later spec and must read CI artifacts or use a sandbox, per process doc
  section 5a.

### 3. Frozen inputs

A run is defined by `(strategy name and version, model map, prompt hashes, budget, fixture
snapshot id, seed)`. All of it is recorded in the result.

- `FrozenHistory` is built from the fixture with every item timestamped after the round's
  review time removed: later reviews, replies, thread resolutions, reactions, fix commits.
  Items with `unknown` timestamps are excluded and counted, never guessed.
- A test asserts that `FrozenHistory` for round i contains no item that sorts after round i,
  using a fixture with a later reply planted in it.
- Model IDs, effort and prompt file hashes come from the strategy's `version`; a run whose
  recorded version differs from the registered one is flagged stale.

### 4. Explaining the join rate

Before recall numbers are reported, a one-off investigation answers whether 0 of 15 is a
miss or a matcher failure, using ai-listings#50.

1. Take the 15 anthropic and 5 openai candidates and the labelled claims of that fixture.
2. A judge model that did not produce the candidates (a different provider from the
   candidate's) marks each candidate as "same underlying problem as labelled claim X",
   "different problem", or "unclear", with the code evidence.
3. Compare to `isSameClaim` at the current `JOIN_CLAIM_MATCH` bar (0.33 title similarity
   within 3 lines). If the judge finds matches the matcher misses, the matcher is the
   problem, and the fix (a widened line window, an evidence-aware matcher or both) is part
   of this work. If the judge finds none, the candidates were misses and the 0 stands.
4. The finding and the chosen matcher go into the protocol file. The 0.33 stays provisional
   until the matcher is validated on at least two fixtures from different repositories.

### 5. Blind adjudication of unmatched findings

Every candidate that matches no label gets a verdict from a judge that is not told which
strategy produced it.

- Verdicts: `real` (a defect or risk worth raising), `not-real`, `unclear`, plus for
  `real` whether it is about the change or about code the change only moved, renamed or
  reformatted.
- The judge is a different model family from the candidate's producer where that is
  possible. A second judge from another family re-judges all `real` and `unclear` verdicts.
  Verdicts both judges agree on count; disagreements stay `unresolved`, are reported as a
  count, and are excluded from precision and recall numerators and denominators with the
  count shown next to the result. They do not go to a human.
- Verdicts are cached by `(fixture snapshot, normalized claim)`, so the same claim made by
  two strategies is judged once and judged the same way.
- Fixtures are also audited once for defects the old reviewers missed: a judge pass over the
  diff with the labelled claims shown, listing real defects that no label covers. These
  added defects join the recall denominator, marked `auditAdded`.

### 6. Seeded fixtures

Each operation entry in `docs/review-ontology/operations/` has an "Eval seed". The first
five become synthetic PRs with a known right answer:

REL-01 (move with one stale mock path), REL-10 (move with one changed comparison), DEL-04
(guard removal), REL-03 (rename that changes a serialized field), MEC-01 (formatter-only
change with one hidden logic edit).

- A seed lives under `src/replay/seeds/<id>/` as a small base tree, a head tree, and a
  `truth.json` naming the defect's path, line range and description, or `{ "clean": true }`.
- Each seed has at least three variants (different language, different names, defect in a
  different place) written independently of the first, and one clean control with the same
  shape and no defect.
- A seed is materialised into a temporary git repo with two commits, so it flows through the
  same checkout and diff path as a real fixture.
- Seed scoring is exact: found the defect (by path and line range), flagged something else
  (a false positive on a clean control counts against precision), or found nothing.

### 7. The experiment layer

`src/replay/experiment/` runs a pre-registered plan.

- **Plan file** (`docs/review-experiments/protocol.md` plus `plan.json`), committed before
  the first scored run. It fixes the strategies and versions, models, providers, budgets,
  fixtures and their split, number of trials, metrics, thresholds and analysis. The runner
  refuses to score against a plan whose hash differs from the committed one.
- **Splits.** Fixtures are assigned to tuning, validation and test by PR, deterministically
  from a seeded hash of `owner/repo#pull`, recorded in the plan. The test set is not opened
  by any command except `experiment score --final`, which can run once per plan version.
- **Paired design.** Every strategy runs on every fixture snapshot, `k` trials each, in
  randomized order from a recorded seed.
- **Results store.** One JSONL record per `(strategy, fixture, round, trial)` under
  `~/.ai-review/experiments/<plan-hash>/`, holding the full `StrategyResult`, usage, tool
  calls, wall time, whether it fit in 210 seconds, and the run's version metadata. Raw
  results are append-only. Scoring reads them and never mutates them.
- **Uncertainty.** Metrics are computed per PR, then bootstrapped over PRs, for the paired
  difference between two strategies. Both providers are reported separately. Claims within
  one PR are never treated as independent.
- **Cost control.** The runner prints an estimate for the whole plan before starting and
  stops when the cap is hit, writing which cells are missing. A partial grid is reported as
  partial.

### 8. Metrics

Per the process doc section 6, computed per PR then aggregated:

- Precision: real findings over posted findings, using labels, then adjudication.
- Recall: found over (labelled real issues plus `auditAdded`) on real fixtures, and found
  over seeded defects on seeds.
- Wrong or irrelevant findings, with a separate count for findings about code that only
  moved, was renamed or reformatted.
- Recycling and convergence, reported with recall and the incomplete-review rate next to
  them.
- Cost and latency per PR from recorded usage; share of runs finishing inside 210 seconds;
  cold-cache and warm-cache reported separately.
- Join rate, as `{joined, candidates}`, with the matcher version.

### 9. Thresholds (written into the plan, proposed here)

These are proposals. The plan file is where they become binding, and they are fixed before
the first scored run.

- A candidate beats a baseline on precision only if the paired PR-level bootstrap interval
  for the difference excludes zero on the test set, on Anthropic and, within the OpenAI cap,
  on OpenAI, and recall has not
  dropped by more than 5 percentage points (point estimate) on the same set.
- A candidate is cost-competitive if median cost per PR is no more than the baseline's, or
  if it is higher and precision and recall both clear their bars.
- A hosted candidate must finish inside 210 seconds on at least 90% of test rounds. A
  candidate below that is local-only.
- Seeds are a gate, not a score: a strategy that misses more than one of the five original
  seeds, or posts a finding on any clean control, does not go forward.

### 10. Growing the fixture set

There are about 10 recorded PRs across 6 repositories, and 2 are held out. That cannot
support a three-way split. The plan sets a minimum before any scored run: at least 30 PRs,
10 per split, from at least 5 repositories, recorded with `ai-review replay --record`
(both providers where the PR has both bots). Recording is part of this work. PRs are
chosen from repositories Joe owns, spread across languages and operation types, with their
labels produced by the existing auto-label pass and the adjudication in section 5.

## Rules the builder needs, settled

These came out of the builder check. Each is a call made here with its reason, and the plan
file can tighten any of them.

- **Per-round and chained modes.** Two modes, because recycling and convergence are
  multi-round properties and the others are not.
  - *Per-round (default).* Each round is reviewed independently with `FrozenHistory` built
    from the recorded old-bot state at that time. Precision, recall, wrong or irrelevant
    findings, cost and latency are scored this way. Rounds are independent, so they can run
    in any order and in parallel.
  - *Chained.* Round i+1's history is the strategy's own output for round i, run through the
    ledger. Recycling and convergence are scored only here. The trial unit is a PR, not a
    round, and the results key is `(strategy, fixture, trial)` with rounds inside it.
  Chained mode is phase 6; the first scored grid reports per-round metrics only and says so.
- **Matching.** The deterministic `isSameClaim` join stays the definition of a match for
  offline replay and CI, and stays model-free. If the section 4 investigation shows it
  misses real matches, it is widened deterministically and saved `joinRate` figures are
  recomputed. Scoring in experiments adds one step on top: candidates the join leaves
  unmatched go to adjudication (section 5), whose cached verdicts are the only place a model
  is used in scoring.
- **OpenAI quota is scarce (Joe, 2026-11-05).** OpenAI use is treated as a rationed
  resource, not a second equal provider. The plan carries a hard OpenAI cap, separate from
  the Anthropic cap, and the runner refuses to start a cell that would pass it. Anthropic is
  the primary provider for every strategy and for all tuning and validation runs. OpenAI
  strategy runs happen only on the test set, as a confirmatory pass, and only for strategies
  that already cleared their bars on Anthropic. The "both providers" requirement in the
  thresholds therefore means Anthropic on all splits and OpenAI confirmation on the test
  set; if the OpenAI cap blocks it, the result is reported as Anthropic-only and labeled so.
  Offline replay and all non-model work spend no OpenAI quota.
- **Judges.** Judging is where OpenAI quota would leak fastest, so it is rationed too. The
  first judge for an Anthropic-produced candidate is a different Anthropic model (the
  strongest available) with a prompt that is blind to the producer. The cross-family check
  uses OpenAI only on verdicts that matter: candidates the first judge calls `real` or
  `unclear`, deduplicated by the verdict cache and capped by the OpenAI line above. Verdicts
  that skip the cross-check are marked `single-family` and the count is printed with every
  precision and recall figure. For OpenAI-produced candidates the first judge is Anthropic,
  so OpenAI judges nothing it produced. Judge spend is its own line in the plan, outside the
  strategy cost comparison. Auth follows the CLI rule: subscription first, API key only when
  there is no subscription.
- **A0 spend matching.** The target is A's cost for the same round in the same grid run, in
  dollars computed from recorded tokens at list price with cache reads priced as cache reads.
  A runs first in the grid, so the target always exists. Tolerance is plus or minus 10%.
  Recorded traces from older runs are not used for matching.
- **Posting path.** Every strategy's output goes through the same posting-path functions
  (`postFilterTrace`), including ledger suppression. A strategy returns candidates grouped by
  producing agent, and a single-agent strategy is one group. A strategy that does its own
  deduplication still gets the common filters, so `posted` means the same thing for all.
- **Unresolved items.** Labels that are unadjudicated, `unresolved` verdicts and audit
  candidates the two judges split on leave both numerator and denominator. Their count is
  printed next to every precision and recall figure.
- **Too few fixtures.** Below the 30-PR minimum the harness still runs, but results are
  labeled directional and the report makes no go or no-go claim. Both providers are not
  required on every PR; each provider is analyzed on the PRs that have it, and the plan
  lists the counts. PRs are chosen from Joe's repositories by a selection rule written in the
  plan before recording (language and operation-type spread, no peeking at outcomes).
- **The test set opens once.** The plan hash covers strategies and versions, models,
  budgets, fixture list and split, metrics, thresholds and analysis. Any change to those
  creates a new plan. A test set that has been scored cannot be reused for a revised plan;
  the revised plan needs fresh test PRs, or its results are labeled exploratory.
- **Base commits and dead rounds.** The checkout manager takes the base commit from the
  compare data the fixture was recorded from, and `--record` is extended to store it if it
  is missing. Rounds whose commits cannot be fetched are listed per strategy. The report
  states when tool-using strategies ran on a smaller subset than diff-only ones.
- **Wall time.** Wall time is measured at the concurrency the strategy would use in
  production (`AGENT_CONCURRENCY`, default 4), with A0's repeats run at that concurrency.
  The 210-second fit is judged against that figure, and local-only runs are labeled as such.

## Phasing

1. Strategy interface, `a` behind it with no behaviour change, extended usage, tests.
2. Frozen history, checkout manager, the join-rate investigation.
3. Adjudication pipeline and cache.
4. Seed fixtures and seed scoring.
5. A0, then the experiment layer, plan file and protocol (per-round mode).
6. Record fixtures up to the minimum, run the first scored grid (A and A0, per-round), then
   add chained mode for recycling and convergence.

Each phase ends with `pnpm typecheck`, `pnpm lint` and `pnpm test` green and its own PR.

## Left to the builder

- File layout under `src/replay/` beyond the paths named here.
- The exact prompt for A0's single reviewer, within the rule that it carries no persona
  split and no information A's agents do not get.
- The judge prompts and the schema of verdict records, within section 5's verdict set.
- The checkout cache's eviction policy.
- How `FrozenHistory` is represented internally.

## Open items this spec leaves to later specs

- Specs for F, the verifier, the context pre-pass and the scanner tools, each defining a
  `ReviewStrategy`.
- Running tests or coverage for untrusted PRs.
- Moving a winning candidate to the hosted path.
