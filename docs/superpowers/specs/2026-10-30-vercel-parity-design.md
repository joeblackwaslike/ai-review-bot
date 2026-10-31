# Vercel parity (sprint 5)

Date: 2026-10-30
Bead: `ai-review-bot-w9b.6`
Epic: [review accuracy and convergence](2026-10-27-review-accuracy-epic-design.md)
Depends on: [sprint 2 ledger](2026-10-28-ledger-repeat-suppression-design.md), [sprint 3 delta scoping](2026-10-29-delta-scoping-warm-start-design.md), [agent failure logs and retry](2026-10-29-agent-failure-logs-and-retry-design.md)

## Problem

The bead says the hosted deployment should get the same ledger, suppression and scoping as `watch`, with no KV dependence. Before changing anything we measured what the hosted paths run today. Almost all of it already runs. Three problems remain, and one of them held a real PR at CHANGES_REQUESTED.

## What the hosted path runs today

The webhook, the QStash `review-run` callback, the inline fallback and the slash command all end in `maybeSubmitReview` and then `buildReview` (`src/github-app.ts:429`, `:535`). `watch` calls the same functions (`src/watch.ts:213`). No flag turns the ledger or the baseline on or off. This table comes from reading the code, not from running it.

| Behavior | Hosted | Evidence | Where its state comes from |
| --- | --- | --- | --- |
| Ledger suppression | yes | `review.ts:1844`, `:2321-2344` | GitHub threads only (`ledger/live.ts`) |
| Delta scoping | yes | `review.ts:1742-1765` | KV state if present, else the GitHub baseline |
| Cold-start baseline | yes | `review.ts:1653-1692` | review markers plus the ledger, from GitHub |
| Silence on an empty round | yes | `review.ts:2501-2530`, `github-app.ts:573` | in memory |
| Partial-review gating and retry | yes | `review.ts:2108-2135`, `:2212-2248` | the `agents` marker on GitHub, plus KV `incompleteSkills` |
| Superseded head | yes | `github-app.ts:942-985` | GitHub only |
| QStash redelivery | partly | `setNx` claim at `github-app.ts:491-496`; without KV only the `ai-review:sha` marker check at `review.ts:1465-1475` | KV, optional |

Hosted and `watch` differ in auth (API key versus subscription), the local JSONL log (hosted writes only the `agents` marker), the poll loop and circuit breaker (`watch` only), and QStash, the claim and the feedback writes (hosted only). All of these are intended.

## Defects

### 1. Settled findings stay "still open" after a file moves

On PR #92 both bots listed three findings under "Still open from the previous review, not re-checked" even though their threads were answered and resolved. Because a carried finding with a path blocks at any severity (`blocksVerdict`, `review.ts:1444`), each round ended in REQUEST_CHANGES with "no new findings" in its own summary. Review ids 5719022478, 5719026463, 5719190216 and 5719191481 had to be dismissed by hand to merge.

Cause, from the code, the review bodies and the PR's review threads:

- Carried findings come from persisted state and keep the path they were posted with, `src/self-retraction.ts`.
- The author later renamed that file to `src/replay/retraction-rule.ts`. GitHub reports the resolved threads against the new path. This step is inferred from the thread data, not tested separately.
- `findSettledMatch` (`ledger/match.ts:145`) requires equal paths in every rule except `isMovedFileRepeat`. That rule also needs a shared code identifier, and these titles have none.
- Nothing checks that a carried finding's file still exists in the PR.

One more fact, checked against GitHub on 2026-10-30. `GET /pulls/92/files` lists `src/replay/retraction-rule.ts` as `added` with no `previous_filename`, because the file was created and renamed inside the PR. The old name is absent from the PR file set. A rename map built from `previous_filename` would not have fixed #92.

### 2. A KV outage fails a review

`loadReviewState` throws on a non-forced run (`review.ts:1643`). Production has `KV_REST_API_*` set, so a KV error today stops a review that GitHub alone could have run.

### 3. KV still holds review state

KV state is read at `review.ts:1634` and written at `:1715` and `:2653-2712`. The GitHub baseline reproduces it. KV also lets `lastReviewedSha` move past agents that did not finish, and it keeps stale paths alive. The only KV uses that GitHub cannot replace are the duplicate-run claim and the feedback and carrier writes (`github-app.ts:753`, `:800`). Neither is review state.

## Goals

1. A carried finding is settled when its thread was settled, even after a rename or move.
2. A carried finding whose file is not in the PR any more stops blocking, and the review says so.
3. A round with no new findings and no live open findings is not REQUEST_CHANGES.
4. Review state comes only from GitHub. A deployment with KV unset, or with KV failing, makes the same decisions.

## Non-goals

- Sprint 6, the no-mistakes adapter.
- The 27 defects in `ai-review-bot-4ez` and the P3 follow-ups (`ai-review-bot-w9b.11`, the model-side filler bead).
- Making path-less findings settleable. A carried P0 or P1 finding with no path has no thread and can still block. That is existing design.
- Removing the feedback loop or the carrier comment. They keep their KV use.
- A looser title-only matcher (see Decisions).

## Decisions

### Rename-aware matching instead of a looser matcher

Letting `isMovedFileRepeat` match on equal titles alone would also suppress unrelated findings that share a generic title in two files. We have no measurement of that error rate, and a wrongly suppressed finding is silent. So the fix is exact. Before matching, each carried finding's path is mapped through the PR's `files[].previous_filename` to its current path. `files` is the full paginated PR list (`review.ts:1510`), so the map covers every file the PR renamed.

### A path not in the PR retires the finding

After mapping, a carried finding whose path is not in the PR file set cannot anchor to the head. It is retired: it leaves the carried list and no longer blocks, and the review body lists it under a short "Retired, file no longer in this PR" note. This is not a claim that the finding was fixed. The GitHub thread is untouched. This rule is what fixes PR #92.

The risk is a finding on a file renamed inside the PR whose thread is still unresolved. Retiring it stops the bot from blocking on it. It does not hide it, because the open thread stays on GitHub. We accept that.

### GitHub is the only source of review state

`buildReview` stops reading and writing `ReviewState` in KV. The baseline is always derived with `deriveBaseline`. KV stays for the `setNx` claim and the feedback and carrier writes, and each of those already proceeds when KV is missing or throws. Tests will pin that.

Without KV, duplicate suppression falls back to the sha marker check. Two simultaneous deliveries of one SHA can both review before either posts. QStash uses `retries: 1` and the webhook sends a dedup id, so the window is small and the cost is one duplicate review. We accept it and say so in the docs.

If `deriveBaseline` or the ledger fetch fails, the round degrades to a full review that suppresses nothing. It never degrades to a skipped review, and it never errors. Retirement is computed from GitHub on every round, so nothing about it needs storing. It applies only to carried findings, never to findings from the current round.

The `ReviewState` type and `saveReviewState` stay if `watch` or another caller needs them. Removing them is cleanup for the plan to decide, not a goal.

### Redelivery and superseded heads

Unchanged. The superseded check refetches the PR and compares heads, with no KV. A redelivered run for a head that already has a review hits the marker check and posts nothing.

## What we can and cannot verify

Offline:

- Unit tests with fakes that assert the request shape (REST parameters, GraphQL variables). Sprint 2 shipped a GraphQL call with no variables because a mock hid it.
- A new replay fixture recorded from PR #92. The default `ai-review replay` run must stay green, including the recall guard and the negative pairs. We record its numbers before and after.
- A `buildReview` test for the #92 shape: three settled carried findings on a path that left the PR, a clean delta, expected event not REQUEST_CHANGES.
- Tests with `kv` unset and with `kv` throwing.

Against real GitHub, read only:

- `deriveBaseline` and the ledger on PR #92 and on the three incident PRs (`stealth-browser#1`, `ai-listings#74`, `agent-skills#10`).
- `GET /pulls/92/files` for rename data (done: see Defects).

We cannot measure the deployed bots before merge. We do not run `ai-review watch` next to the live bots, because both would post. After merge and deploy, the first new PR shows the behavior, and we record that review in the PR and the bead.

We also do not measure how often a retired finding was still unresolved on its thread, or how often hosted runs hit the duplicate-delivery window. We have no count for either.

## Other beads

`ai-review-bot-bne` (maxDuration 800 on Hobby) is stale. `vercel.json` sets 300 on the review routes, the last five production deploys are Ready (`vercel ls --prod`, 2026-10-30), and production has no `AGENT_CONCURRENCY` or `REVIEW_AGENT_BUDGET_SECONDS` override (`vercel env ls production`). It closes with this sprint.

## Result for PR #92

After the change, the three self-retraction findings have a path that is not in PR #92, so they retire. The round has a clean delta and no live open findings, so it does not stay at CHANGES_REQUESTED. This is checked offline from a recorded fixture. It is confirmed live only after deploy.
