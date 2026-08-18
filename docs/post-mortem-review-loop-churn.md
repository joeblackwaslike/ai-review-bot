# Post-Mortem: Delegated Subagents Ran 8-10 Uncapped Review Rounds Against Fast Local Watchers (PRs #67/#68)

**Date:** 2026-08-18
**Duration:** ~2.5 hours of subagent + direct-session wall-clock, from the first
post-compaction review round (~05:11 UTC) to both PRs merging (06:36-06:38 UTC),
before Joe interrupted with "you've been running these prs for hours what is wrong
here? take a step back"
**Severity:** No incorrect code shipped and no data lost — both PRs' underlying fixes
were TDD-verified and correct throughout. The cost was entirely wasted time and
tokens: two delegated subagents independently ran 8-10 review-fix-repush rounds each
against a self-hosted, fast-polling review bot before a human had to intervene to
stop it.

---

## What Happened

This session picked up mid-flight (post-compaction) driving two already-open PRs —
#67 (`ai-review-bot-1f5`/`zm9`/`aou` bundled fixes) and #68 (`ai-review-bot-wt8`, the
Codex SSE-parsing fix) — through to merge, per standing instructions to own the whole
review loop rather than report PRs as done while still open (the prior incident this
same session had already filed `ai-review-bot-e8e` for).

Both PRs had local `ai-review watch` processes attached (`--interval 45-60s`),
substituting for hosted `anthropicreviewbot`/`codexreviewbot` review after the hosted
Anthropic/OpenAI account balances were exhausted. Two background subagents were
dispatched, one per PR, each instructed to triage every unresolved thread, apply real
TDD fixes, and push. Each push into the attached watcher triggered a fresh review
within 2-5 minutes; each fresh review found new (increasingly low-value) findings on
the code the subagent had just changed to satisfy the *previous* round; the subagent
fixed those too, and pushed again. Two watchers each produced 8-10 review rounds over
roughly two hours before the pattern was caught. The agent (both the delegated
subagents and, after resuming direct control, the top-level session) recognized
individual "stuck reviewer" and "diminishing returns" signals along the way and acted
on them locally (dismissing several stuck `anthropicreviewbot` reviews), but never
applied the loop-level guard that should have ended the whole cycle several rounds
earlier.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| ~05:11 | First visible review round this session (`anthropicreviewbot` against PR #67 commit `7e9082d`) — pre-existing from before context compaction. |
| ~05:20-05:26 | `codexreviewbot` reviews PR #67 three times in six minutes. |
| Session resumes | Finished an interrupted test-rewrite for PR #67 (exact-body dedup matching), pushed commit `2f66390`. |
| — | Dispatched two background subagents in parallel: `pr67-driver` (PR #67, worktree `watch-followup-bugs`) and `pr68-driver` (PR #68, worktree `watch-openai-sse`), each told to triage every unresolved thread and drive to mergeable. |
| 06:02-06:14 | `pr68-driver` round 1 completes (18 threads, 5 fixed) and discovers the root cause of `codexreviewbot`'s total silence on PR #68: the hosted `OPENAI_API_KEY` was out of credits. It launches its own local `--provider openai` watcher (PID 66021) as a substitute — this becomes the second fast-cycling watcher. |
| 06:14-06:22 | A second `anthropicreviewbot` round lands on PR #68 (8 more threads) while `pr68-driver` is still working; it's resumed with the new findings rather than paused. |
| 06:22-06:28 | A third round lands (10 more threads, all Low severity, several *confirming the fix is correct* while still nitpicking). The orchestrating session recognizes this explicitly as the runbook's "diminishing returns" signature and tells the subagent to do one final pass and **stop soliciting further rounds** — but does not cap or dismiss at this point, and a **fourth** round still lands anyway a few minutes later. |
| 06:28-06:32 | Orchestrating session takes over PR #68 directly (rather than a fifth subagent dispatch), fixes one more genuine finding (a real bug from advisory bot `greptile-apps`, plus a self-inflicted follow-up its own fix exposed), dismisses two stacked stuck `anthropicreviewbot` reviews with evidence, merges PR #68 at `7f84978` — but *before* dismissing, a **fifth** low-value round from the still-running watcher had already landed and had to be triaged too. |
| 06:23-06:33 (parallel) | `pr67-driver` independently runs a similar cycle: 90 total review threads handled across 7 fresh review passes, 9 stacked `anthropicreviewbot` reviews eventually dismissed as stuck. |
| ~06:33 | Joe interrupts: *"hey you've been running these prs for hours what is wrong here? take a step back."* |
| 06:33-06:36 | All four running local watcher processes killed. Both PRs' real state checked directly (no more polling). |
| 06:36:06 | PR #68 merged. |
| 06:38:40 | PR #67 merged. |

## Root Cause

**This was not a missing rule.** The `working-with-github` skill's
`driving-a-pr-to-approval.md` runbook already documents, in detail, exactly the
failure mode that occurred:

- A **max-iteration guard** ("Cap total iterations (or wall-clock, e.g. 20 passes /
  60 min). On hitting the cap, stop and hand off... never spin forever.")
- The specific **"diminishing returns" tells** this session actually observed —
  "Findings that state the code is *correct*... A finding with no defect in it is
  noise wearing a severity badge" — word for word the pattern both subagents and the
  orchestrating session independently noticed and named on PR #68's later rounds.
- The correct exit — "**The exit is a scope boundary, not a dismissal.** Fix what is
  substantive, answer and resolve the rest, and stop taking new cosmetic findings on
  code introduced *by review fixes* — file them as follow-ups instead."

Every piece of guidance needed to stop this at round 3-4 instead of round 8-10 was
already loaded (the skill is invoked at the start of PR-driving work per standing
instructions). It was applied locally and correctly *within* individual rounds — real
bugs were fixed, real stuck reviews were dismissed with evidence — but the
loop-level cap was never actually counted or enforced as a hard stop. Recognizing the
pattern was not the same as acting on it as a stop condition.

**Two compounding gaps let this happen despite the guidance existing:**

1. **The guard is written for a single loop instance, not delegation.** The runbook's
   prose assumes the engineer running the loop directly experiences the mounting
   round count and feels the cost. Delegating the loop to a background subagent
   breaks that feedback: the orchestrating session dispatched each subagent with a
   *goal* ("drive to mergeable") but never stated a *round cap* or *token budget* in
   the prompt, so nothing in the subagent's own instructions told it when 3 rounds of
   Low-severity self-confirming findings should become a stop condition rather than a
   47th `it()` block. The orchestrating session re-noticed the guidance's own
   diminishing-returns language partway through and manually told the subagent to
   stop — but by round 5-6, and had to repeat the instruction because the running
   watcher had already queued another round before the message landed.
2. **A local watcher's poll cadence was never weighed as a design variable.** The
   runbook already recommends "reviews every 60s for ~10 min" as a *polling* cadence
   for checking whether a review landed — it does not separately address what happens
   when the *reviewer itself* runs at that same cadence and a fix is pushed into it
   mid-iteration. A hosted webhook bot reviewing once per push, at human commit
   cadence, would not have produced this; a 45-60s local watcher reviewing every push
   from an agent capable of pushing every 2-3 minutes creates a review cycle faster
   than a human (or an agent applying human-paced judgment) can naturally break out
   of.

## Impact

- **Tokens:** four subagent dispatches consumed 257,027 + 281,057 + 289,116 (PR #68,
  three rounds) + 438,392 (PR #67, one dispatch spanning ~7 internal rounds) =
  **1,265,592 tokens**, not counting the orchestrating session's own direct-work
  tokens for the final rounds, dismissals, and merges.
- **Tool calls:** 147 + 184 + 197 (PR #68) + 230 (PR #67) = **758 tool calls** across
  the four dispatches.
- **Wall-clock:** subagent runtimes alone sum to ~149 minutes (1,585,453 +
  1,962,402 + 2,234,908 + 3,168,210 ms), though the two PRs' subagents ran
  concurrently; the visible session timeline spans roughly 05:11-06:38 UTC.
- **Review volume:** PR #67 accumulated 90 review threads across the session (32 in
  the first snapshot alone); PR #68 went through roughly 10 distinct review passes
  against 8 different head commits.
- **No incorrect code shipped.** Every substantive finding fixed was TDD-verified
  (RED before GREEN) before commit; both PRs merged with green CI and passing test
  suites (701 and 691 tests respectively). The entire cost was time and compute spent
  chasing a review bot that was, for most of those rounds, correctly confirming its
  own prior suggestions had already been applied while still finding something new
  and small enough to say.

## Fixes Shipped

**This document** — records the incident per this repo's post-mortem convention.

**`docs/post-mortem-review-loop-churn.md`'s companion instruction edits** (see
Prevention below) — the runbook already had the right content; the fix is closing the
gap between "documented" and "enforced when delegated," plus naming the local-watcher
cadence interaction explicitly so it's recognized as a contributing variable, not
just background noise.

## Prevention

- **State an explicit round cap in the delegation prompt, every time a PR-driving
  loop is handed to a subagent.** The orchestrating session must translate the
  runbook's "20 passes / 60 min" guard into the subagent's own instructions (e.g.
  "stop after 3 consecutive rounds where every finding is Low-severity or confirms a
  prior fix as correct — resolve what's real, decline the rest, and report back
  rather than continuing") rather than relying on the subagent to independently
  rediscover and apply loop-level guidance mid-task. A goal ("drive to mergeable")
  without a bound is an invitation to keep local judgment calls (each individually
  reasonable) from ever adding up to a stop.
- **Pause or kill an attached fast-poll local watcher before pushing a batch of
  review-response fixes, and only resume it for a final confirmation pass.** A
  60-90s poll loop that reviews every push races an agent's own fix-verify-push
  cadence; without an explicit pause, every fix becomes new diff for the next
  automatic round before the previous round's findings have even been fully replied
  to.
- **Treat the runbook's own "diminishing returns" tells as a hard stop the first time
  they're observed, not a signal to do "one more clean pass."** This session named
  the pattern correctly (self-confirming-correctness findings, severity inflation on
  comment wording) on PR #68's third round and still let two more rounds land before
  acting on it as an exit rather than a warning.

## Links

- Beads: `ai-review-bot-e8e` (the original "reported done prematurely" incident this
  session was remediating), `ai-review-bot-599` (follow-up ticket filed for this
  specific churn pattern before this post-mortem was written)
- PRs: [#67](https://github.com/joeblackwaslike/ai-review-bot/pull/67),
  [#68](https://github.com/joeblackwaslike/ai-review-bot/pull/68)
- Runbook: `working-with-github` skill,
  `references/howto/driving-a-pr-to-approval.md` § "Poll cadence, backoff, and
  guards" and § "When a reviewer can't be satisfied (dismiss + merge)" — already had
  the max-iteration guard and diminishing-returns language referenced throughout this
  doc; edited alongside this post-mortem to close the delegation and
  local-watcher-cadence gaps (see companion PR in `agent-skills`).
