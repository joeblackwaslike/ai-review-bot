# Adaptive review limits

Bead `ai-review-bot-t0c.30` (B9), part of the epic `ai-review-bot-t0c`. Also supplies the last deliverable of the audit bead `ai-review-bot-t0c.41`: how the limits consume trajectory and change-shape signals.

## Intent

A review loop that keeps producing findings the author rejects does not converge. The author spends rounds answering low-value findings, each push triggers another review, and the next review finds more. `docs/post-mortem-review-loop-churn.md` records about 2.5 hours lost this way on PRs #67 and #68.

The bot should notice this on its own and tighten what it posts, using only what the developer already does: fixing, replying, reacting and resolving threads. The developer sets nothing. No label, slash command or environment setting exists for this, because a control the author must remember to flip means the bot failed to read a situation it had the data to read.

Two limits are adjusted before each review:

- **Severity floor.** Findings below a level are not posted.
- **Findings budget.** At most N findings are posted, ranked by severity and then by how much support each has. An empty result is allowed.

## Goals

- Round 1 is a full review, because there is no history to read.
- The limits come from the whole trajectory of the PR. Recent rounds count more, older rounds still count, and it matters most in rounds 3 to 5.
- When a budget applies, its size follows what the last push actually was (moved code, formatting, docs, code), not its line count. The push shape never imposes a budget by itself.
- A limited review says so in plain words, and the reasons are logged.
- The effect can be measured on replay before it is on by default.

## Non-goals

- Fetching repo contents or checking references after a move. That belongs to the reviewer tool surface (`ai-review-bot-t0c.45`). This design only exposes the moved-code result so a later tool can use it.
- Changing which findings agents produce, or any prompt.
- Learning the constants automatically. They are named, provisional and tuned by hand on replay.

## Anti-goals

- Hiding a likely bug because the loop is going badly. P0 and P1 are exempt from both limits.
- A review that requests changes over a finding nobody can see. A dropped finding never holds the verdict and never enters the ledger.
- Reading silence as rejection. A finding the author has not answered says nothing about its quality.

## Constraints

- Webhook path only reads GitHub plus optional KV. KV is not required (`CLAUDE.md`, Upstash KV), so any signal that lives only in KV is optional and the controller must work without it.
- The ledger (`src/ledger/`) already rebuilds every prior finding from GitHub threads with `round`, `severity`, `status` (`open`, `fixed`, `rejected`, `deferred`, `acknowledged`, `resolved`), `decidedBy` and `reason`. That is the reliable signal.
- Reactions (`up`, `down`, `confused`) live in the KV feedback store (`src/feedback/`). A `confused` reaction always arrives with a reply, and the reply carries the meaning.
- TypeScript ESM, named exports, Vitest, Biome. Controller and classifier are pure functions with no I/O, so replay can call them.
- `src/auth.ts` is never imported from webhook paths.

## Approaches considered

1. **Weighted trajectory score (chosen).** Each earlier round gets a friction score from the outcomes of its findings. Rounds are weighted by recency. The score maps to the two limits, and the push shape scales the budget. Deterministic, replayable, and the constants are easy to tune.
2. **Discrete states.** Loose, tight and tightest, with transitions such as "two bad rounds in a row". Simpler, but the limits jump at the thresholds and the trajectory is used less smoothly.
3. **A model reads the thread and picks the limits.** Best at reading reply nuance, but it adds cost and latency, gives different answers on the same input, and cannot be replayed to measure it. The existing reply patterns in `src/ledger/disposition.ts` already catch "by design" and "won't fix".

Joe picked approach 1 on 2026-11-06.

## Design

### Trajectory scorer

Pure function `scoreTrajectory(history)` returning a friction score in `[0, 1]` and the evidence behind it.

For each earlier round `r`, take the findings the bot posted in that round and classify each as:

- **accepted**: status `fixed`, `resolved` or `acknowledged` with `decidedBy: "author"`, or an `up` reaction.
- **rejected**: status `rejected`, a `down` reaction, or a `confused` reaction whose reply matches the rejected patterns.
- **deferred**: status `deferred`. Counts as half a rejection, because the author agreed it is real.
- **unanswered**: still `open` with no reply and no reaction. Excluded from the round's rate.

Entries settled by the bot itself (`decidedBy: "reviewer"`, for example a thread the resolver closed after a fix landed) are excluded like unanswered ones. They show the bot cleaning up, not what the author thought of the finding.

A round's friction is `(rejected + 0.5 * deferred) / (accepted + rejected + deferred)`. A round with no answered findings has no friction value and is skipped.

Round weights are `0.5^a`, where `a` is how many rounds back the round is (0 for the most recent). The score is the weighted mean of friction over rounds that have a value. With no such round the score is undefined and no limits apply.

Starting bands (provisional constants in `src/reviewer-tuning.ts`):

| Score | Floor | Budget |
| --- | --- | --- |
| below 0.35 | none | none |
| 0.35 to 0.6 | none | 10 |
| 0.6 and above | P2 | 5 |

The budget is also capped by the push-shape factor below. The 50-comment payload cap stays as the outer limit.

### Push-shape classifier

Pure function `classifyPush(files)` over the files changed since the last review (the same delta the incremental review already computes), using status, `previous_filename` and patch.

It returns, per file, a kind (`code`, `test`, `docs`, `config`, `infra`, `shell`, `binary`, `generated`, `lockfile`) and for the push:

- **Reviewable weight**: changed lines weighted by kind (code and shell at 1, tests at 0.7, config and infra at 0.5, docs at 0.3, generated, lockfile and binary at 0).
- **Whitespace-only** files, detected when the patch is empty after normalizing whitespace. A first-time auto-format of an old file is the same case and carries weight 0.
- **Rename-only** files (status `renamed`, no content change).
- **Deletion-only** files and the lines they delete.
- **Moved blocks**: a run of at least 5 consecutive normalized lines deleted in one file and added in another. Moved lines carry weight 0 as new code and are reported as `{from, to, lineCount}` pairs.
- File count, so one 40-line file and twenty 2-line files differ.

Budget factor: when the trajectory band gives a budget, the budget used is `clamp(ceil(reviewableWeight / 8), 2, budgetFromBand)`. A push of mostly moved lines, formatting or docs gets a small budget, and a large code push is limited only by the band. When the band gives no budget (score below 0.35, or undefined), no budget applies whatever the push looked like.

The factor needs a delta. A review that is not incremental (a manual `/ai-review`, a same-head rerun, or a skill that reviews the whole PR) skips the push-shape factor, and the band's budget applies unscaled.

### Applying the limits

Applied once, after merge and diff-anchor sanitizing and before `buildReviewComments`, at the existing cap site in `src/review.ts` (`capInlineComments(sanitizedComments, MAX_INLINE_COMMENTS)`). It acts on inline comments and general findings together.

- The pool is this review's new findings, inline comments and general findings together. Carried open entries are never counted against the budget and never removed.
- P0 and P1 are never removed.
- P2 and P3 below the floor are removed. If more than the budget remain after P0 and P1, the rest are removed in order of severity, then `confidence`, then the number of agents that raised the same claim, then position. The agent count has to be available at this point, so the map that `skillsByKey` builds moves ahead of the cap site or is passed in.
- Each removed finding is recorded as a `Discard` with its own reason, `ADAPTIVE_LIMIT`, so replay can separate it from the 50-comment `CAP`. Disposition is `dropped`.
- If the review would request changes and the limits removed every new finding, and no carried entry blocks, the event drops to `COMMENT`. If any new finding remains posted, or any carried entry blocks, the event is unchanged. This is the same rule `dropRetractions` uses. The event is `APPROVE` only when the normal rule gives `APPROVE`.
- Removed findings are not written to the carry marker and are not read back by `deriveBaseline`.

### Telling the reader

When a limit removed anything, the review body gets one plain sentence, for example "Showing the 5 highest-severity findings this round (P2 and up), because most findings in earlier rounds were declined." It uses no `> - ` bullet and no marker the baseline parsers read, the same way off-diff P2 and P3 drops are named. A structured log line records the score, the per-round values, the band, the push-shape result and the counts removed.

### Rollout

Behind a `REVIEWER_TUNING` switch, off until replay shows the effect (below). Flipping it on is a code change after measurement, not a setting for developers.

## Measurement

The replay trace (`src/replay/trace.ts`) gains the controller as a step after the existing filters. Round `i` is scored from the fixture's earlier rounds only, the way `ledgerForRound` already builds the ledger. Reactions come from the fixture's recorded reactions.

Report per fixture and overall:

- findings removed that match a confirmed-real label (the cost), listed by severity;
- findings removed that match a rejected label (the benefit);
- posted findings per round, before and after;
- rounds to the first clean round, on fixtures with several rounds.

Gate for turning the switch on: no confirmed-real finding removed on the held-out fixtures, and removed findings on the full set are mostly rejected-labelled. Most removed candidates will not join a label (join rates are low today), so the report first runs `replay --adjudicate` on the removed candidates that join nothing and counts its verdicts. The gate reports "inconclusive" and the switch stays off unless at least 10 removed candidates carry a label or an adjudicated verdict. Unadjudicated items are reported separately and do not count for or against.

## Calls I made

- P0 and P1 are exempt from both limits, so a failing loop can never hide a likely bug.
- A distinct discard reason, `ADAPTIVE_LIMIT`, instead of reusing `CAP`.
- Rollout switch off until replay passes the gate above.
- Band edges (0.35, 0.6), the budgets (10, 5), the half-weight for deferred and the decay of 0.5 per round are starting values, not derived. Replay tunes them.
- Unanswered findings are excluded from friction rather than counted as a mild rejection. Findings the bot settled itself are excluded too.
- Push shape only scales a budget the trajectory already imposes. It never limits a review on its own, so round 2 and any healthy loop get a full review whatever the push looked like.
- Non-incremental reviews skip the push-shape factor.
- One pool for inline and general findings, and carried entries stay outside it.
- The replay gate needs at least 10 labelled or adjudicated removed candidates; below that it says "inconclusive".
- The moved-block rule needs 5 lines and exact normalized matches, to stay cheap and avoid false moves.

## Left to the builder

- Where reaction data comes from on the webhook path (the KV feedback store when present, otherwise the GitHub reactions API for the bot's own inline comments), and how to join it to ledger entries.
- How to compute the incremental delta files for `classifyPush` from what `maybeSubmitReview` already fetches.
- Whether general findings need their own budget accounting separate from inline comments.
- Test layout: scorer and classifier get table tests, and each limit rule gets a failing test first.
