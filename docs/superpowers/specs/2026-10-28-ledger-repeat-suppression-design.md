# Ledger and repeat suppression (sprint 2)

Date: 2026-10-28
Bead: `ai-review-bot-w9b.1`
Epic: [review accuracy and convergence](2026-10-27-review-accuracy-epic-design.md)
Depends on: [sprint 1 replay harness](2026-10-27-review-replay-harness-design.md)

## Problem

On 2026-10-25 the Claude reviewer re-raised findings the author had already fixed or declined, and three PRs took about 10 hours to merge ([post-mortem](../../post-mortem-re-review-memory.md)). Two things in the code allow it.

- The only suppression done in code covers findings that triage marked resolved, matched by exact `path:line` or exact title (`mergeReviewsDetailed` in `src/review.ts`). A finding the author declined is never suppressed in code. It is suppressed only if the model obeys "do not file these again", and Claude did not on any of the five examples.
- Review memory is KV state: titles and severities, with no replies and no author decisions. The KV held no `review-state:*` keys during the incident, and a restarted `ai-review watch` forces a cold first cycle, so memory was missing in practice too.

## Goal

A settled claim is not posted again, whatever the model does. A re-review round that has nothing new posts nothing.

The sprint 1 harness verifies it. On the stealth-browser#1, ai-listings#74 and agent-skills#10 fixtures, recycled claims drop to 0, the final round is quiet, and the recall guard reports no failures.

## Non-goals

- Withdrawing a finding with a stated reason (the no-mistakes pattern). Deferred to sprint 6. The ledger reserves `decidedBy: "reviewer"` and a nullable `reason` so it needs no schema change later.
- Delta scoping and the watch cold-start fix (sprint 3).
- Removing the KV code paths (sprint 5). KV stays as an optional cache that nothing depends on.
- Suppressing findings that are still open. The prior-findings prompt block keeps that job, and the harness reports them as `restatedOpen`.

## Decisions

- The ledger is rebuilt from GitHub on every run: bot review comments, their threads, the author's replies, resolved status, and the author's reactions. It does not read KV.
- What settles a claim. Only high-confidence decisions: a reply that declines or defers it, a reply that cites a fixing commit, or a thread resolved by a decider. A later commit touching nearby lines does not settle it, because that can hide a fix that did not work. Reactions are recorded as evidence but never settle. The labeler rates them low confidence, and a confused reaction means the finding was unclear, not rejected.
- Who decides. The PR author and any non-bot account whose association with the repository is owner, member or collaborator. On an agent-authored PR the human implementer is not the PR author, so author-only would ignore the people the epic means by "the implementer". Other bots and drive-by accounts do not decide. The shared reply classifier takes a predicate for this: replay passes author equality (fixtures record only author replies), live passes author-or-collaborator.
- Matching is on the claim, in two tiers. Tier 1 is `isSameClaim` with its default thresholds and 30-line window. Tier 2 handles code that moved: same path, any distance, but a much stricter bar (title similarity at least 0.8 whether or not an identifier is shared, against 0.5 and 0.25 today). That catches a repeat that moved but kept its wording. A repeat that is both reworded and more than 30 lines away is not matched; the harness reports what that costs. No similarity bar can do better, because a one-noun edit and a genuine rewording score alike. Dropping the window alone is not safe: "loadUser leaks credentials after timeout" at line 10 and "loadUser leaks connections after timeout" at line 500 are different defects and match at the old identifier bar. A finding that moved files also matches when its normalized title is identical and both titles name a common code identifier. `proposeRepeats` in `src/replay/label.ts` uses the title rule alone, but it only proposes pairs for a person to confirm. Suppression acts on its own, and identical generic titles such as "Missing error handling" in two files are usually two defects. The six fixture label files have empty `negativePairs`, so this sprint populates them (see Tests).
- Fail open. If the ledger cannot be built, nothing is suppressed, the error is logged, and the review footer says `ledger: cold`. A review is never dropped because of the ledger.
- The ledger outranks KV. Prior open findings that the ledger shows as settled are dropped from `survivingPrior` before the verdict is computed, so a KV entry cannot keep a settled finding blocking. This holds on cold and forced runs too, since the ledger does not depend on KV.
- The verdict is recomputed after suppression. Today the event is fixed inside the merge, before suppression, so removing the last finding would leave it stale. After suppression and reconciliation: any fresh or surviving blocking finding gives REQUEST_CHANGES as now; none gives APPROVE as now.
- Silence. Post nothing only when the round has no fresh findings after suppression and the bot's previous verdict on this PR was not REQUEST_CHANGES. If the previous verdict was REQUEST_CHANGES and nothing blocking remains, post the APPROVE, because returning null posts no review and leaves the old blocking review standing (the check-run re-stamp does not supersede it). A first review with zero findings still posts its APPROVE.
- Reply and reaction interpretation is shared. The regexes and the reply and reaction classification now in `src/replay/label.ts` move to one module that both the replay labeler and the live path import, so measured behavior and shipped behavior cannot drift.
- A thread the author resolved with no classifying reply settles the claim with status `resolved` (outcome not stated). This signal exists only in the live path. GitHub records no timestamp for a resolution, so replay cannot restrict it to what was known before a round, and using it would leak hindsight into the measurement. `buildLedger` has its own unit tests for it.
- Local fallback. With no PR (`ai-review review --full`), the ledger loads from `.ai-review/ledger/<owner>__<repo>__<pr>.json`. This sprint writes only the load and save functions. Nothing derives dispositions locally yet, so a local ledger holds only what someone puts in it.

## Design

New directory `src/ledger/`. Named exports only, `.js` import specifiers.

| File | Responsibility |
| --- | --- |
| `types.ts` | `LedgerEntry`: `id`, `round`, `path`, `line`, `severity`, `title`, `action?`, `status` (`open`, `fixed`, `rejected`, `deferred`, `resolved`), `decidedBy` (`author`, `reviewer`, or null), `reason` (string or null), `evidence` (string array). Lines up with the no-mistakes `Finding` plus `status`, `decided_by`, `reason`, `round`. Imports nothing GitHub-specific. |
| `disposition.ts` | `deriveDisposition()` and the `DEFERRED`, `REJECTED`, `FIX_REF` patterns, extracted from `src/replay/label.ts`. `label.ts` imports them. Replay snapshot tests must not change. |
| `match.ts` | `findSettledMatch(finding, ledger)`, wrapping `isSameClaim` with the cross-round options. |
| `suppress.ts` | `suppressSettled(findings, ledger)` returns `{ kept, suppressed: { finding, entry }[] }`. Pure. |
| `github.ts` | `buildLedger(evidence)`, a pure function over the existing `PostedClaim`, `ThreadEvidence` and `ReactionEvidence` types in `src/replay/types.ts`, plus `fetchLedgerEvidence(octokit, opts)`. |
| `file.ts` | `loadLedger(path)` and `saveLedger(path, ledger)`. |

Evidence fetch. `fetchLedgerEvidence` is a separate fetcher that does not touch `src/replay/record.ts`, so the sprint 1 recorder and its fixtures stay as they are. It uses the Octokit instance `buildReview` already has and produces the same `PostedClaim`, `ThreadEvidence` and `ReactionEvidence` shapes. The webhook runs inside a 300s budget, so it makes one reviews call, one comments call, and one paginated GraphQL query that returns each thread with its replies (including each reply's `authorAssociation`) and the reactions on its first comment. That avoids one REST call per bot comment, which on a long PR is over a hundred.

Live integration. In `buildReview`, run `suppressSettled` over each agent's review before `mergeReviewsDetailed`, applied to its `inline_comments` and `general_findings`. An agent whose findings are all suppressed has its `event` downgraded to COMMENT, so the merge's existing rule computes the event from what is left. The bot's own review comments are identified by the review ids of reviews whose body carries `### <commentPrefix>`, so no bot login is needed. The previous verdict is the `state` of the latest such review in `existingReviews` (`CHANGES_REQUESTED` is the blocking one). Log the counts. Add the suppressed count and `ledger: warm|cold` to the review footer. In `src/prompt.ts`, the prior-findings block shows each settled entry with its disposition and the author's reason, so the model also sees why. Code suppression is the guarantee. The prompt change only saves wasted output.

Harness integration. `todaysCodePipeline` in `src/replay/pipeline.ts` currently posts everything, and `src/replay/command.ts` already uses it as the default. Its body becomes the ledger pipeline, so the name finally describes it: it builds a ledger from the `LedgerView` (labels with confidence `high` and a settled status only), then calls the same `suppressSettled`.

## Tests (each written to fail first)

- `match`: a reworded repeat on moved lines matches; the credentials-versus-connections example above does not match across 490 lines. Before writing the tier 2 thresholds, run the matcher over every cross-round claim pair in the three fixtures, list the pairs it joins that are not confirmed repeats, classify each (an agent, then `codex:codex-rescue` as a cross-check), and record the true negatives in `negativePairs` so the recall guard stops being vacuous. Pairs the two models disagree on are reported as a count.
- `suppress`: settled repeat dropped, open repeat kept, first-round claim never dropped.
- `disposition`: replay label snapshots are byte-identical after the extraction.
- `buildLedger`: a reply that declines settles; an author-resolved thread with no reply settles as `resolved`; a thread resolved by a non-decider does not; a collaborator's decline counts and a drive-by account's or another bot's does not; a reaction alone never settles.
- `buildReview`: settled repeat dropped; a KV-open prior finding the ledger shows settled does not force REQUEST_CHANGES; the verdict is recomputed when suppression removes the last fresh finding; zero findings left after a COMMENT or APPROVE returns null; zero findings left after a REQUEST_CHANGES posts an APPROVE; zero findings on a first review still approves; a ledger fetch error leaves the review intact with `ledger: cold`.
- `ledgerPipeline`: through `replayFixture` and `checkRecall` on the three incident fixtures.

## Known limits

- The decline and fix patterns are heuristics (`REJECTED` matches "already done" and "kept as is"). Sharing them with the replay labeler means the live path inherits their false positives. The snapshot tests catch changes, not existing errors.
- The fixtures' confirmed repeat pairs are the only recall evidence. Real-world false suppression is bounded by the high-confidence-only rule and the negative-pair guard. It is not proven absent.
- Restated findings that are still open are not suppressed here. The harness reports the count so sprints 3 and 4 can decide.
