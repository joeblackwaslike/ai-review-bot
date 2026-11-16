# Review deadline anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosted reviews never outlive the 300s function limit, because the agent deadline is measured from request start instead of from when agents start.

**Architecture:** A pure `agentDeadline` function takes the agent start, the configured budget and an optional request start, and returns `min(agentStart + budget, requestStart + 300s - 60s)`. Hosted handlers capture `requestStartedAtMs` on entry and pass it through `maybeSubmitReview` into `buildReview`. Local CLI callers pass nothing and keep today's behavior.

**Tech Stack:** TypeScript ESM, Vitest, Biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-15-review-deadline-anchor-design.md`

## Global Constraints

- `VERCEL_FUNCTION_LIMIT_MS` is 300000 and equals `maxDuration` for `api/github/**` in `vercel.json`.
- `FINISH_RESERVE_MS` is 60000: the 30s summary cap plus 30s for the POST, feedback writes and margin.
- `review.agentBudgetSeconds` (default 210) stays an upper cap on agent time.
- Local CLI paths (`review`, `audit`, `gate`, `watch`) get no request start and must not be capped.
- Reviews that fit today keep their full 210s: with 20s of setup the effective budget is still 210s.
- Log line `review setup done` with `setupMs` and `effectiveBudgetMs` at the point agents start.
- Repo conventions: named exports only, `.js` import extensions, no inline comments, tests colocated as `src/*.test.ts`, Conventional Commits. Gates before any PR: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Review Focus

- A request start more than 240s in the past returns a deadline already behind `agentStart`, so every agent is skipped and the run surfaces its failure instead of hanging.
- A request start in the future (clock skew) must not extend the budget past `agentStart + agentBudgetMs`.
- An inline-fallback delay of 90s anchored at handler entry shrinks the budget to 150s without `budgetAfterDelay`.
- An undefined request start returns exactly `agentStart + agentBudgetMs` (CLI paths).
- `vercel.json` `maxDuration` changing without the constant changing fails a test.

---

### Task 1: The deadline function

**Files:**
- Create: `src/review-deadline.ts`
- Test: `src/review-deadline.test.ts`

**Interfaces:**
- Produces: `VERCEL_FUNCTION_LIMIT_MS: number` (300000), `FINISH_RESERVE_MS: number` (60000), `agentDeadline(input: { agentStartMs: number; agentBudgetMs: number; requestStartedAtMs?: number }): number`.

- [ ] **Step 1: Write the failing tests** in `src/review-deadline.test.ts`, with `agentStartMs = 1_000_000` and `agentBudgetMs = 210_000`:
  - `returns agent start plus budget when no request start is known`: result is `1_210_000`.
  - `keeps the full budget when setup is fast`: `requestStartedAtMs = agentStartMs - 20_000` gives `1_210_000`.
  - `shrinks the budget by setup time that eats into the function limit`: `requestStartedAtMs = agentStartMs - 100_000` gives `agentStartMs + 140_000`.
  - `returns a deadline in the past when setup used more than the limit minus reserve`: `requestStartedAtMs = agentStartMs - 250_000` gives a value less than `agentStartMs`.
  - `ignores a request start in the future`: `requestStartedAtMs = agentStartMs + 100_000` gives `1_210_000`.
  - `matches maxDuration for api/github in vercel.json`: read `vercel.json` with `node:fs`, parse it, and assert `functions["api/github/**/*.ts"].maxDuration * 1000 === VERCEL_FUNCTION_LIMIT_MS`.
- [ ] **Step 2: Run** `pnpm vitest run src/review-deadline.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the two constants and `agentDeadline` in `src/review-deadline.ts`. With `requestStartedAtMs` undefined return `agentStartMs + agentBudgetMs`; otherwise return the `Math.min` of that and `requestStartedAtMs + VERCEL_FUNCTION_LIMIT_MS - FINISH_RESERVE_MS`.
- [ ] **Step 4: Run** `pnpm vitest run src/review-deadline.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(review): agentDeadline anchors the agent deadline to request start` (ref ai-review-bot-a9j).

---

### Task 2: Thread the request start through the hosted paths

**Files:**
- Modify: `src/review.ts` (context type near line 163, deadline at line 2605)
- Modify: `src/github-app.ts` (`budgetAfterDelay` at line 47, `maybeSubmitReview` at line 467 and its `buildReview` call at line 595, `runScheduledReview` at line 993, the two handlers in `registerHandlers` at lines 1038 and 1106, the inline fallback at lines 1089-1102)
- Modify: `api/github/review-run.ts` (the call at line 113)
- Test: `src/review.test.ts`, `src/github-app.test.ts` (remove the `budgetAfterDelay` describe block at line 2213)

**Interfaces:**
- Consumes: `agentDeadline` from Task 1.
- Produces: optional `requestStartedAtMs?: number` on the `buildReview` context, on the `maybeSubmitReview` args, and as a fourth parameter of `runScheduledReview(message, app, config, requestStartedAtMs?)`.

- [ ] **Step 1: Write the failing tests.**
  - In `src/review.test.ts`, mirroring the existing test for an exhausted agent budget: `skips every agent when the request started more than 240s ago`. Pass `requestStartedAtMs: Date.now() - 250_000` with `agentBudgetMs: 210_000`. Assert that no agent ran and the `agent skipped: review time budget exhausted` warning was logged.
  - Same file: `logs setup time and the effective budget when agents start`. Pass `requestStartedAtMs: Date.now() - 30_000`. Assert a `review setup done` log whose `setupMs` is at least 30000 and whose `effectiveBudgetMs` is at most 210000.
  - In `src/github-app.test.ts`: `passes requestStartedAtMs from runScheduledReview to buildReview`. Call `runScheduledReview` with a fourth argument of `1_700_000_000_000` and assert the mocked `buildReview` received that value as `requestStartedAtMs`.
  - Same file: `passes requestStartedAtMs from the issue_comment handler to buildReview`, using the existing handler-test pattern, asserting `requestStartedAtMs` is a number no later than `Date.now()`.
- [ ] **Step 2: Run** `pnpm vitest run src/review.test.ts src/github-app.test.ts`. Expected: the four new tests FAIL.
- [ ] **Step 3: Implement.**
  - Add `requestStartedAtMs?: number` to the `buildReview` context type in `src/review.ts` next to `agentBudgetMs`, and replace `const deadline = Date.now() + context.agentBudgetMs` at line 2605 with a call to `agentDeadline`. Log `review setup done` right after, with `setupMs` only when `requestStartedAtMs` is defined.
  - Add `requestStartedAtMs?: number` to the `maybeSubmitReview` args and forward it to `buildReview`.
  - Add the fourth parameter to `runScheduledReview` and forward it.
  - In `registerHandlers`, capture `const requestStartedAtMs = Date.now()` as the first statement of both the pull_request handler and the issue_comment handler, and pass it to every `maybeSubmitReview` call there. In the inline fallback pass `config` unchanged and delete `budgetAfterDelay` with its test block, since the anchored start already counts the sleep.
  - In `api/github/review-run.ts`, capture `Date.now()` as the first statement of the exported handler and pass it to `runScheduledReview`.
- [ ] **Step 4: Run** `pnpm vitest run src/review.test.ts src/github-app.test.ts src/review-deadline.test.ts`. Expected: PASS, then `pnpm typecheck && pnpm lint`. Expected: clean.
- [ ] **Step 5: Commit** `fix(review): count setup time against the agent deadline on hosted paths` (ref ai-review-bot-a9j).

---

### Task 3: Docs

**Files:**
- Modify: `src/config/schema.ts` (the `agentBudgetSeconds` description near line 238)
- Modify: `CLAUDE.md` (the `REVIEW_AGENT_BUDGET_SECONDS` sentence that says the clock starts after the PR/review fetches)
- Regenerate: `docs/configuration.md` with `pnpm docs:config`

- [ ] **Step 1: Update** the schema description and the CLAUDE.md sentence to say: agent time is capped by this budget and, on hosted paths, by 240s from request start (300s function limit minus a 60s reserve), so slow setup shortens the agent window.
- [ ] **Step 2: Run** `pnpm docs:config && pnpm config:check`. Expected: `docs/configuration.md` updated, check exits 0.
- [ ] **Step 3: Run** the full gate: `pnpm typecheck && pnpm lint && pnpm test`. Expected: all green.
- [ ] **Step 4: Commit** `docs(review): describe the request-anchored agent deadline` (ref ai-review-bot-a9j).
