# Review experiments protocol

This protocol governs `ai-review replay --experiment`. Its design is in
`docs/superpowers/specs/2026-11-05-review-experiments-harness-design.md`. The plan that binds
a run is `docs/review-experiments/plan.json`. The file in the repository is a draft: it
carries `"draft": true`, and `run` and `score` refuse a draft.

Nothing is scored until `plan.lock` is committed next to `plan.json`. The lock holds the plan hash
(`planHash`, 16 hex characters of the canonical JSON). `run` and `score` exit 1 when the lock is
missing or the hash differs, and `plan` exits 1 when a lock exists and differs. Any change to
strategies, versions, fixtures, splits, budgets, metrics or thresholds is a new plan with a new
hash and its own results directory.

## Modes

Per-round mode only. Each recorded round is reviewed independently, with the suppression ledger
built from the old bot's state at that time. Precision, recall, wrong or irrelevant findings, cost
and latency are scored this way. Recycling and convergence need chained mode, which is phase 6;
every report says they are not measured.

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
- Join rate is deferred to phase 6. The scorer does not compute it; `replay` still reports it
  offline for fixtures with saved traces.

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
  a no-go. The gate is run with `replay --seeds --strategy <name>`. `score --final` on a plan that
  is not directional refuses (exit 1) before writing the one-shot marker unless every candidate
  strategy has a result in `<experiments dir>/<plan-hash>/seed-gates.json`, shaped
  `{"<strategy>": {"pass", "originalsMissed", "cleanFindings", "reasons"}}`. The marker is written
  only after the report is produced. Storing `--seeds` results into that file is phase 6; until then
  the file is written by hand from the `--seeds` output.
- OpenAI is rationed. Fixtures for OpenAI run only on the test split, and the plan carries a separate
  `maxOpenAiUsd`. An Anthropic result that clears its bars but has no OpenAI confirmation reads
  "Anthropic-only, unconfirmed on OpenAI" and carries no go or no-go.

## Known gaps

- The scorer takes audit-added defects as input but the command does not yet read them from the
  adjudication cache, so recall counts labelled claims only.
- `--seeds` does not yet write `seed-gates.json` (phase 6).
- Paired comparisons score both strategies on the `(round, trial)` cells they share within each PR.
  The report prints the number of shared cells and the PRs with no shared cell (left out), plus the
  PRs left out of the precision interval for having no judged finding.
- A cell that failed is not stored, so its reserved cost counts against the cap in that run only; a
  resumed run does not see it.
- Cache temperature is recorded as unknown.
