# Review replay harness design

Date: 2026-10-27
Bead: `ai-review-bot-a6a`
Context: sprint 1 of the review-accuracy epic (`ai-review-bot-w9b`). Shared decisions are in the [epic spec](2026-10-27-review-accuracy-epic-design.md). The incident is written up in [docs/post-mortem-re-review-memory.md](../../post-mortem-re-review-memory.md).

## Where this fits

This is sprint 1 of 6, in the order they will be built. Later sections refer to the others by number.

1. Replay harness. This document.
2. Ledger and repeat suppression. A platform-neutral record of findings and what happened to them, claim-level matching across rounds, and silence when a round has nothing new.
3. Delta scoping and the cold-start fix. Each round reviews only what changed since the last reviewed commit, and a restarted `ai-review watch` stops forcing a full review.
4. Claude's first-pass accuracy, aimed at whatever the harness shows is wrong most often.
5. Vercel parity. The hosted deployment gets the same changes.
6. A no-mistakes adapter, so this review style can run in the no-mistakes flow before a PR exists.

## Intent

On 2026-10-25 the Claude reviewer re-raised findings the author had rejected or fixed, and three PRs took about 10 hours to merge because the review rounds never converged. Every fix we plan (review memory, repeat suppression, delta scoping, Claude accuracy work) needs to be judged on whether it makes that better. We cannot judge it with the reviewer itself, because the reviewer is the thing that is broken and it may not converge on its own fixes. We need a harness that replays real recorded review rounds and reports numbers.

## What the numbers are

Three measures, all computed per PR and per provider (Claude and Codex), with the sample size printed next to every rate.

- False-positive rate, precisely the author rejection rate, is rejected findings divided by fixed plus rejected findings. It measures what the author decided, not whether the claim was factually wrong, and the report says so. Findings the author deferred for scope or a follow-up are labeled deferred and shown separately, not counted as rejected. A finding is rejected when the author declined it, skipped it, replied that it is intentional or by design, or marked it wrong with a 😕 or 👎. A finding is fixed when the author fixed it in a later commit. Findings nobody responded to are left out of the rate. They are still counted and shown separately.
- Recycling rate is the share of posted findings that repeat a claim already settled in an earlier round. A claim is settled when it was fixed, or when the author declined or skipped it, with or without a stated reason. The target is zero.
- Convergence is the number of recorded rounds that still post at least one first-seen claim, meaning a claim not previously posted in any earlier round, whether that earlier claim ended up open or settled, and whether the final round posts nothing new. On the three incident PRs the recorded value is "did not converge". The replay follows the recorded timeline and never simulates the pushes that would have happened if some findings had been suppressed, so offline it measures only what suppression removes.

## Goals

- Record the review history of a GitHub PR into a platform-neutral fixture, and commit the three incident PRs as the first fixtures: stealth-browser#1, ai-listings#74, agent-skills#10.
- Label each recorded finding as fixed, rejected, or unadjudicated, from what the author did.
- Replay the recorded rounds in order through the code that runs after the model call, with a ledger of settled claims built from earlier rounds, and report the three measures.
- Report a baseline for today's code, so every later change shows a before and after.
- Fail loudly if a change drops a finding the author fixed. Suppression that hides real bugs is worse than the repeats.
- Offer a small, opt-in live tier that re-runs the real reviewer on a few recorded rounds to estimate first-pass false positives.

## Non-goals

- Building the ledger, claim matching across rounds, or suppression. That is sprint 2. The harness only needs a way to plug that logic in.
- Fixing the cold start in `ai-review watch`, delta scoping, or Claude's first-pass accuracy (sprints 3 and 4).
- Changes to the Vercel deployment, or the no-mistakes adapter (sprints 5 and 6).
- A dashboard, a trend database, or automatic labeling that needs no human check.

## Anti-goals

- A harness whose pass or fail depends on the broken reviewer behaving well.
- A recycling number that goes to zero because the pipeline suppresses everything. The recall guard exists to prevent this.
- A live run that can fail CI, or whose spend is not capped.
- Metrics with no named ground truth.

## Constraints

- TypeScript ESM, Vitest, Biome, named exports only, `.js` import suffixes, tests colocated with source. Match the rest of the repo.
- The core types and the replay engine contain no GitHub types. Only the recorder knows about Octokit, threads, and reactions. The shapes should line up with the no-mistakes `Finding` (`id`, `severity`, `file`, `line`, `description`, `action`) plus disposition fields (`status`, `decided_by`, `reason`, `round`), because sprint 6 will add a no-mistakes adapter.
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
- Labeler in `src/replay/label.ts`. It reads a recorded fixture and assigns each finding a label and a confidence, with the evidence quoted. Labels are saved beside the fixture so they can be read and corrected. An agent verifies them against the PR threads and commits, and a different model (Codex) cross-checks the result.
- Engine in `src/replay/replay.ts`. It takes a fixture and a pipeline under test, feeds each round's findings to the pipeline with the ledger of earlier rounds, and records what was posted and what was suppressed.
- Pipeline interface. A function from `{round, findings, ledger}` to `{posted, suppressed}`. v1 ships two: "as recorded" (nothing suppressed, the real history) and "today's code" (the existing post-model stages). Project 2 adds a third.
- Metrics in `src/replay/metrics.ts`, the report printer, and a `ai-review replay` command. Without flags it replays every fixture and prints the table. `--record <pr-url>` records a PR. `--live --rounds <n> --max-cost <usd>` runs the live tier.
- A Vitest test that replays the committed fixtures, asserts the recall guard is zero, and asserts the baseline numbers do not get worse than the committed baseline.

## Live tier

For each chosen recorded round, fetch the PR diff at that round's SHA, run the real reviewer once, and compare its findings against the labels of the recorded findings: how many match a fixed claim, how many match a rejected claim, how many are new. It prints a spend total before it starts and stops at `--max-cost`. Results vary between runs, so it prints a range from repeated runs only if asked, and it never gates anything.

## Settled after the builder check

- "Today's code" has almost nothing to run on posted findings. The only existing cross-round suppression (`resolvedKeys`) needs triage state, and merging and anchor validation need raw agent output and diffs that were not recorded. So the v1 baseline for recycling is the recorded history, and the "today's code" pipeline is a thin wrapper that exists to prove the plug-in interface works. The Vitest test therefore asserts that the fixtures load, that labels and metrics are stable against a committed snapshot, and that the recall guard is zero. A "does not get worse than baseline" assertion starts when sprint 2 supplies a real pipeline.
- Recycling is measured against repeat pairs that are labeled in the fixtures, not against the pipeline's own matcher. The labeler proposes pairs (same file, close lines, shared identifier or similar title, plus a quoted reply that settled the first one), and a person confirms them. A pipeline matcher that suppresses more than the labeled pairs does not lower the recycling number, and one that suppresses a labeled fixed finding trips the recall guard.
- The recall guard applies to the first occurrence of a claim. A finding labeled fixed in round 1 must still be posted in round 1. The same claim re-raised in round 3 is a repeat, and suppressing it is correct.
- To detect "fixed" offline, the recorder also stores, for each commit between rounds, the changed file paths and hunk line ranges. It does not store diff bodies. The labeler uses these with the reply text, and makes no network calls.
- Fixtures are per provider. A reply is credited to the bot whose thread it is in. Third-party bots such as `chatgpt-codex-connector` are not counted as findings or as responders. "The author" is the PR author's account, which is also the account the implementer agent pushes and replies as.
- The committed baseline starts from the automatic labels and is marked provisional. It becomes final after agent verification and the Codex cross-check. Labels the two models still disagree on stay unadjudicated, and their count is recorded. The Vitest test passes either way.

## Hardening decisions

These came from a self-critique and a cross-model critique of the approved spec. They refine the sections above and win where they conflict.

Claims and labels

- The unit of measurement is an atomic claim, not a posted comment. The merge step joins distinct findings at one anchor into a single comment, separated by `\n\n---\n\n` ([src/review.ts](../../../src/review.ts) `mergeReviewsDetailed`). The recorder splits on that separator as a first guess, and a person confirms the split. One comment can hold several claims, each with its own label and its own repeat pairs.
- Repeat pairs may cross lines, files, and moved code. They are confirmed by a person and are not limited to what `isSameClaim` would match.
- Findings in a review body's table have no reply thread. They are labeled from other evidence (PR-level comments naming them, a later review marking them resolved) or stay unadjudicated. The author rejection rate is dominated by inline findings and the report states the split.
- A label of fixed needs more than a changed hunk near the line. The recorder captures each thread's `isOutdated` and `isResolved` state and `resolvedBy`, and the labeler combines them with the reply text and the changed hunk. A label that gates something (see the recall guard) must be confirmed by a person.
- Reactions count only when they come from the PR author's account, are read per reaction with the actor and creation time, and not as aggregate counts.

Time and evidence

- Every piece of evidence is stored with its timestamp, and edited comments with a note that they were edited. The decision cutoff for a round is the time the reviewed head was pushed. If that is unknown, it is the review's submit time minus 15 minutes. Evidence after the cutoff is not visible to that round. Historical state GitHub does not expose (for example when a thread was resolved) is stored as unknown and treated as not visible.
- Review dismissals, thread reopenings, deleted comments, and force pushes are recorded when seen. A round whose reviewed head no longer exists is marked approximate.

Metrics and guards

- The recall guard has two parts. Every suppressed finding must be in an explicit, human-confirmed allowed-suppression set, which holds confirmed repeats of any previously posted claim, open or settled. Any other suppression is reported as unexpected and fails the check until a person adjudicates it. And a confirmed fixed claim must still be posted in its first round. The fixtures also hold negative pairs, which are similar findings that describe different defects and must both survive.
- Labels that have not been confirmed by a person are provisional. A guard failure that rests on a provisional label is a warning. A failure on a confirmed label fails the test.
- The report counts two kinds of repeat separately and suppression of either is allowed. Recycling is a repeat of a settled claim and its target is zero. Restated open findings are repeats of a claim that is still open and unresolved. They are shown beside the recycling rate, because the "do not re-file" rule applies to them too, and neither kind counts toward convergence.
- Samples are small (13 Claude inline findings on the three incident PRs). The report prints counts, such as 4 of 10, never a bare percentage. CI asserts on the guard and on label and metric stability against the snapshot. It does not assert thresholds on rates.

Live tier

- The recorder stores each round's base SHA and merge-base so the diff can be rebuilt. Where the history was rewritten, the round is marked approximate. From now on the recorder also preserves the exact review input where it is available.
- Findings from a live run are matched to labeled claims only through confirmed pairs. Anything else is reported as new and unlabeled, and no accuracy figure is claimed for it until a person adjudicates a sample.

What this harness does not verify

- Delta scoping and the watch cold-start fix (sprint 3), anchor filtering, and merging of raw agent output cannot be tested from posted findings. Each of those sprints writes its own verification contract in its spec.

## Left to the builder

- The exact fixture schema and file layout.
- The labeling rules in detail. Starting points from the incident: an author reply of "Intentional", "No change", "By design", or "Agreed there's no defect" means rejected. A reply or commit message saying "Fixed in <sha>" followed by a changed hunk means fixed. A 😕 or 👎 means rejected. A resolved thread with no reply is unadjudicated.
- How claims are compared across rounds in the replay. `isSameClaim` in `src/claim-dedupe.ts` is the existing starting point, and sprint 2 owns the final matching.
- Report formatting and CLI flags.
- Which rounds the live tier samples by default.

## Calls I made, for review

- Fixtures live in the repo and hold SHAs, not diffs.
- The command is a subcommand of the existing `ai-review` CLI, not a separate binary.
- Convergence follows the recorded timeline. Suppressing a round-2 finding does not change what was pushed before round 3.
- The three incident PRs are the only fixtures for v1. Adding more is a recorder run.
