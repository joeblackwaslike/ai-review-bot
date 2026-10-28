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

The sprint 1 harness measures it on the stealth-browser#1, ai-listings#74 and agent-skills#10 fixtures (six fixtures, one per provider). The target was zero recycled claims, a quiet final round and no recall-guard failures. The measured result is 14 recycled claims before and 7 after, pinned per fixture at 1, 0, 0, 0, 2 and 4 (agent-skills, ai-listings and stealth-browser, anthropic then openai). The final round is quiet in 1 of 6 fixtures, the same as before. The recall guard reports no failures. Known limits lists what the matcher misses.

## Non-goals

- Withdrawing a finding with a stated reason (the no-mistakes pattern). Deferred to sprint 6. The ledger reserves `decidedBy: "reviewer"` and a nullable `reason` so it needs no schema change later.
- Delta scoping and the watch cold-start fix (sprint 3).
- Removing the KV code paths (sprint 5). KV stays as an optional cache that nothing depends on.
- Suppressing findings that are still open. The prior-findings prompt block keeps that job, and the harness reports them as `restatedOpen`.

## Decisions

- The ledger is rebuilt from GitHub on every run: bot review comments, their threads, the author's replies, resolved status, and the author's reactions. It does not read KV.
- What settles a claim. Only high-confidence decisions: a reply that declines or defers it, a reply that cites a fixing commit, or a thread resolved by a decider. A later commit touching nearby lines does not settle it, because that can hide a fix that did not work. Reactions are recorded as evidence but never settle. The labeler rates them low confidence, and a confused reaction means the finding was unclear, not rejected.
- Who decides. The PR author and any non-bot account whose association with the repository is owner, member or collaborator. On an agent-authored PR the human implementer is not the PR author, so author-only would ignore the people the epic means by "the implementer". Other bots and drive-by accounts do not decide. The shared reply classifier takes a predicate for this: replay passes author equality (fixtures record only author replies), live passes author-or-collaborator.
- Matching is on the claim. `findSettledMatch` tries five rules in order and stops at the first one that matches a settled entry.
  1. Tier 1 is `isSameClaim` with its default thresholds and 30-line window.
  2. Tier 2 handles code that moved within a file: same path, any distance, title similarity at least 0.8 whether or not an identifier is shared. A repeat that is both reworded and more than 30 lines away is not matched. Dropping the window alone is not safe: "loadUser leaks credentials after timeout" at line 10 and "loadUser leaks connections after timeout" at line 500 are different defects and match at the old identifier bar.
  3. A finding that moved files matches when its normalized title is identical and both titles name a common code identifier. Identical generic titles such as "Missing error handling" in two files are usually two defects, so the title alone is not enough.
  4. The body rule: same file, within 30 lines, both findings have a body, and the Jaccard similarity of title plus body tokens is at least 0.25. It catches a repeat whose title was reworded but whose explanation was not.
  5. The cross-surface rule, for an inline finding against a general one, which the path check would always reject. They match when their titles clear the unanchored 0.6 bar with paths ignored, or when both texts name a common code identifier and at least 60% of the shorter text's words appear in the other, counting each identifier as one word.

  A code identifier here is camelCase that starts with two lowercase letters, snake_case or SCREAMING_CASE, or a `$name`. GitHub, TypeScript and eBay do not count. Two filters apply before any rule. Product names shaped like eBay or iPhone are lowercased, so they cannot lower the tier 1 bar. A finding about a missing test never matches a finding about a defect; the test is a title pattern ("no test", "untested", "not covered", "test coverage"). When several settled entries match at the same rule, the finding goes to the one with the highest title plus body similarity, then the latest round, then the lowest id.

  A P0 finding gets a stricter set. Only tier 1, tier 2, the moved-file rule and the title half of the cross-surface rule apply, and tier 1 uses its plain 0.5 title bar even when the titles share a code identifier. The body rule and the identifier half of the cross-surface rule are skipped, because suppressing a P0 by mistake costs more than posting it again.

  `proposeRepeats` in `src/replay/label.ts` uses the title rule alone, but it only proposes pairs for a person to confirm. Suppression acts on its own. The fixtures' `negativePairs` now hold the seven candidate pairs that a Claude agent and Codex classified as distinct defects (one of them the two models disagreed on; it was ruled distinct).
- Fail open. If the ledger cannot be built, nothing is suppressed, the error is logged, and the review footer says `ledger: cold`. A review is never dropped because of the ledger.
- The ledger outranks KV. Prior open findings that the ledger shows as settled are dropped from `survivingPrior` before the verdict is computed, so a KV entry cannot keep a settled finding blocking. This holds on cold and forced runs too, since the ledger does not depend on KV.
- The verdict is recomputed after suppression and reconciliation. Any fresh or surviving blocking finding gives REQUEST_CHANGES; none gives APPROVE.
- Silence. The standing verdict is the state of the latest own review that is APPROVED, CHANGES_REQUESTED or DISMISSED. COMMENTED and other states are skipped, because a comment neither clears a change request nor grants approval, and a dismissed review (branch protection dismisses stale approvals on a push) means the PR has no approval. Post nothing only when the round has no fresh findings after suppression and the standing verdict is APPROVED or absent. The check-run is then re-stamped as APPROVE when the standing verdict is APPROVED and as COMMENT otherwise, and every KV finding still open is saved as resolved, since the ledger settled all of them. If the standing verdict is CHANGES_REQUESTED or DISMISSED and nothing blocking remains, post the APPROVE, because returning null posts no review and leaves the old review standing (the check-run re-stamp does not supersede it). A first review with zero findings still posts its APPROVE. The same applies when triage says SKIP: if the ledger leaves no open finding and the standing verdict is CHANGES_REQUESTED or DISMISSED, the round runs as INCREMENTAL so the clean result posts an APPROVE instead of only re-stamping the check-run.
- Several claims in one comment. The merge can put distinct findings in one inline comment, and one reply cannot say which of them it settles. A reply therefore never settles a claim from a comment that holds more than one. Those claims settle only when a decider resolves the thread, and then all of them settle as `resolved`. A comment with a single claim is settled by a reply as before.
- Reply and reaction interpretation is shared. The regexes and the reply and reaction classification now in `src/replay/label.ts` move to one module that both the replay labeler and the live path import, so measured behavior and shipped behavior cannot drift.
- A thread the author resolved with no classifying reply settles the claim with status `resolved` (outcome not stated). This signal exists only in the live path. GitHub records no timestamp for a resolution, so replay cannot restrict it to what was known before a round, and using it would leak hindsight into the measurement. `buildLedger` has its own unit tests for it.
- Local fallback. With no PR (`ai-review review --full`), the ledger loads from `.ai-review/ledger/<owner>__<repo>__<pr>.json`. This sprint writes only the load and save functions. Nothing derives dispositions locally yet, so a local ledger holds only what someone puts in it.

## Design

New directory `src/ledger/`. Named exports only, `.js` import specifiers.

| File | Responsibility |
| --- | --- |
| `types.ts` | `LedgerEntry`: `id`, `round`, `path`, `line`, `severity`, `title`, `action?`, `status` (`open`, `fixed`, `rejected`, `deferred`, `resolved`), `decidedBy` (`author`, `reviewer`, or null), `reason` (string or null), `evidence` (string array). Lines up with the no-mistakes `Finding` plus `status`, `decided_by`, `reason`, `round`. Imports nothing GitHub-specific. |
| `disposition.ts` | `classifyReplies()` and the `DEFERRED`, `REJECTED`, `FIX_REF` patterns, extracted from `src/replay/label.ts`. `label.ts` imports them. Replay snapshot tests must not change. |
| `match.ts` | `findSettledMatch(finding, ledger)`: the five rules, the two filters and the tie-break described under Decisions. |
| `suppress.ts` | `suppressSettled(findings, ledger)` returns `{ kept, suppressed: { finding, entry }[] }`. Pure. |
| `github.ts` | `buildLedger(evidence)`, a pure function over the existing `PostedClaim`, `ThreadEvidence` and `ReactionEvidence` types in `src/replay/types.ts`, plus `fetchLedgerEvidence(octokit, opts)`. |
| `file.ts` | `loadLedgerFile(path)` and `saveLedgerFile(path, ledger)`. |

Evidence fetch. `fetchLedgerEvidence` is a separate fetcher that does not touch `src/replay/record.ts`, so the sprint 1 recorder and its fixtures stay as they are. It uses the Octokit instance `buildReview` already has and produces the same `PostedClaim`, `ThreadEvidence` and `ReactionEvidence` shapes. The webhook runs inside a 300s budget, so it makes one reviews call, one comments call, and one paginated GraphQL query that returns each thread with its replies (including each reply's `authorAssociation`) and the reactions on its first comment. That avoids one REST call per bot comment, which on a long PR is over a hundred. The GraphQL call sends owner, repo, pr and cursor under `variables`. `octokit.request("POST /graphql")` puts top-level params into the JSON body as they are, so a query that declares `$owner` but gets no `variables` fails and every run would be cold. Only `octokit.graphql()` moves top-level params into variables.

Live integration. In `buildReview`, run `suppressSettled` over each agent's review before `mergeReviewsDetailed`, applied to its `inline_comments` and `general_findings`. An agent whose findings are all suppressed has its `event` downgraded to COMMENT, so the merge's existing rule computes the event from what is left. The bot's own review comments are identified by the review ids of reviews whose body carries `### <commentPrefix>`, so no bot login is needed. The standing verdict is the `state` of the latest such review in `existingReviews` that is APPROVED, CHANGES_REQUESTED or DISMISSED (see Silence). Log one line per suppressed finding (title, anchor, severity, matched entry id and status, no bodies) and the counts. Add the suppressed count and `ledger: warm|cold` to the review footer. In `src/prompt.ts`, the prior-findings block shows each settled entry with its disposition and the author's reason, so the model also sees why. Code suppression is the guarantee. The prompt change only saves wasted output.

Harness integration. `todaysCodePipeline` in `src/replay/pipeline.ts` currently posts everything, and `src/replay/command.ts` already uses it as the default. Its body becomes the ledger pipeline. It builds a ledger from the `LedgerView` (labels with confidence `high` and a settled status only), then calls the same `suppressSettled`. Each claim's text is passed as its body. The pipeline also returns `matchedTo`, the prior claim each suppressed claim was matched to. `checkRecall` fails a negative pair only when one member was matched to the other, or when a pipeline reports no attribution. A member that is a confirmed repeat of some third claim can then be suppressed without failing the guard.

## Tests (each written to fail first)

- `match`: a reworded repeat on moved lines matches; the credentials-versus-connections example above does not match across 490 lines; each rule has a test built from abbreviated real texts that fails when the rule is switched off. The matcher was also run over every cross-round claim pair in the fixtures, the pairs it joined that were not confirmed repeats were classified by an agent and by `codex:codex-rescue`, and the true negatives were recorded in `negativePairs` so the recall guard is no longer vacuous. Pairs the two models disagree on are reported as a count.
- `suppress`: settled repeat dropped, open repeat kept, first-round claim never dropped.
- `disposition`: replay label snapshots are byte-identical after the extraction.
- `buildLedger`: a reply that declines settles; an author-resolved thread with no reply settles as `resolved`; a thread resolved by a non-decider does not; a collaborator's decline counts and a drive-by account's or another bot's does not; a reaction alone never settles.
- `buildReview`: settled repeat dropped; a KV-open prior finding the ledger shows settled does not force REQUEST_CHANGES; the verdict is recomputed when suppression removes the last fresh finding; zero findings left after a COMMENT or APPROVE returns null; zero findings left after a REQUEST_CHANGES posts an APPROVE; zero findings on a first review still approves; a ledger fetch error leaves the review intact with `ledger: cold`.
- `todaysCodePipeline`: through `replayFixture` and `checkRecall` on each of the six fixtures, with the per-fixture recycled count pinned.

## Known limits

- The decline and fix patterns are heuristics (`REJECTED` matches "already done" and "kept as is"). Sharing them with the replay labeler means the live path inherits their false positives. The snapshot tests catch changes, not existing errors.
- The fixtures' confirmed repeat pairs are the only recall evidence. Real-world false suppression is bounded by the high-confidence-only rule and the negative-pair guard. It is not proven absent.
- The matching rules were tuned on 21 classified candidate pairs and 44 confirmed repeat pairs from three PRs (six fixtures), and they are scored on the same fixtures. How well they generalize is unmeasured.
- Measured on the fixtures, the matcher joins all 14 classified repeats and none of the 7 classified distinct pairs. It joins 10 of the 29 confirmed repeat pairs whose earlier claim was settled, and suppresses 7 of the 14 recycled claims. It misses paraphrases that share no code identifier, reworded repeats more than 30 lines apart, same-file repeats whose title plus body similarity is below 0.25 (three confirmed pairs score 0.20 to 0.21), and general findings that name no code identifier.
- The nearest classified distinct pair is 0.05 below the body bar, 0.07 below the tier 1 title bar and 0.10 below the cross-surface overlap bar. One distinct pair, a missing-test finding about a defect, clears the overlap bar and is rejected only by the test-gap filter. That filter is an English title pattern and would also catch a defect title such as "case not covered by the switch".
- Restated findings that are still open are not suppressed here. The harness reports the count so sprints 3 and 4 can decide.
- The PR author is a decider even without write access. A fork author could clear the bot's blocking verdict by replying "won't fix" on every finding and pushing. This is accepted because the bot is advisory. Revisit it if the bot becomes a required reviewer on a public repository.
- The match rules were tuned on replay claim text, which is the posted comment: severity badge, title, body and suggestion markdown. Live findings pass the model's raw body. Live similarity scores therefore do not follow the measured distribution.
- A P0 finding is matched only by the title rules, with no identifier discount in tier 1. A reworded P0 repeat that only the body or identifier rules would join is posted again. The fixtures contain no P0 claims, so this rule changes none of the measured numbers.
