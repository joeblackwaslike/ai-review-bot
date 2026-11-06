# Seeded fixtures

Real recorded pull requests tell us how a reviewer behaves on code people wrote, but we rarely
know every defect in them. Seeded fixtures are the opposite: tiny synthetic changes where we
wrote the defect ourselves, so the right answer is known exactly. They are a gate, not a
score. A review strategy that cannot pass them does not go on to the expensive runs.

## What a seed is

There are five operations: REL-01 (a move that leaves one stale mock path), REL-10 (a move
that changes one comparison), DEL-04 (a guard removed that a retrying caller relied on),
REL-03 (a rename that changes a serialized field) and MEC-01 (a formatter-only change with one
hidden logic edit). Each operation has five seeds: `original`, `v1`, `v2`, `v3` and `clean`.
The three variants use other languages, other names and a defect in a different place. The
`clean` control has the same shape as the original with no defect.

A seed lives in `src/replay/seeds/<op-id>/<variant>/` and holds a `base/` tree, a `head/`
tree and a `truth.json`. The truth file is either `{ "clean": true }` or one defect with its
path, a start and end line on the head side, and a description. Lines are right-side lines
of the diff. The trees are fixture data: `tsc`, Biome and the test runner all skip them, so a
seed may contain a test file or a type error on purpose.

## How a seed is reviewed

`materializeSeed` copies the base tree into a fresh git repo, commits it, replaces the tree
with the head tree and commits again. Author and dates are fixed, so the commit hashes are the
same on every run. `seedReviewInput` then reads the diff between the two commits, builds the
file list and the right-side-numbered diff, and hands the strategy a one-round fixture with
no history plus a read-only checkout of the head tree. The strategy sees the same input shape
as in the live tier.

## Scoring and the gate

Scoring is exact. A posted finding is the defect when its path equals the defect path and its
line falls in the defect range, ends included. A finding without a path or a line never
counts. A defect seed ends as `found`, `missed` (no findings at all) or `false-positive`
(findings, none of them the defect, which also counts as a miss). A clean control ends as
`clean-ok` or `false-positive`.

The gate is the rule from the experiments design: a strategy goes forward only if it misses at
most one of the five originals and posts nothing on any clean control. The variants are scored
and shown but do not affect the gate.

## Commands

`ai-review replay --seeds` (same as `--seeds --check`) validates every seed offline. It loads
each one, materialises it, and checks that the defect lies on lines the diff shows. It uses no
model and exits 1 on any failure.

`ai-review replay --seeds --plan [--strategy <name>]` prints the seed count, the strategy and
the estimated cost. It does not run the strategy.

`ai-review replay --seeds --strategy <name> --max-cost <usd>` runs the strategy over every
seed, prints one row per seed and the gate result, and exits 1 when the gate fails or the cost
cap stops the run before every seed has been reviewed. The default cap is 5 USD. The first
scored run is a separate step from adding the seeds, because it needs a logged-in model
account.

Using `--seeds` together with `--live`, `--record`, `--adjudicate` or `--investigate-join`, or
`--max-cost` without `--strategy`, is a usage error and exits 2.

## Adding a seed

Write the base and head trees small and realistic, with a defect a reviewer could find from
the diff alone. Avoid comments or names that announce the defect. Write the truth file with
the defect's head-side lines, then run `ai-review replay --seeds` and the seed acceptance
test, which also rejects hint words such as "bug" or "todo" in any seed file.
