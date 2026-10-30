# Claude first-pass accuracy design

Date: 2026-10-29
Bead: `ai-review-bot-w9b.3`
Context: sprint 4 of the review-accuracy epic (`ai-review-bot-w9b`). Shared decisions are in the [epic spec](2026-10-27-review-accuracy-epic-design.md). Measures come from the [replay harness](2026-10-27-review-replay-harness-design.md). The hypotheses come from cause 8 and "What This Does NOT Fix" in [the post-mortem](../../post-mortem-re-review-memory.md).

## Intent

Sprints 1 to 3 stopped the reviewer from repeating itself. On the six replay fixtures the remaining non-convergence is new findings every round, and most of the Claude findings the author answered were rejected. Before anything is tuned, we need to know what kind of wrong those findings are. Then we fix the biggest kind, and only if we can show the fix removes rejected findings without removing fixed ones.

## Goals

- Classify every first-seen Claude finding that the author rejected, into stale, speculative, contradicted, filler, or other, with counts per class and the number classified.
- Report how often two independent labelers agree, and how many items they disagree on.
- Fix the largest class that a heuristic can detect, with a before and after on the replay harness and on the capped live tier.
- Say which parts were measured and which were not.

## Non-goals

- Sprint 5 (Vercel parity), sprint 6 (no-mistakes adapter), and the pre-existing defects in `ai-review-bot-4ez`.
- Changing the set of review agents or skills, except where the classification shows one is the cause.
- Tuning prompts or thresholds before the classification exists.
- Any change to Codex's reviewer.

## Anti-goals

- A filter whose margin is a guess. A heuristic that removes one rejected finding and one fixed finding is not a win.
- Sending label review to Joe. Disagreements between the two labelers are reported as a count.
- A classification built from a sample and described as the whole set.

## What the data holds today

Counted from the committed Claude fixtures on `origin/main` (90b3aca).

| Fixture | Labeled | Fixed | Rejected | Unadjudicated |
| --- | --- | --- | --- | --- |
| agent-skills#10 | 34 | 10 | 22 | 2 |
| ai-listings#74 | 40 | 3 | 10 | 27 |
| stealth-browser#1 | 65 | 4 | 29 | 32 |
| Total | 139 | 17 | 61 | 61 |

Only 79 of the 139 labels have high confidence. Those 61 rejected labels include 15 claims that repeat an earlier claim. The classification covers the other 46 first-seen rejected claims (17 in agent-skills#10, 5 in ai-listings#74, 24 in stealth-browser#1), because repeats are already measured as recycling. 46 is a small sample, so counts are reported as k of 46 and never as bare percentages.

The first look at the rejected claims shows many "body" findings from agent-skills#10 with titles like "No new findings beyond prior reviews" and "Docs-only PR, no executable tests applicable". That points to a large filler class, but I read titles and did not count. The classification decides.

Agent logs: `~/.ai-review/logs/agents.jsonl` and the `ai-review:agents` marker started with PR #91. The log file does not exist on this machine. None of the Claude reviews on the three incident PRs carry the marker, and PR #91 has no Claude bot reviews. So none of the six partial reviews can have its cause read from the logs. The report says this and does not guess.

## The classes

One class per claim. The first rule that matches wins, so counts add up to the number classified.

1. Filler. The finding's own text says nothing is wrong or nothing was found: "no new findings", "nothing to flag", "matches the design", "no change this round". Decided from the finding text alone. No author reply is needed, so two labelers can agree without seeing the thread.
2. Stale. The finding is about code that was already changed or fixed before the round's cutoff. Evidence is one of: the thread was already outdated at the cutoff, or an author reply cites a fix whose commit predates the reviewed head. A commit that touches the anchored lines in the round's own delta is not evidence, because the reviewer is meant to review changed lines. Expect this class to be small, since a review runs against the head it names. The cutoff is the time the reviewed head was pushed, as the harness spec defines it.
3. Contradicted. The code at the reviewed head or the author's reply shows the claim is wrong, with a stated reason: "intentional", "by design", "not off by one, the test expects the seventh request to get a 429". A bare "no change" with no reason is not enough, because it also covers deferrals.
4. Speculative. The finding hedges ("may", "could", "might not") and names no concrete input, path, or line in the diff that fails. No stronger class applies.
5. Other. Rejected, and none of the above. Reported as its own count and never folded into another class.

How `src/replay/label.ts` feeds this. A claim enters the classification only when its label is `rejected`. High-confidence rejected labels come from an author reply the ledger's `classifyReplies` recognized. Low-confidence rejected labels come from a 😕 or 👎 alone, with no reply. Those are classified from the finding text and the diff metadata, and the report flags them as reaction-only. `fixed` labels are not classified; they are the set the fix must never remove. `unadjudicated` claims are counted and left out.

The classifier works on posted findings, so it can see the finding text, its anchor, the round's commit metadata, and the thread. It cannot see the diff body, which fixtures do not store. "Stale" therefore relies on hunk ranges and thread state, and the report says so.

## Who classifies

A rejected label is the author's verdict, not proof the finding was wrong. The classes describe why authors rejected findings, and the report says so.

- Filler and stale get deterministic rules in `src/replay/classify.ts`. Filler is a phrase list checked against the claim title and text. Stale uses the thread's `isOutdated`, the hunk ranges, and reply text. These rules are tested, and their output is the first labeler.
- The phrase list is tuned on two fixtures and scored on the third, rotating through all three, so the reported rule accuracy is not measured on the data it was fitted to.
- A Claude subagent labels all five classes for every claim, reading the claim, its thread, and the commit metadata. It does not see the deterministic result.
- `codex:codex-rescue` labels the same claims blind, from the same inputs.
- Agreement is reported as k of n between the two model labelers, and separately between the deterministic rules and each model for the two classes the rules cover.
- A claim the two model labelers classify differently is `unadjudicated`. Its count is reported. It is not sent to Joe and it is not counted toward any class.
- Labels are provisional until Codex has cross-checked them. The report states which it is.

## What the live tier can measure

`runLiveTier` re-runs the reviewer on a recorded round and matches findings to recorded claims only through confirmed repeat pairs. Everything else is "new, unlabeled".

It can cheaply count how many live findings fall in the class the fix targets, before and after the fix, on the same rounds and within the cost cap. A text-only class such as filler can be classified on live output without a thread. It can also check whether live findings that match confirmed fixed claims still appear after the fix.

It cannot measure the false-positive rate of new live findings, because they have no author verdict, so no live accuracy figure is claimed. Live runs vary, so one before and one after is a direction, not a result.

The sprint's cost cap is `--max-cost 6`. The estimate prints before the run, and the run stops at the cap.

## Choosing the fix

The fix is chosen after the classification exists, by this rule.

- Rank the classes by count among classified claims.
- A class is fixable if a rule over the finding (text, anchor, confidence, hedging, round delta) can detect it without the author's reply. Filler is fixable. Speculative is fixable only if the hedging rule separates it from fixed findings. Stale is fixable only if the round delta is available at filter time. Contradicted is mostly author judgment and is not fixable by heuristic unless the same reply pattern recurs on the same claim, which the ledger already handles.
- Ship the largest fixable class. If the largest class is not fixable, say so with the numbers and ship the next fixable class, or ship no heuristic.
- The offline margin has two numbers. Removals that hit a rejected claim in the class. Removals that hit a fixed claim, which must be zero. A removal that hits an unadjudicated claim is reported and not counted as a win.
- If the margin is thin (for example, fewer than ten class members, or any removal of a fixed claim), no heuristic ships. The sprint then ships the classification and a recommendation.

If filler wins, the likely fix is a deterministic post-filter in the merge path that drops findings whose own text says there is no defect. This is the third prevention bullet in the post-mortem. It is a guess until the counts exist.

## Constraints

- TypeScript ESM, Vitest, Biome, named exports only, `.js` suffixes, tests colocated with source.
- pnpm and Bun only. Implementers run no installs and use scoped biome fixes.
- Every behavior test is written first and seen failing. The red output is quoted in the task report.
- The recall guard and `negativePairs` must keep passing. The replay stays green.
- Anything that reads or writes GitHub review state is checked against stealth-browser#1, ai-listings#74, and agent-skills#10, and test fakes assert the request shape.
- Classification files are committed beside the fixtures and state whether they are provisional.

## Verification

- A table of counts per class, the number classified out of the rejected total, the number left out and why.
- Labeler agreement as k of n, and the unadjudicated count.
- The fix's before and after on `ai-review replay` and on `ai-review replay --live --max-cost 6`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- A statement of what was not measured: the 61 unadjudicated claims, rounds with approximate diffs, the small sample, and the live tier's inability to score new findings.

## Left to the builder

- The phrase list and hedge list for the deterministic rules, tuned against the fixtures and tested.
- The classification file schema and the report layout.
- Where in the merge path a post-filter sits, if one ships.

## Calls I made, for review

- Classes are mutually exclusive with a fixed precedence.
- Disagreement means unadjudicated, and the count is the output.
- The sprint cost cap is $6.
- A fix ships only with zero removals of fixed claims.
