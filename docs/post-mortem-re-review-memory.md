# Post-Mortem: Reviewer Re-Raised Rejected Findings Because It Has No Memory of Replies (stealth-browser#1, ai-listings#74, agent-skills#10)

**Date:** 2026-10-25
**Duration:** About 10 hours of wall-clock driving three PRs concurrently to merge, with the author's Claude Max 5-hour quota depleted several times and hours of downtime waiting for resets.
**Severity:** I found no evidence of incorrect code shipped, though I did not audit the merged diffs. The cost was time, quota, and roughly $10.76 of Claude-side review spend, most of it re-reviewing code the author had already answered. The review rounds stopped converging, and the author's merge comment on ai-listings#74 says so: "several were flaws in earlier fixes."
**Tracking:** bead `ai-review-bot-mcs` (this document). Fix design is a separate follow-up.
**Code references:** file and line citations are to `main` at `24ddef3`, the code live during the incident. PRs #82 and #83 landed afterward and moved some lines (for example the `reviewCount` assignment is now at `src/review.ts:2033`), so the source links below are permalinks to `24ddef3`, so they show the incident-era code.

---

## What Happened

Three PRs were open at once: [stealth-browser#1](https://github.com/joeblackwaslike/stealth-browser/pull/1) (about 8,400 lines, 58 files), [ai-listings#74](https://github.com/joeblackwaslike/ai-listings/pull/74) (deploy script and URL verification), and [agent-skills#10](https://github.com/joeblackwaslike/agent-skills/pull/10) (docs only). Both review bots ran on every push, and an implementer agent triaged each round's findings, fixed what it judged real, replied to the rest, and pushed again.

The Claude bot (`anthropicreviewbot`) raised the same findings round after round. Where the author replied "Intentional" or "No change", the finding came back anyway, once with its severity raised. Where the author fixed something, the next round sometimes called it unaddressed. The Codex bot (`codexreviewbot`) was mostly right on the same diffs, and several of its findings were real flaws in the author's earlier fixes. That is part of why the loop kept going: rounds had something real in them, buried under repeats.

Separately, the PR titles were renamed 13 times across the three PRs (5, 3, and 5). On stealth-browser#1 the first two renames came 34 and 36 seconds after a commit, and the others landed 4 to 6 minutes before a review. The bot does not rename titles. The renames came from the author's own identity, which matches the earlier finding that the no-mistakes `pr` step re-drafts the title each run. The title and body are passed into every reviewer prompt, so they are part of this incident (see Root Cause 6).

## Timeline

All times UTC, 2026-10-25. Cost is the figure in the review footer.

### stealth-browser#1, Claude bot

| Round | Review | Time | Delta reviewed | Body findings / inline comments | Agents failed | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5642732822 | 10:26 | whole PR, 8,427 lines | 13 / 13 | 2 of 9 | $1.87 |
| 2 | 5643315288 | 13:04 | 15 files, +204/-30 | 9 / 8 | 4 of 9 | $1.41 |
| 3 | 5644281193 | 17:12 | 3 commits, 24 files, +284/-66 | 4 / 6 | 1 of 9 | $2.17 |
| 4 | 5644679320 | 18:37 | 4 files, +27/-13 | 6 / 2 | 3 of 9 | $1.66 |

Every round carried a "Partial review" notice and every body carried `ai-review:review=1`. Codex reviewed the same SHAs 12 to 14 minutes after each Claude round and requested changes every time.

### ai-listings#74, Claude bot

| Round | Review | Time | Delta reviewed | Body findings / inline comments | Cost |
| --- | --- | --- | --- | --- | --- |
| 1 | 5642460754 | 09:24 | whole PR | 5 / 1 | $0.374 |
| 1b | 5643305588 | 13:01 | none (same SHA, manual re-run) | 8 / 0 | $0.426 |
| 2 | 5643675168 | 14:31 | 4 files, +57/-13 | 6 / 0 | $0.450 |
| 3 | 5644676595 | 18:37 | `deploy-app.sh`, +8/-3 | 9 / 2 | $0.457 |
| 4 | 5644813649 | 19:10 | `deploy-app.sh`, +5/-3 | 4 / 3 | $0.455 |

### agent-skills#10, Claude bot

| Round | Review | Time | Delta reviewed | Body findings / inline comments | Cost |
| --- | --- | --- | --- | --- | --- |
| 1 | 5642460295 | 09:24 | whole PR | 6 / 2 | $0.300 |
| 2 | 5642643009 | 10:02 | 2 files, +33/-43 | 4 / 0 | $0.259 |
| 2b | 5643306370 | 13:02 | none (same SHA, re-run) | 7 / 2 | $0.343 |
| 3 | 5644331647 | 17:22 | 2 files, +38/-29 | 4 / 0 | $0.231 |
| 4 | 5644676294 | 18:36 | 2 files, +5/-4 | 6 / 3 | $0.351 |

Codex totals for the two smaller PRs were $1.50 (ai-listings#74) and $1.22 (agent-skills#10). I did not total Codex spend on stealth-browser#1. Both bots also posted a `quota-exhausted-comment` at 09:22 to 09:25, then posted reviews anyway.

### Repeats the author had already answered

| Finding | Where | Author's answer | Came back |
| --- | --- | --- | --- |
| `Scheduler.inFlight` off-by-one | stealth `throttle.ts:59/66/76` | "Not off by one... the app test expects the 7th request to get 429" (12:58), repeated at 15:00 | Rounds 1, 2, 3, 4 (3, 3, 2, and 4 duplicate findings) |
| eBay `^Error Page` title regex too broad | stealth `detect.ts:13/14` | Fixed in `1a90c7f`, with a test | Round 3, "remains unaddressed" |
| `saveCapture` failures only warn-logged | stealth `app.ts:199/208` | "Intentional... No change." (12:58, 14:59) | Rounds 1, 2, 3 |
| Unconditional `kubectl rollout restart` | ai-listings `deploy-app.sh:152` | "Intentional. The Secret is rewritten on every deploy and pods only read it at startup" | Round 4, raised from P3 to P2 on a +5/-3 delta |
| Credential check does not gate the fetch | agent-skills `stealth-browser.md:31`, `SKILL.md:71` | Fixed in `af1a617`, then "No change" on repeats | Round 4, three times |

## Root Cause

Observed facts come first. Hypotheses are marked.

**1. Author replies and resolved threads never reach the agents.** Review comments are fetched in `src/cli.ts`, `src/feedback/persist.ts`, and `src/improve/*`, and nowhere in the review path ([src/review.ts](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/review.ts), [src/github-app.ts](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/github-app.ts)). The re-review prompt tells the agent to skip a finding "a maintainer reply already addresses" ([src/prompt.ts:87](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/prompt.ts#L87)), but no reply text is supplied, so the instruction has nothing to act on. Reactions, including the 😕 and 👎 that mark a finding as wrong or unclear, feed only the offline improvement loop.

**2. Cross-round memory is a list of titles.** Agents get `[status] severity - path:line - title` for each prior finding from KV state ([src/review-state.ts:5-12](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/review-state.ts#L5-L12), [src/prompt.ts:93-107](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/prompt.ts#L93-L107)). There is no rationale and no author response. The only code-level suppression applies to findings that triage marked resolved, matched by exact `path:line` or title ([src/review.ts:500-523](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/review.ts#L500-L523)). A finding that is still open, or that the author rejected, is never suppressed in code, even when an agent repeats it verbatim. Those repeats depend entirely on the model obeying "do not file any of these again", which Claude did not do on any of the five examples above.

**3. Findings that contradict themselves are posted.** `confidence` is a required schema field and nothing filters on it ([src/review.ts:273](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/review.ts#L273)). The only guard is prompt text ([src/prompt.ts:187-188](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/prompt.ts#L187-L188)). Round 3 of stealth-browser#1 listed "README-only PR body matches the diff; nothing to flag" as a finding, and several inline comments in rounds 1 and 2 conclude the code is consistent or matches the design.

**4. Every review says `review=1`, which points at state not being loaded on re-review rounds.** The counter itself works: `buildReview` passes the previous count and `saveReviewState` adds one when it writes ([src/review-state.ts:49-52](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/review-state.ts#L49-L52)), and the body shows the loaded count plus one. A round that loaded state saved by an earlier round would therefore say `review=2` or higher. All 14 Claude reviews in this incident say `review=1`, including round 4 of stealth-browser#1. An empty KV entry would not produce that. When a KV client exists but holds no entry, `loadReviewState` falls back to parsing the prior review body, including its `ai-review:review=N` marker and reviewed SHA ([src/review-state.ts](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/review-state.ts) `parsePriorReview`), so round 2 would still say `review=2` and the triage gate would still run. Every round said `review=1`, so the lookup was never called. That happens only when there is no KV client at all, or when the review is forced. A review is forced by `--force` in a comment, and also automatically by `ai-review watch` on the first cycle of every watcher process unless the current head was already reviewed ([src/watch.ts:286-320](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/watch.ts#L286-L320)).

The reviews in this incident ran locally through `ai-review watch`, not on the hosted deployment (the production build live that day was from 2026-08-30, before the readiness score and metadata block that these reviews carry, and the hosted bots were out of credits). The Upstash KV that this repo's credentials point to holds no `review-state:*` keys at all (a full scan returned zero), and no author comment used `--force`. The watcher builds its KV client from the environment variables it inherits ([src/feedback/kv.ts](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/feedback/kv.ts) `createUpstashKv`), and a missing client is only logged, not fatal. Two causes fit, and they are independent. First, the watchers may have had no KV client (no `KV_REST_API_URL` and `KV_REST_API_TOKEN` in their inherited environment). The empty KV supports this, because a forced review with a client would still have written state. Second, the watch workflow itself forces every restarted process: the runbook says to kill the watcher before pushing a batch of fixes and restart it afterward, and each fresh process forces its first cycle on a new head, which skips the state lookup even when KV is configured. The second cause is confirmed in code. Whether the first also happened is the working explanation for the empty KV, not a confirmed fact. With no state lookup, there was no triage gate, no scoped delta, and no structured prior-findings list. The agents still received the bot's previous review body as text, with the instruction to skip anything a maintainer reply addresses, but no reply text, so they could not tell which findings had been rejected. That accounts for the full-PR scans, the repeats, and the constant `review=1`. What I did not verify is the watcher processes' actual environment.

**5. A partial review is recorded as a complete one.** In stealth-browser#1, one to four of nine agents failed or were skipped every round. The saved state still moves `lastReviewedSha` to the new head ([src/review.ts:2025-2039](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/review.ts#L2025-L2039)), so the agents that never ran are treated as having reviewed that SHA.

**6. Round 3 of stealth-browser#1 reviewed the wrong thing.** The last commit (`493a82d5`) touched only the README. The delta since the last reviewed SHA also held the author's "second round of review findings" commit, 24 files and +278/-64. The bot's summary called the change "a genuine docs-only README edit" with "nothing new was fixed", said the tooling was "diffing against the full codebase", and posted six inline comments, all on older code the author had already answered. The author's replies list about ten fixes in that commit.

The agents see the PR title and body in every prompt ([src/prompt.ts:116-117](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/prompt.ts#L116-L117)), and the implementer had just rewritten both to describe the README commit. Round 3's own headline findings quote the body's docs-only claim. That makes the rewritten title and body the likely reason for the "docs-only" framing. The triage call that picks the review scope never sees the title or body (it gets only the delta diff, [src/triage.ts:62-75](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/triage.ts#L62-L75)), so the title does not explain why the round covered the full codebase. A cold start (cause 4) explains it: with no saved state there is no delta scoping, so every round covers the whole PR.

**7. Large PRs are partly invisible.** `trimPatch` cuts each file at 24,000 characters with a `[patch truncated]` marker and there is no cap on the whole PR ([src/prompt.ts:50-56](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/prompt.ts#L50-L56)). The agent is not told which regions are missing, while inline anchors are validated against the full patch.

**8. Hypothesis, not tested. The accuracy gap between providers may come from prompt compliance.** On adjudicated inline comments, Codex was right on 17 of 18 and Claude on 4 of 10. The samples are small and come from author replies, so treat the ratio as a direction. It matches the earlier corpus measurement (Anthropic findings right 9 of 42 times, OpenAI 39 of 47). The tuning flags are identical for both providers ([src/reviewer-tuning.ts:28-32](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/reviewer-tuning.ts#L28-L32)), so the difference is in the models or how they follow the "do not re-file" instruction. I have not tested either explanation.

**9. Hypothesis, not tested. Eight or nine agents on one diff overlap.** Same-SHA re-runs produced near-duplicate rows (three shell-injection variants on agent-skills#10 round 2b, two token-rollout variants on ai-listings#74 round 1b), and a tiny delta still yielded many findings (ai-listings#74 round 3, +8/-3, gave 9). Cross-agent dedupe within a round exists but is weak against rewording.

**The driver side amplified all of this.** Each round the implementer agent triaged 10 to 20 findings, fixed, replied, pushed, and re-polled, for three PRs at once, with no cap on rounds. The title rewrites fed back into reviewer prompts (cause 6). That behavior lives in the pr-loop and no-mistakes tooling, outside this repo.

## Impact

- **Rounds:** 14 Claude reviews and a matching number of Codex reviews across the three PRs, roughly 4 to 5 per PR.
- **Spend:** $7.11 on stealth-browser#1, $2.16 on ai-listings#74, $1.48 on agent-skills#10, $10.76 on the Claude side. Per-round cost on the large PR was $1.41 to $2.17 even though 1 to 4 of 9 agents failed each round.
- **Author time and quota:** about 10 hours, and the Max 5-hour quota was depleted several times, each time costing hours of waiting.
- **Real defects were also found and fixed**, including by Codex, so the rounds were not pure waste.

## Open Questions

- **Were `KV_REST_API_URL` and `KV_REST_API_TOKEN` exported in the shells that launched the watchers (cause 4)?** The `review=1` footers show the state lookup never ran, which the restart-forces-cycle-1 behavior explains by itself. The empty shared KV additionally points to a missing client, but I did not see the watcher processes' environment. Either cause would also explain why stealth-browser#1 round 3 scanned the whole codebase. Production logs for that run are not retained.
- **How many times was each watcher restarted?** The watchers' start times are not recorded in anything I read. Shell history or process logs would show whether each round came from a fresh process.
- **Did the local reviews draw on the Max plan quota?** `ai-review watch` uses local subscription auth, so the review calls themselves, not only the implementer agent, likely counted against the 5-hour quota. I did not measure this.
- **Do the agents emit filler under pressure to produce output?** Findings like "No new findings beyond prior reviews" and "No code changes this round" appear in agent-skills#10. I found no direct evidence of a minimum-output instruction.

## What This Does NOT Fix

Fixing memory and dedupe makes the reviewer stop repeating itself. It does not make the 9-agent fan-out accurate on a first pass, and it does not change the fact that large PRs get truncated patches. It also does not cap how many rounds an implementer agent will run, which is a driver-side change.

## Prevention

These are candidate directions. None is designed or scoped yet.

- Give agents the author's reply and the thread's resolved or outdated status for each prior finding, plus 😕 and 👎 reactions, as a per-finding record of why it was rejected.
- Persist rejected and answered findings with a normalized claim key (the existing `isSameClaim` in [src/claim-dedupe.ts](https://github.com/joeblackwaslike/ai-review-bot/blob/24ddef3/src/claim-dedupe.ts) is a starting point) and drop matches in code regardless of line or wording, including repeats of findings that are merely open. Never raise severity on a repeat.
- Add a post-filter that drops findings whose own text says there is no defect, that the code matches the design, or that nothing needs to change.
- Stop `ai-review watch` from forcing the first cycle of a restarted process when a prior review of the PR exists on GitHub, so a restart is no longer a cold start.
- Stop depending on KV for review memory in local runs. Either keep per-PR state in a local file keyed by repo and PR, or rebuild prior findings and the author's replies from GitHub itself (review comments, threads, reactions), which would fix cold starts and the invisible-replies problem together. Also log or show in the footer whether a round started warm or cold. Separately, stop advancing `lastReviewedSha` past agents that did not complete.
- On re-review rounds, scope strictly to the delta, and either stop passing the PR title and body or mark them as author-written and possibly stale.
- Add a per-round dollar cap and a round cap, in the bot and in the pr-loop driver.
- Driver side: stop the no-mistakes `pr` step from re-drafting titles on every run, and make the round cap part of the delegation prompt (tracked outside this repo).

Any fix to the reviewer has to be verified without relying on the reviewer, because it may not converge on its own fixes. The plan is to replay the real repeated findings listed above as fixtures against the new suppression and filter logic, write each behavior test first and watch it fail, and limit bot review of the fix PR to one local pass whose findings are each checked against the code by hand.

## Links

- Beads: `ai-review-bot-mcs` (this incident); `ai-review-bot-599` and `docs/post-mortem-review-loop-churn.md` cover the earlier runaway-watcher incident, which is a different failure
- PRs: [stealth-browser#1](https://github.com/joeblackwaslike/stealth-browser/pull/1), [ai-listings#74](https://github.com/joeblackwaslike/ai-listings/pull/74), [agent-skills#10](https://github.com/joeblackwaslike/agent-skills/pull/10)
- Round 3 review examined in detail: [pullrequestreview-5644281193](https://github.com/joeblackwaslike/stealth-browser/pull/1#pullrequestreview-5644281193)
- Related docs: [post-mortem-reviewer-hallucinations.md](post-mortem-reviewer-hallucinations.md), [post-mortem-review-loop-churn.md](post-mortem-review-loop-churn.md), [state-aware incremental review design](superpowers/specs/2026-06-17-review-state-aware-incremental-review-design.md)
