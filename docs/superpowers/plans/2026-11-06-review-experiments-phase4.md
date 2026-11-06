# Review experiments harness, phase 4 plan

Spec: `docs/superpowers/specs/2026-11-05-review-experiments-harness-design.md` (section 6, the
seed gate in section 9, the seed recall line in section 8)

Goal: five seeded operation fixtures with variants and clean controls, a materialiser that turns a
seed into a two-commit git repo, exact seed scoring, and a CLI to check seeds offline and run a
strategy over them. No scored model run happens in this phase.

## Global Constraints

- TypeScript ESM, `.js` import suffixes, named exports only, Biome, Vitest colocated tests.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green before the PR.
- No test and no step calls a model API or authenticates to one. Strategy runs in tests use a
  stub strategy. The first real seed run is a separate action after this PR.
- Seed trees are fixture data, not project code: they are excluded from `tsc`, Biome and Vitest
  (add the exclusions in `tsconfig.json`, `biome.json` and the Vitest config, and prove it with
  a seed that contains a `*.test.ts` file and a type error).
- Seed layout: `src/replay/seeds/<op-id>/<variant>/{base/,head/,truth.json}` where `<op-id>` is
  one of `REL-01`, `REL-10`, `DEL-04`, `REL-03`, `MEC-01` and `<variant>` is `original`, `v1`,
  `v2`, `v3` or `clean`. `original` is the seed the ontology entry describes; the five
  originals are the gate set.
- `truth.json` is `{ "clean": true }` or `{ "clean": false, "defects": [{ "path": string,
  "startLine": number, "endLine": number, "description": string }] }`, with lines on the head
  side. Exactly one defect per non-clean seed.
- Each operation has `original`, at least three variants (different language, different names,
  defect in a different place) written independently of the original and of each other, and one
  `clean` control with the same shape and no defect.
- A seed is materialised into a temporary git repo with two commits (base, head) so it flows
  through the same checkout and diff path as a real fixture.
- Seed scoring is exact, by path and line range: `found`, `false-positive` (a finding that is
  not the defect), `missed`. A finding on a clean control is a false positive.
- The seed gate (spec section 9): a strategy that misses more than one of the five originals,
  or posts any finding on any clean control, does not go forward.

## Task 1: Seed format, validation and materialiser

Files: create `src/replay/seeds/schema.ts`, `materialize.ts`, `materialize.test.ts`; modify
`tsconfig.json`, `biome.json`, the Vitest config.

Interfaces:
- `SeedTruth` (zod) matching the truth.json shape above; `loadSeed(dir): Promise<Seed>` returns
  `{ id, opId, variant, dir, truth }` and rejects a truth with more than one defect or an
  inverted range.
- `materializeSeed(seed): Promise<{ repoPath; baseSha; headSha; cleanup(): Promise<void> }>`
  using `execFile("git", ...)` with no shell and `-c core.hooksPath=/dev/null`, two commits with
  fixed author and date so shas are reproducible.
- `listSeeds(root?): Promise<Seed[]>` in stable order.

Steps: red tests for a tiny inline seed (two commits, base and head shas differ, head tree
matches `head/`, cleanup removes the repo, a truth with two defects is rejected, shas identical
on a second materialisation), plus the exclusion proof. Then implement.

## Task 2: Seed to review input

Files: create `src/replay/seeds/input.ts`, `input.test.ts`.

Interfaces:
- `seedReviewInput(seed): Promise<{ fixture: FrozenFixture; round: Round; diff: string; files:
  PullFile[]; checkout: CheckoutHandle; cleanup }>` building a one-round fixture (owner `seed`,
  repo `<opId>-<variant>`, no claims, no threads), `files` from `git diff base head`
  (filename, status, patch, additions, deletions) and `diff` numbered with right-side line
  numbers via `numberPatchLines`, `checkout` pointing at the materialised repo (read-only).
- `truthInDiff(seed, files): boolean`: every defect range lies on right-side lines the diff
  shows.

Steps: red tests with the inline seed: files and numbered diff match expectations, the checkout
path exists and is not writable, `truthInDiff` true for a defect inside the diff and false for
one outside. Then implement.

## Task 3: Exact seed scoring and the gate

Files: create `src/replay/seeds/score.ts`, `score.test.ts`.

Interfaces:
- `scoreSeed(seed, findings: { path: string | null; line: number | null; title: string }[])
  : SeedOutcome` with `{ outcome: "found" | "false-positive" | "missed" | "clean-ok";
  foundDefect: boolean; extraFindings: number }`. A finding counts as the defect when its path
  equals the defect path and its line lies in `[startLine, endLine]`; a finding with a null path
  or line never counts as the defect. On a clean control any finding gives `false-positive`, none
  gives `clean-ok`. On a defect seed, no hit with no findings is `missed`; a hit with extra
  findings is `found` with `extraFindings > 0`; no hit with other findings is `false-positive`
  and also counts as missed (`foundDefect: false`).
- `seedGate(results: { seed; outcome }[]): { pass: boolean; originalsMissed: number;
  cleanFindings: number; reasons: string[] }` implementing the section 9 gate over the five
  originals and every clean control.

Steps: red tests for every outcome including the null path/line case, a range edge (start and
end inclusive), a clean control with one finding, and the gate at exactly one miss (passes) and
two misses (fails). Then implement.

## Task 4: Author the seeds (25 directories)

Files: create `src/replay/seeds/<op-id>/<variant>/...` for REL-01, REL-10, DEL-04, REL-03,
MEC-01. Authored in two independent waves so variants do not copy the original:
- Wave A authors `original` and `clean` for each operation from the ontology entry's Eval seed
  text only.
- Wave B authors `v1`, `v2`, `v3` for each operation from the Eval seed text only, without
  reading Wave A's output, each variant in a different language and with different names and a
  different defect position.

Each seed is small (base tree under about 150 lines in total, head tree similar) but realistic:
the defect is a genuine bug a reviewer could find from the diff, not a keyword. The clean control
has the same shape and a change with no defect. REL-03's original needs the rename across many
files kept small by using a generated-looking set of 6 to 8 files; MEC-01's formatter-only change
likewise at 6 to 8 files with one number changed.

Acceptance: a test `seeds.test.ts` walks `listSeeds()`, requires 25 seeds (5 operations times
`original`, `v1`, `v2`, `v3`, `clean`), distinct language coverage across each operation's
defect variants (at least two languages), every defect range inside the diff (`truthInDiff`),
every clean control with no defect, and every seed materialising to two distinct commits.

## Task 5: CLI

Files: modify `src/replay/command.ts`, `command.test.ts`; create `src/replay/seeds/run.ts`,
`run.test.ts`; modify `CLAUDE.md`; create `docs/review-ontology/seeds.md`.

Interfaces:
- `ai-review replay --seeds [--check | --plan | --strategy <name> --max-cost <usd>]`.
  - `--check` (default when no strategy is given): validates every seed offline (loads,
    materialises, truth in diff, counts) and exits 1 on any failure. No model.
  - `--plan`: prints the seed count, the strategy and the estimated cost via
    `strategy.estimateCost`. No model.
  - `--strategy <name>`: runs the strategy over every seed through the same `StrategyInput`
    path as the live tier (checkout set, `needsCheckout` honoured), scores each with
    `scoreSeed`, prints the per-seed table and the gate result, exits 1 when the gate fails or
    the cost cap stops the run before every seed ran.
  - Misuse (`--seeds` with `--live`, `--record`, `--adjudicate`, `--investigate-join`, or
    `--max-cost` without `--strategy`) exits 2.
- The strategy runner is injected in tests; tests use a stub strategy and never build a model.

Steps: red tests for the exit codes, `--check` over a tiny inline seed root, `--plan` making no
strategy call, a stub strategy that finds every defect (gate passes), one that misses two
originals (gate fails), one that posts on a clean control (gate fails), and the cap stopping the
run. Then implement, then write `docs/review-ontology/seeds.md` in plain prose and update the
replay paragraph of `CLAUDE.md`.

## Finish

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`; open one PR. The first scored seed run
(`--seeds --strategy a`, Anthropic only) is a follow-up that needs the Claude login.
