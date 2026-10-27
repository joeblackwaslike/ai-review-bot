# Review replay harness design

Date: 2026-10-27
Bead: `ai-review-bot-a6a`
Context: project 1 of the review-accuracy effort. The incident is written up in [docs/post-mortem-re-review-memory.md](../../post-mortem-re-review-memory.md).

## Intent

On 2026-10-25 the Claude reviewer re-raised findings the author had rejected or fixed, and three PRs took about 10 hours to merge because the review rounds never converged. Every fix we plan (review memory, repeat suppression, delta scoping, Claude accuracy work) needs to be judged on whether it makes that better. We cannot judge it with the reviewer itself, because the reviewer is the thing that is broken and it may not converge on its own fixes. We need a harness that replays real recorded review rounds and reports numbers.

## What the numbers are

Three measures, all computed per PR and per provider (Claude and Codex), with the sample size printed next to every rate.

- False-positive rate is rejected findings divided by fixed plus rejected findings. A finding is rejected when the author declined it, skipped it, replied that it is intentional or by design, or marked it wrong with a 😕 or 👎. A finding is fixed when the author fixed it in a later commit. Findings nobody responded to are left out of the rate. They are still counted and shown separately.
- Recycling rate is the share of posted findings that repeat a claim already settled in an earlier round. A claim is settled when it was fixed, or when the author declined or skipped it, with or without a stated reason. The target is zero.
- Convergence is the number of rounds until a round posts no new finding. On the three incident PRs the recorded value is "did not converge".

## Goals

- Record the review history of a GitHub PR into a platform-neutral fixture, and commit the three incident PRs as the first fixtures: stealth-browser#1, ai-listings#74, agent-skills#10.
- Label each recorded finding as fixed, rejected, or unadjudicated, from what the author did.
- Replay the recorded rounds in order through the code that runs after the model call, with a ledger of settled claims built from earlier rounds, and report the three measures.
- Report a baseline for today's code, so every later change shows a before and after.
- Fail loudly if a change drops a finding the author fixed. Suppression that hides real bugs is worse than the repeats.
- Offer a small, opt-in live tier that re-runs the real reviewer on a few recorded rounds to estimate first-pass false positives.

## Non-goals

- Building the ledger, claim matching across rounds, or suppression. That is project 2. The harness only needs a way to plug that logic in.
- Fixing the cold start in `ai-review watch`, delta scoping, or Claude's first-pass accuracy (projects 3 and 4).
- Changes to the Vercel deployment, or the no-mistakes adapter (projects 5 and 6).
- A dashboard, a trend database, or automatic labeling that needs no human check.

## Anti-goals

- A harness whose pass or fail depends on the broken reviewer behaving well.
- A recycling number that goes to zero because the pipeline suppresses everything. The recall guard exists to prevent this.
- A live run that can fail CI, or whose spend is not capped.
- Metrics with no named ground truth.

## Constraints

- TypeScript ESM, Vitest, Biome, named exports only, `.js` import suffixes, tests colocated with source. Match the rest of the repo.
- The core types and the replay engine contain no GitHub types. Only the recorder knows about Octokit, threads, and reactions. The shapes should line up with the no-mistakes `Finding` (`id`, `severity`, `file`, `line`, `description`, `action`) plus disposition fields (`status`, `decided_by`, `reason`, `round`), because a later project will add a no-mistakes adapter.
- All four repos involved are public, so fixtures are committed to this repo. Fixtures hold review text, replies, reactions, and commit SHAs, not full diffs. The live tier fetches the diff for a SHA when it runs.
- The offline replay is deterministic, makes no network calls, and runs in the normal `npm test`.
- The live tier uses the local subscription auth that `ai-review review` already uses. It is never wired into the webhook path.
- History only records what was posted. Raw per-agent output from the incident rounds does not exist. So the offline replay can test logic that runs on posted findings (suppression, filters, the ledger). It cannot re-test merging or deduping of raw agent output, which the live tier approximates.

## Decisions made with Joe

- Offline replay is the main tier. The live tier is a small share of verification, opt-in and capped.
- Findings with no author response are left out of the false-positive rate.
- A skipped or declined finding counts as settled even without a stated reason.
- A settled claim stays suppressed even if the code around it changes. A different claim on the changed code is allowed.
- The three measures above are the success criteria. Convergence is the most important.

## Shape

These are the pieces and how they connect. File and flag names are my calls and the builder may change them.

- Types in `src/replay/types.ts`. A `ReplayFixture` holds the PR identity, the provider, and an ordered list of rounds. Each round has a head SHA, the commits and size since the previous round, the posted findings, and the dispositions the author gave before the next round.
- Recorder in `src/replay/record.ts`. Given a PR, it reads bot reviews, inline comments, replies, thread resolution, and reactions through `gh`, and writes a fixture under `test/fixtures/replay/`.
- Labeler in `src/replay/label.ts`. It reads a recorded fixture and assigns each finding a label and a confidence, with the evidence quoted. Labels are saved beside the fixture so a person can read and correct them. Joe spot-checks them once.
- Engine in `src/replay/replay.ts`. It takes a fixture and a pipeline under test, feeds each round's findings to the pipeline with the ledger of earlier rounds, and records what was posted and what was suppressed.
- Pipeline interface. A function from `{round, findings, ledger}` to `{posted, suppressed}`. v1 ships two: "as recorded" (nothing suppressed, the real history) and "today's code" (the existing post-model stages). Project 2 adds a third.
- Metrics in `src/replay/metrics.ts`, the report printer, and a `ai-review replay` command. Without flags it replays every fixture and prints the table. `--record <pr-url>` records a PR. `--live --rounds <n> --max-cost <usd>` runs the live tier.
- A Vitest test that replays the committed fixtures, asserts the recall guard is zero, and asserts the baseline numbers do not get worse than the committed baseline.

## Live tier

For each chosen recorded round, fetch the PR diff at that round's SHA, run the real reviewer once, and compare its findings against the labels of the recorded findings: how many match a fixed claim, how many match a rejected claim, how many are new. It prints a spend total before it starts and stops at `--max-cost`. Results vary between runs, so it prints a range from repeated runs only if asked, and it never gates anything.

## Left to the builder

- The exact fixture schema and file layout.
- The labeling rules in detail. Starting points from the incident: an author reply of "Intentional", "No change", "By design", or "Agreed there's no defect" means rejected. A reply or commit message saying "Fixed in <sha>" followed by a changed hunk means fixed. A 😕 or 👎 means rejected. A resolved thread with no reply is unadjudicated.
- How claims are compared across rounds in the replay. `isSameClaim` in `src/claim-dedupe.ts` is the existing starting point, and project 2 owns the final matching.
- Report formatting and CLI flags.
- Which rounds the live tier samples by default.

## Calls I made, for review

- Fixtures live in the repo and hold SHAs, not diffs.
- The command is a subcommand of the existing `ai-review` CLI, not a separate binary.
- Convergence is reported as the count of consecutive trailing rounds that post nothing new, and offline it can only measure what suppression removes, not whether the agents would stop finding new things.
- The three incident PRs are the only fixtures for v1. Adding more is a recorder run.
