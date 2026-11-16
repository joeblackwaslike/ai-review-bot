# Anchor the agent deadline to request start

Bead: ai-review-bot-a9j

## Why

On 2026-11-15 at 19:48 a manual `/ai-review` on agent-skills#39 ran the Gemini reviewer on the inline webhook path. Vercel killed the function at its 300s limit. No review and no error comment were posted, because a platform kill skips the bot's failure path.

The agent deadline is `Date.now() + agentBudgetMs`, set at `src/review.ts:2605` after the PR, file, ledger and override fetches. Setup time is outside the budget. The default budget is 210s, so setup plus the 30s summary cap (`SUMMARY_TIMEOUT_MS`), the review POST and the feedback writes all have to fit in the remaining 90s of a 300s function. On a 40-file PR with a slow model they did not.

A late-starting deadline is the leading hypothesis for the kill, not a confirmed finding. The logs showed no abort line before it, which fits, but no setup timing was logged. This change adds that timing, so the next slow run confirms or rules the hypothesis out.

## Goals

- A review on a hosted path never runs past the function limit. When time is short it posts a partial review or an error comment.
- `review.agentBudgetSeconds` keeps its meaning as an upper cap on agent time.
- Setup time is logged on every hosted review.

## Non-goals

- Changing models, tiers or per-agent timeouts.
- Moving manual commands to QStash. That gives no extra time, because `api/github/**` has the same 300s cap.
- Local CLI paths (`review`, `audit`, `gate`, `watch`). They have no function limit and must not get one.

## Anti-goals

- A fix that shortens agent time for every review when setup is fast. Reviews that fit today must keep their full 210s.

## Approaches

- **A. Anchor to request start (chosen).** Record the start time at handler entry and derive the deadline from it.
- **B. Lower the default budget to about 150s.** One line, but blind. It cuts every review and still fails when setup is slow enough.
- **C. Route manual commands through QStash.** The callback has the same 300s cap, so a slow round gets no more time.

## Design

- A hosted handler records `startedAt = Date.now()` on entry: the issue_comment and pull_request webhook handlers, and `review-run`. It passes `startedAt` down through `maybeSubmitReview` / `runScheduledReview` into the review context. Local CLI callers leave it unset.
- One pure function computes the deadline: `min(agentStart + agentBudgetMs, startedAt + VERCEL_FUNCTION_LIMIT_MS - RESERVE_MS)`. With `startedAt` unset it returns the old value.
- `VERCEL_FUNCTION_LIMIT_MS` is 300000. `RESERVE_MS` is 60000: the 30s summary cap plus 30s for the POST, feedback writes and margin.
- With 20s of setup, the deadline is `min(210s, 220s)`, which is today's 210s. With 100s of setup it is `min(210s, 140s)`, which is 140s.
- The inline fallback that sleeps before reviewing is counted automatically once `startedAt` is anchored at handler entry. `budgetAfterDelay` becomes redundant. The builder removes it if nothing else uses it.
- A log line `review setup done { setupMs, effectiveBudgetMs }` is written when agents start.
- When the effective budget is too small to start any agent, the existing path applies: agents skip, and the failure is surfaced on the PR.

## Tests

- The pure function: setup time shrinks the budget, the cap still wins when setup is fast, and unset `startedAt` returns the old deadline.
- A test pins `VERCEL_FUNCTION_LIMIT_MS` to `maxDuration` for `api/github/**` in `vercel.json`, so the two cannot drift.

## Verification

After deploy, run `/ai-review` on a large PR with Gemini. The logs show `setupMs`, and the run ends with a posted review or an error comment, never a silent kill. If `setupMs` is small and a run is still killed, the cause is elsewhere (for example a call that ignores the abort signal), and this change is not the fix.

## Left to the builder

The exact threading of `startedAt` through the handlers, and whether `RESERVE_MS` needs tuning after the first logged runs.
