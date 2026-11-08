# Review experiments protocol

This protocol governs `ai-review replay --experiment`. Its design is in
`docs/superpowers/specs/2026-11-05-review-experiments-harness-design.md`. The plan that binds
a run is `docs/review-experiments/plan.json`. The file in the repository is a draft: it
carries `"draft": true`, and `run` and `score` refuse a draft.

Nothing is scored until a lock file is committed next to the plan file, named after it: `plan.lock`
for `plan.json`, `plan-chained.lock` for `plan-chained.json`. The lock holds the plan hash
(`planHash`, 16 hex characters of the canonical JSON). `run` and `score` exit 1 when the lock is
missing or the hash differs, and `plan` exits 1 when a lock exists and differs. Any change to
strategies, versions, fixtures, splits, budgets, metrics or thresholds is a new plan with a new
hash and its own results directory. The caps (`maxAnthropicUsd`, `maxOpenAiUsd`) apply per plan hash,
so a per-round plan and a chained plan can each spend up to them.

## Modes

A plan sets `mode`. A `per-round` plan reviews each recorded round independently, with the
suppression ledger built from the old bot's state at that time; a cell is one (strategy, fixture,
round, trial). Precision, recall, wrong or irrelevant findings, cost, latency and join rate are
scored this way, and the report says recycling and convergence are not measured.

A `chained` plan runs each (strategy, fixture, trial) as a chain: round i's ledger is built from the
strategy's own posted findings in rounds before i, not from the old bot's. Results are stored under
the same key as a per-round cell, with `round` set to the round index, so a chain is its rounds'
records under one plan hash. `plan` prints a chain count instead of a cell count, and `run` stops a
chain at its first failing, over-cap or unavailable round and lists the later rounds as missing.
Recycling and convergence are measured only in a chained plan. A chained report shows recycling,
convergence round and recall per strategy and provider, paired against `a` with a PR-level
bootstrap, and makes no go or no-go claim: precision, cost and latency are not scored, and there is
no verdict. Chains are not paired with per-round cells. A chained plan shares the per-round plan's seed, and so
its splits, so a chained run can never see test PRs that plain `score` has not been allowed to. It has
no final verdict: `score --final` on a chained plan exits 2 before reading cells or writing a marker.
Convergence is averaged over complete chains only, and the report line says so.

## Commands

- `ai-review replay --experiment plan [--plan-file <path>]` prints the cell count, the estimated
  spend per provider and the caps. It runs and writes nothing, and builds no model. It fetches each
  round's compare files through `gh` to size the diffs.
- `ai-review replay --experiment run` runs the grid in an order shuffled from the plan seed,
  stops at a provider's cap and prints one line per missing, over-cap or checkout-less cell
  (strategy, fixture, round, trial), so the list of cells to rerun is the output. Results are appended to
  `~/.ai-review/experiments/<plan-hash>/results.jsonl` (`AI_REVIEW_EXPERIMENTS_DIR` overrides).
- `ai-review replay --experiment score` scores tuning and validation cells. It never reads a
  test-split cell and prints no verdict.
- `ai-review replay --experiment score --final` scores the test split and nothing else. It refuses
  (exit 1, nothing written) when the test grid is partial or holds an over-budget cell, or, for a plan
  that is not directional, when a candidate has no seed-gate result; then it produces the
  report, and only then writes `final.marker`. A crash while scoring therefore does not consume the
  final; once the marker exists, a second `--final` for the same plan hash is refused. A marker that
  cannot be read is treated as scored, and a revised plan that shares test PRs with a scored plan, or
  finds an unreadable marker, is labeled exploratory.

`run` exits 0 only when the grid is complete, 3 when it is partial (a provider cap, a per-cell cap, a
round without a checkout), and 1 when a cell failed. A cell whose strategy threw is charged at its
estimate against that provider's cap, since a thrown run reports no usage. Caps stop one provider
at a time, so an exhausted Anthropic cap does not stop OpenAI test cells. The default plan path is
`docs/review-experiments/plan.json` in the repository, whatever `--fixtures` says.

Exit codes: 2 for flag misuse (any other mode flag combined with `--experiment`, `--final` outside
`score`), 1 for a missing or unreadable plan, a lock mismatch, a draft plan, a second final, or
failed cells.

## Splits

The plan schema rejects any fixture whose split differs from this rule, so a hand-edited split fails
validation. A fixture's split comes from `sha256(seed + owner/repo#pull)`: the first 32 bits as a fraction of
2^32, below one third is tuning, below two thirds validation, the rest test. Both providers' fixtures
of one PR share a split. Fixture ids are `owner/repo#pull@provider`.

## Fixture selection rule

Written before recording more PRs, and fixed without looking at outcomes. PRs come from
repositories Joe owns, spread across languages and operation types. Labels come from the existing
auto-label pass plus adjudication. The minimum for a verdict is 30 PRs, 10 per split, from at least
5 repositories. Below that every report is labeled directional and prints no go or no-go.

## Strategies and spend matching

`a` is the production pipeline. `a0` is a single reviewer repeated until its spend matches `a`'s
cost for the same round in the same grid run, within a tolerance of plus or minus 10%
(`a0Tolerance`). `a` always runs before `a0` for a round. Cost is computed from recorded tokens at
list price, with cache reads priced as cache reads.

## Metrics

Computed per PR, then aggregated by macro mean over PRs:

- Precision: real posted findings over judged posted findings. A finding is judged by the label of
  the claim it restates, else by a cached adjudication verdict. The scorer reads the cache and never
  calls a judge.
- Recall: labelled real claims found, over labelled real claims plus audit-added defects.
- Wrong or irrelevant findings, with a separate count for findings about code that only moved.
- Cost per PR from recorded usage; median wall latency per round; the share of rounds inside the
  plan's `hostedFitSeconds` (210 in the draft).
- Join rate: distinct candidates (by path, line and title) across a strategy's stored cells that
  `joinsClaim` joins to any labelled claim, reported as `joined/candidates` with the matcher
  version, per strategy and provider. It uses the same matcher and constants as `replay`.

Unadjudicated labels, `unclear` or `unresolved` verdicts and missing verdicts leave the numerator and
denominator. Their counts, and the count of `single-family` verdicts, print next to every precision
and recall figure.

## Thresholds

- Precision: the paired PR-level bootstrap interval (95%, 10000 resamples, seeded) for the difference
  to the baseline lies wholly above zero, and recall has not dropped by more than 5 points.
- Cost: median cost per PR is no more than the baseline's, or higher while precision and recall both
  clear their bars.
- Hosted: at least 90% of rounds finish inside 210 seconds, otherwise the strategy is local-only.
- Seeds: a gate. Missing more than one of the five originals, or any finding on a clean control, is
  a no-go. The gate is run with `replay --seeds --strategy <name> --gate-plan <plan-hash>`, which writes the result into that file (the plan hash must be 16 lowercase hex characters, else exit 2) (a run stopped by the
  cost cap writes nothing). `score --final` on a plan that is not directional refuses (exit 1) before writing the one-shot marker unless every candidate
  strategy has a result in `<experiments dir>/<plan-hash>/seed-gates.json`, shaped
  `{"<strategy>": {"pass", "originalsMissed", "cleanFindings", "reasons"}}`. The marker is written
  only after the report is produced. Without `--gate-plan` the run only prints the gate.
- OpenAI is rationed. Fixtures for OpenAI run only on the test split, and the plan carries a separate
  `maxOpenAiUsd`. An Anthropic result that clears its bars but has no OpenAI confirmation reads
  "Anthropic-only, unconfirmed on OpenAI" and carries no go or no-go.

## Known gaps

- Paired comparisons score both strategies on the `(round, trial)` cells they share within each PR.
  The report prints the number of shared cells and the PRs with no shared cell (left out), plus the
  PRs left out of the precision interval for having no judged finding.
- A cell that failed is not stored, so its reserved cost counts against the cap in that run only; a
  resumed run does not see it.
- Cache temperature is recorded as unknown.
