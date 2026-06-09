# Design Spec — Review-Agent Rate-Limit Resilience

**Date:** 2026-06-09
**Status:** Approved design, pre-implementation
**Author:** Joe Black (with Claude)
**Beads:** relates to `ai-review-bot-15v`

---

## Context & evidence

Production Vercel logs (`claude-review-bot.vercel.app`, `--environment production`, the `eabdef3` synchronize window) showed both bots failing **at the AI-provider layer**, not the webhook layer:

- **Claude bot:** `runAgent` (src/review.ts:133) → `generateObject` threw `RetryError: Failed after 3 attempts … This request would exceed your organization's rate limit of **30,000 input tokens per minute** (model: claude-sonnet-4-6)`, then `All review agents failed`. `buildReview` throws, `maybeSubmitReview` throws, and `waitUntil(...).catch` only logs it → **silent no-review**.
- **Codex bot:** same `runAgent` path threw `RetryError: … You exceeded your current quota` (OpenAI `insufficient_quota`).

The webhook architecture is fine: `res.status(202)` is sent immediately, work runs in `waitUntil` under `maxDuration: 800`, and the `delaying review by 450s` log confirms the delay + function both run to completion.

**Root cause:** `buildReview` fans out **5+ Tier-1 agents in parallel** (`Promise.allSettled`), **each sending the full diff**. Anthropic Tier-1 Sonnet 4.x ITPM is exactly **30,000** ([rate-limits docs](https://platform.claude.com/docs/en/api/rate-limits)), so a large diff × N parallel agents bursts past it and every agent 429s.

**Key lever (from the rate-limits doc):** `cache_read_input_tokens` **do NOT count toward ITPM** for Sonnet 4.x (only Haiku 3.5 is the `†` exception). `cache_creation_input_tokens` + `input_tokens` do. So if the shared diff is a **cached prefix**, the first agent pays it once and every other agent reads it free for rate-limit purposes.

This is all in `src/review.ts` / `src/prompt.ts`, which are **provider-agnostic** (only `createAIModel` branches on provider) — so every fix below applies to **both** the Claude and Codex bots, and to the CLI audit path (`runAuditPass`) which fans out the same way.

## Goals

- Big PRs reliably get reviewed under a low (Tier-1) provider rate limit.
- No silent failures — a rate-limited review surfaces an **actionable** message telling the user when to retry.
- Same fix covers both providers and both the webhook-review and CLI-audit fan-outs.

## Non-goals

- Raising the provider tiers / fixing OpenAI billing — operational, owner-handled.
- Diff chunking for single diffs that exceed the per-minute limit in one request — future.
- Changing the webhook/delay architecture — it works.

---

## Design

### 1. Cache the shared diff as a prefix (primary lever)

Caching is **prefix-based** (`tools → system → messages`). Today the per-agent **system** varies (`buildAgentSystemPrompt(skill)`) and the shared **diff** is the user message — so the diff sits *after* the divergent prefix and can't be shared across agents.

**Restructure** so the shared content is the cached prefix and the per-skill content follows:

- A shared **context block** = PR metadata + full diff (identical bytes for every agent in a review), marked `cache_control: { type: "ephemeral" }`.
- The per-skill **framework + output rules** come *after* that block.

Then agent 1 writes the diff to cache (`cache_creation`, counts toward ITPM once); agents 2–N read it (`cache_read`, **free for ITPM**). For a big-diff review this cuts ITPM-counted input ~N×.

- Touches `src/prompt.ts` (compose a shared cached block + a per-skill block) and `src/review.ts` `runAgent` (pass `cache_control` via the AI SDK's Anthropic `providerOptions`).
- Applies to both `buildUserMessage` (PR review) and `buildAuditUserMessage` (CLI audit).
- The shared block is normally ≫1024 tokens (caching's minimum); tiny diffs that don't cache also don't hit limits. Default 5-minute TTL; if sequential execution of many agents risks exceeding 5 min, use the 1-hour TTL knob.
- **Exact AI SDK syntax** for `cacheControl` provider options, reading `response.headers`, and the typed rate-limit error is verified during planning via `agent-skills:web-research` / context7 (AI SDK v6 + `@ai-sdk/anthropic` docs).

### 2. Sequential (concurrency-capped) agent execution

Replace the all-at-once `Promise.allSettled(allSkills.map(runAgent))` in `buildReview` (and `runAuditPass`) with a **concurrency-limited runner**, default **1** (fully sequential), configurable via `AGENT_CONCURRENCY`.

- Guarantees agent 1 warms the diff cache before the rest read it → **one** diff write, not N racing writes.
- Spreads the small per-agent remainder across time → stays under ITPM.
- Preserves today's fault tolerance: failures are collected, successful agents still merge (partial review). Only a **total** failure triggers the fallback (part 4).
- Emit **per-agent timing logs** so we can measure sequential wall-clock and then trim `REVIEW_DELAY_SECONDS`.
- Future optimization (out of scope): "warm-then-parallel" — run agent 1 alone, then the rest concurrently since their reads are ITPM-free.

### 3. Rate-limit-aware pacing + retry

- **Retry:** bump the AI SDK `maxRetries` (it already does exponential backoff and honors the 429 `retry-after` header). Residual/transient 429s self-heal.
- **Adaptive pacing (your "sleep and recheck"):** capture rate-limit headers from each agent response — Anthropic `anthropic-ratelimit-input-tokens-remaining` / `anthropic-ratelimit-input-tokens-reset` (RFC3339); OpenAI `x-ratelimit-remaining-tokens` / `x-ratelimit-reset-tokens`. Between agents, if `remaining` is below a threshold for the next request, **sleep until the reset** and recheck, **bounded** by the function's remaining `maxDuration` budget. If the wait would exceed the budget, stop and hand off to part 4 with the concrete reset time.
- A 429 carries `retry-after` directly; capture it for the pacing/fallback decision.

### 4. No silent failures — actionable fallback

When a review can't complete because **all** agents were rate-limited (today `buildReview` throws and the throw is swallowed by `waitUntil(...).catch`):

- Catch the rate-limit-total-failure case and post a **fallback PR comment** that includes the **concrete wait time** from `retry-after` / `…-reset`, e.g.:
  > ⚠️ **[ai-review-bot]** Review couldn't run — the model is rate-limited (Tier-1 input-token budget). Budget resets at **07:21:30Z (~95s)**. Push again after that, or it'll auto-retry on your next push.
- Distinguish this from "agents ran and found nothing" (which stays a normal APPROVE/COMMENT). A rate-limit failure is **not** an approval.
- Reuse the existing fallback-comment plumbing in `maybeSubmitReview` (currently only fires on a failed review **POST**); extend it to the failed-**buildReview** case carrying the reset time.

---

## Components touched

| Unit | File | Change |
|---|---|---|
| Prompt composition | `src/prompt.ts` | Split shared (PR+diff, cached) vs per-skill (framework+rules) content for both review & audit messages |
| Agent call | `src/review.ts` `runAgent` | Pass `cache_control` provider option; bump `maxRetries`; return rate-limit headers + any 429 reset |
| Fan-out | `src/review.ts` `buildReview`, `src/audit.ts` `runAuditPass` | Concurrency-capped sequential runner; adaptive pacing; collect partial successes; detect total rate-limit failure |
| Config | `src/config.ts` | `AGENT_CONCURRENCY` (default 1); optional pacing thresholds |
| Fallback | `src/github-app.ts` `maybeSubmitReview` | Post actionable rate-limit comment on total failure with reset time |

## Error handling

- **Partial failure:** some agents succeed → merge + post the partial review (preserve current behavior).
- **Total rate-limit failure:** post the actionable fallback comment; do not APPROVE.
- **Non-rate-limit agent errors:** logged per-agent as today; don't abort the others.
- **Budget exhaustion** (sleep would exceed `maxDuration`): bail to the fallback comment with the reset time rather than letting the function time out.

## Testing

Vitest, mocking the AI SDK (as today). Cover:
- **Concurrency runner:** sequential ordering; partial-failure still merges; total-failure surfaces.
- **Prompt structure:** the shared cached block is byte-identical across skills; per-skill content differs after it.
- **Pacing:** with an injected clock/sleep + stubbed headers, low `remaining` triggers a bounded sleep-until-reset; budget-exceeding wait bails.
- **Fallback comment:** contains the concrete reset time; a rate-limit total failure is not APPROVE.
- Provider-agnostic: a parallel OpenAI-error case exercises the same path.

Quality gates (CLAUDE.md): `npm run typecheck && npm run lint && npm run test` green.

## Rollout

1. Concurrency-capped sequential runner + `AGENT_CONCURRENCY` + per-agent timing logs (immediate ITPM relief).
2. Shared-diff prefix caching (the big lever).
3. Adaptive pacing + `maxRetries` bump.
4. Actionable fallback comment.
5. Measure sequential wall-clock from the timing logs → trim `REVIEW_DELAY_SECONDS` default.

## Verification

- Re-run a large PR through the bot (after the operational tier raise) and confirm via Vercel logs: one `cache_creation` diff write, subsequent agents showing `cache_read`, no 429 cascade, a posted review.
- Force a rate limit (low `AGENT_CONCURRENCY` aside, or a tiny test tier) and confirm the **actionable fallback comment** with a real reset time appears instead of silence.
- Confirm both `/api/github/webhook` and `/api/github/webhook-openai` paths behave identically (shared code).
