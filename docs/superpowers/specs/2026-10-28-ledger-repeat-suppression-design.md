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
- What settles a claim. Only high-confidence author signals: a reply that declines or defers it, a reply that cites a fixing commit, a thread the author resolved, or a thumbs-down or confused reaction from the author. A later commit touching nearby lines does not settle it, because that can hide a fix that did not work.
- Matching is on the claim. A new finding matches a settled entry when `isSameClaim` says so with the line window removed, since code moves between rounds. The same path is still required. A finding that moved files with an identical normalized title also matches, the rule `proposeRepeats` in `src/replay/label.ts` already uses.
- Fail open. If the ledger cannot be built, nothing is suppressed, the error is logged, and the review footer says `ledger: cold`. A review is never dropped because of the ledger.
- Silence. On a re-review round (the bot has a prior review of this PR), if no findings remain after suppression, post nothing and re-stamp the check-run through the existing SKIP path. A first review with zero findings still posts its APPROVE.
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

Evidence fetch. `fetchLedgerEvidence` is a separate fetcher that does not touch `src/replay/record.ts`, so the sprint 1 recorder and its fixtures stay as they are. It uses the Octokit instance `buildReview` already has and produces the same `PostedClaim`, `ThreadEvidence` and `ReactionEvidence` shapes. The webhook runs inside a 300s budget, so it makes one reviews call, one comments call, and one paginated GraphQL query that returns each thread with its replies and the reactions on its first comment. That avoids one REST call per bot comment, which on a long PR is over a hundred.

Live integration. In `buildReview`, after `mergeReviewsDetailed` and before `sanitizeInlineComments` and the 50-comment cap, run `suppressSettled` over `inline_comments` and `general_findings`. Log the counts. Add the suppressed count and `ledger: warm|cold` to the review footer. In `src/prompt.ts`, the prior-findings block shows each settled entry with its disposition and the author's reason, so the model also sees why. Code suppression is the guarantee. The prompt change only saves wasted output.

Harness integration. `todaysCodePipeline` in `src/replay/pipeline.ts` currently posts everything. It becomes `ledgerPipeline`: it builds a ledger from the `LedgerView` (labels with confidence `high` and a settled status only), then calls the same `suppressSettled`.

## Tests (each written to fail first)

- `match`: a reworded repeat on moved lines matches; two similar claims about different defects (the fixtures' `negativePairs`) do not.
- `suppress`: settled repeat dropped, open repeat kept, first-round claim never dropped.
- `disposition`: replay label snapshots are byte-identical after the extraction.
- `buildLedger`: a reply that declines settles; an author-resolved thread with no reply settles as `resolved`; a thread resolved by someone other than the author does not; replies from other accounts are ignored.
- `buildReview`: settled repeat dropped; zero findings left on a re-review returns null; zero findings on a first review still approves; a ledger fetch error leaves the review intact with `ledger: cold`.
- `ledgerPipeline`: through `replayFixture` and `checkRecall` on the three incident fixtures.

## Known limits

- The decline and fix patterns are heuristics (`REJECTED` matches "already done" and "kept as is"). Sharing them with the replay labeler means the live path inherits their false positives. The snapshot tests catch changes, not existing errors.
- The fixtures' confirmed repeat pairs are the only recall evidence. Real-world false suppression is bounded by the high-confidence-only rule and the negative-pair guard. It is not proven absent.
- Restated findings that are still open are not suppressed here. The harness reports the count so sprints 3 and 4 can decide.
