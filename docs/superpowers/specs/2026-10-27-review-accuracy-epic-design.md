# Review accuracy and convergence epic

Date: 2026-10-27
Bead: `ai-review-bot-w9b`
Origin: [docs/post-mortem-re-review-memory.md](../../post-mortem-re-review-memory.md)

This document holds the decisions that apply to the whole epic. Each sprint has its own spec for the details that only matter to it. When a sprint spec and this document disagree, fix the disagreement here first.

## Intent

On 2026-10-25 three PRs took about 10 hours to merge because the Claude reviewer re-raised findings the author had already rejected or fixed, and its rounds never converged. The reviewer also produced far more false positives than the Codex reviewer on the same diffs. The epic makes the reviewer converge, and makes that measurable.

## Success measures

Computed per PR and per provider, with sample sizes shown. Definitions are in the [sprint 1 spec](2026-10-27-review-replay-harness-design.md).

1. Convergence. Rounds until a round posts nothing new. The most important measure.
2. False-positive rate. Rejected findings out of fixed plus rejected. Findings nobody responded to are left out of the rate.
3. Recycling rate. Posted findings that repeat an already-settled claim. The target is zero.

## Decisions

- A finding is settled when it is fixed, or when the implementer skips or declines it, with or without a stated reason. A reason is stored when given and is never required.
- A settled claim stays suppressed even when the code around it changes. A different claim on the changed code is allowed. Matching is on the claim, not on the line or the wording.
- Suppression happens in code, not only in the prompt, so it does not depend on the model complying.
- A round reviews only what changed since the last reviewed commit. When there is nothing new, the bot posts nothing.
- The reviewer may withdraw its own finding with a reason, as no-mistakes does, instead of silently dropping it.
- The core review loop works on a platform-neutral record of findings and their dispositions. It lines up with the no-mistakes `Finding` (`id`, `severity`, `file`, `line`, `description`, `action`) plus `status`, `decided_by`, `reason`, and `round`. GitHub and no-mistakes are adapters. GitHub-specific things (right-side diff anchoring, review events, check-runs, thread and comment ids) stay in the GitHub adapter. A local file ledger is the fallback and also serves `ai-review review --full`.
- Review memory must not depend on KV or on a watcher having been running. It is rebuilt from the platform (for GitHub, review threads, replies, resolved status, and reactions) or from a local ledger.
- Reviews run locally with `ai-review watch` on Joe's subscription for now. The Vercel deployment gets the same changes, so fixes go in the shared review path and not in `watch` alone.
- Claude's first-pass accuracy is measured and classified before anything is tuned.

## Verification principle

The reviewer is the broken part and may not converge on its own fixes. So no sprint is verified by running the bot against its own PR until it goes quiet. Each sprint is verified by the replay harness (deterministic, offline, mostly historical), tests written to fail first, and at most one local review pass on the sprint's PR whose findings are each checked against the code by hand. A small, capped live tier in the harness estimates first-pass false positives.

## Sprints

Ordered by dependency. Each sprint is a child bead and gets its own spec, plan, and PR.

| Sprint | Bead | Depends on | What it does |
| --- | --- | --- | --- |
| 1. Replay harness | `ai-review-bot-a6a` | none | Records PR review history into fixtures, labels findings, replays rounds, reports the three measures. [Spec](2026-10-27-review-replay-harness-design.md) |
| 2. Ledger and repeat suppression | `ai-review-bot-w9b.1` | 1 | The neutral ledger, claim matching across rounds, suppression in code, silence when nothing is new. |
| 3. Delta scoping and cold-start fix | `ai-review-bot-w9b.2` | 1 | Per-round delta scoping, and a restarted `ai-review watch` no longer forces a full cold review. |
| 4. Claude first-pass accuracy | `ai-review-bot-w9b.3` | 1 | Classify Claude's false positives and fix the largest group. |
| 5. Vercel parity | `ai-review-bot-w9b.6` | 2, 3 | The hosted deployment gets the same behavior, with no KV dependence. |
| 6. No-mistakes adapter | `ai-review-bot-w9b.7` | 2 | Runs this review style in the no-mistakes flow before a PR exists, as a custom gate that writes findings JSON. |

## Non-goals for the epic

- A review dashboard or trend database.
- Changing the set of review agents or skills, except where sprint 4 shows a specific one is the cause.
- Driver-side fixes in the pr-loop and no-mistakes `pr` step (title rewrites, round caps). Those are tracked outside this repo.

## Open at the epic level

- Which sprint 4 fixes are worth doing depends on what sprint 1 shows.
- Whether a no-mistakes gate can see earlier decisions was not checked and is a sprint 6 question.
