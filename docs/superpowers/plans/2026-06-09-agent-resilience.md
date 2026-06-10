# Review-Agent Rate-Limit Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the review agents survive provider rate limits so large PRs reliably get reviewed — via working prompt caching, sequential execution, header-aware pacing, and an actionable fallback comment.

**Architecture:** All changes are in the provider-agnostic review pipeline (`src/review.ts` + a tiny config + a fallback in `src/github-app.ts`), so both bots and the CLI audit benefit. `runAgent` gains cache-control on a shared content part (so agents 2–N read the diff free of ITPM) and surfaces cache + rate-limit telemetry. `buildReview`/`runAuditPass` run agents through a concurrency-capped runner (default 1) that paces off the rate-limit headers. A total rate-limit failure posts a comment with the concrete reset time instead of silently doing nothing.

**Tech Stack:** TypeScript ESM, Vitest, Vercel AI SDK (`ai@6`, `@ai-sdk/anthropic`/`@ai-sdk/openai`), Octokit. Spec: [docs/superpowers/specs/2026-06-09-agent-resilience-design.md](../specs/2026-06-09-agent-resilience-design.md). Beads: `ai-review-bot-c4k`.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/review.ts` | modify | `runAgent` cache-control + telemetry; new `RateLimitInfo`/`AgentOutcome` types; `extractRateLimit()`; concurrency-capped runner; `buildReview` uses runner + pacing + rate-limit detection |
| `src/concurrency.ts` | create | `mapWithConcurrency()` — small generic bounded-concurrency runner (one responsibility, unit-testable) |
| `src/audit.ts` | modify | `runAuditPass` uses the same runner |
| `src/config.ts` | modify | `agentConcurrency` (env `AGENT_CONCURRENCY`, default 1) |
| `src/github-app.ts` | modify | `maybeSubmitReview` posts the actionable rate-limit fallback comment |
| `src/review.test.ts`, `src/concurrency.test.ts`, `src/config.test.ts`, `src/github-app.test.ts` | modify/create | Tests |

**Shared types (in `src/review.ts`):**

```typescript
export interface RateLimitInfo {
	/** uncached input tokens remaining this minute, if the header was present */
	inputTokensRemaining?: number;
	/** RFC3339 instant when the input-token budget replenishes */
	inputTokensResetAt?: string;
	/** seconds to wait, from a 429 retry-after header */
	retryAfterSeconds?: number;
}

export type AgentOutcome =
	| { status: "ok"; review: ModelReview; usage: TokenUsage; rateLimit?: RateLimitInfo }
	| { status: "rate_limited"; rateLimit: RateLimitInfo }
	| { status: "error" };
```

> Note: `generateObject` is deprecated in AI SDK v6 in favor of `generateText` + `Output.object`, but it still works. Migrating it is **out of scope** — keep `generateObject`.

---

## Task 1: `runAgent` — cache the shared context + surface telemetry

This is Part 1 (caching) + the telemetry that Parts 3–4 consume. Today `runAgent` sends a plain `system` string and `messages:[{role:'user', content: userMessage}]` with no `providerOptions` (so nothing caches). Restructure to a two-part user message: a cache-controlled **shared** block (the PR-context+diff, identical across agents) first, then the per-skill block.

**Files:**
- Modify: `src/review.ts` (`runAgent`, ~124-152; add `RateLimitInfo`/`AgentOutcome`/`extractRateLimit`)
- Test: `src/review.test.ts`

- [ ] **Step 1: Write the failing test**

`src/review.test.ts` already mocks `./prompt.js` and `./models.js`. Add (or extend) a mock of `ai`'s `generateObject` and a test. Append:

```typescript
// at top with other vi.mock calls
vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { runAgent } from "./review.js";
import type { ModelSelection } from "./router.js";
import { buildModelReview } from "./testing.js";

const sel = { provider: "anthropic", model: "claude-sonnet-4-6", tier: 1 } as ModelSelection;

describe("runAgent caching + telemetry", () => {
	it("sends the shared block first with ephemeral cacheControl and the skill block second", async () => {
		(generateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
			object: buildModelReview({ event: "COMMENT", general_findings: [], inline_comments: [] }),
			usage: { inputTokens: 10, outputTokens: 5 },
			providerMetadata: { anthropic: { cacheCreationInputTokens: 2000, cacheReadInputTokens: 0 } },
			response: { headers: { "anthropic-ratelimit-input-tokens-remaining": "28000" } },
		});

		const out = await runAgent("code-reviewer.md", "SHARED_DIFF_CONTEXT", sel, "custom");

		const call = (generateObject as ReturnType<typeof vi.fn>).mock.calls[0][0];
		const parts = call.messages[0].content;
		expect(call.messages[0].role).toBe("user");
		expect(parts[0].text).toBe("SHARED_DIFF_CONTEXT");
		expect(parts[0].providerOptions.anthropic.cacheControl).toEqual({ type: "ephemeral" });
		expect(parts[1].text).toContain("SYS"); // skill block from the mocked buildAgentSystemPrompt
		expect(out?.status).toBe("ok");
	});

	it("returns status rate_limited with retryAfter on a 429", async () => {
		const err = Object.assign(new Error("429"), {
			statusCode: 429,
			responseHeaders: { "retry-after": "42", "anthropic-ratelimit-input-tokens-reset": "2026-06-09T07:21:30Z" },
		});
		(generateObject as ReturnType<typeof vi.fn>).mockRejectedValue(err);

		const out = await runAgent("code-reviewer.md", "SHARED", sel, "");
		expect(out?.status).toBe("rate_limited");
		if (out?.status === "rate_limited") {
			expect(out.rateLimit.retryAfterSeconds).toBe(42);
			expect(out.rateLimit.inputTokensResetAt).toBe("2026-06-09T07:21:30Z");
		}
	});
});
```

The existing `review.test.ts` mocks `./prompt.js` so `buildAgentSystemPrompt` returns a string containing `SYS` — keep that. If it returns something else, adjust the `toContain` accordingly.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/review.test.ts`
Expected: FAIL — `runAgent` returns the old shape / no cacheControl on parts.

- [ ] **Step 3: Implement in `src/review.ts`**

Replace `runAgent` and add the types + helper. The `RateLimitInfo` / `AgentOutcome` types go near the top exports.

```typescript
import { APICallError } from "@ai-sdk/provider";

export interface RateLimitInfo {
	inputTokensRemaining?: number;
	inputTokensResetAt?: string;
	retryAfterSeconds?: number;
}

export type AgentOutcome =
	| { status: "ok"; review: ModelReview; usage: TokenUsage; rateLimit?: RateLimitInfo }
	| { status: "rate_limited"; rateLimit: RateLimitInfo }
	| { status: "error" };

function readRateLimitHeaders(headers: Record<string, string> | undefined): RateLimitInfo {
	const h = headers ?? {};
	const remaining = h["anthropic-ratelimit-input-tokens-remaining"] ?? h["x-ratelimit-remaining-tokens"];
	const reset = h["anthropic-ratelimit-input-tokens-reset"] ?? h["x-ratelimit-reset-tokens"];
	const retryAfter = h["retry-after"];
	return {
		inputTokensRemaining: remaining !== undefined ? Number(remaining) : undefined,
		inputTokensResetAt: reset,
		retryAfterSeconds: retryAfter !== undefined ? Number(retryAfter) : undefined,
	};
}

/** Walk a thrown error (possibly a RetryError wrapping APICallError) for a 429. */
function extractRateLimit(err: unknown): RateLimitInfo | null {
	const candidates: unknown[] = [err, (err as { lastError?: unknown })?.lastError, ...((err as { errors?: unknown[] })?.errors ?? [])];
	for (const c of candidates) {
		const status = (c as { statusCode?: number })?.statusCode;
		if (status === 429 || (APICallError.isInstance?.(c) && (c as APICallError).statusCode === 429)) {
			return readRateLimitHeaders((c as { responseHeaders?: Record<string, string> })?.responseHeaders);
		}
	}
	return null;
}

export async function runAgent(
	skillPath: string,
	sharedContext: string,
	selection: ModelSelection,
	customPrompt: string,
): Promise<AgentOutcome> {
	const skillBlock = buildAgentSystemPrompt(skillPath, customPrompt);
	try {
		const { object, usage, providerMetadata, response } = await generateObject({
			model: createAIModel(selection),
			schema: ModelReviewSchema,
			maxOutputTokens: 4096,
			maxRetries: 4,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: sharedContext,
							providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
						},
						{ type: "text", text: skillBlock },
					],
				},
			],
		});

		const anthro = (providerMetadata?.anthropic ?? {}) as { cacheReadInputTokens?: number; cacheCreationInputTokens?: number };
		console.log("agent ok", {
			skillPath,
			cacheRead: anthro.cacheReadInputTokens ?? 0,
			cacheCreation: anthro.cacheCreationInputTokens ?? 0,
		});

		return {
			status: "ok",
			review: object,
			usage: { promptTokens: usage.inputTokens ?? 0, completionTokens: usage.outputTokens ?? 0 },
			rateLimit: readRateLimitHeaders(response?.headers as Record<string, string> | undefined),
		};
	} catch (err) {
		const rl = extractRateLimit(err);
		if (rl) {
			console.warn("agent rate-limited", { skillPath, ...rl });
			return { status: "rate_limited", rateLimit: rl };
		}
		console.error("Agent threw during generateObject", { skillPath, err });
		return { status: "error" };
	}
}
```

> Caching note: the shared block is the first content part and identical across all agents in a review (the same `sharedContext` string is passed to every agent), and the structured-output schema (the implicit tool) is identical too — so the cached prefix is shared and agents 2–N return `cacheReadInputTokens > 0`. `providerOptions.anthropic` is ignored by the OpenAI provider (which auto-caches long prefixes), so this is safe for both providers.

- [ ] **Step 4: Update `buildReview`'s collection to the new outcome shape**

In `buildReview` (~565-590), the loop currently treats `runAgent` results as `{review,usage}|null`. Update the settle/collection to the `AgentOutcome` union (this is finished properly in Task 3, but make it compile now):

```typescript
// minimal compile-fix; Task 3 replaces the runner
const settled = await Promise.allSettled(
	allSkills.map(({ skillPath }) => runAgent(skillPath, userMessage, selection, customPrompt)),
);
const agentResults: ModelReview[] = [];
for (const r of settled) {
	if (r.status === "fulfilled" && r.value.status === "ok") {
		agentResults.push(r.value.review);
		totalPromptTokens += r.value.usage.promptTokens;
		totalCompletionTokens += r.value.usage.completionTokens;
	}
}
```

Apply the same `.status === "ok"` adjustment to `runAuditPass` in `src/audit.ts` so the suite stays green.

- [ ] **Step 5: Run tests**

Run: `npm run test -- src/review.test.ts && npm run typecheck`
Expected: PASS. (`@ai-sdk/provider` is already a transitive dep via the AI SDK; if `APICallError` import fails, import it from `ai` instead — verify with `npm run typecheck`.)

- [ ] **Step 6: Commit**

```bash
git add src/review.ts src/review.test.ts src/audit.ts
git commit -m "feat(review): wire prompt caching on shared context + agent telemetry (closes part 1 of c4k caching)"
```

---

## Task 2: `AGENT_CONCURRENCY` config

**Files:**
- Modify: `src/config.ts` (`AppConfig` + both `getConfig`/`getOpenAIAppConfig`)
- Test: `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/config.test.ts (append)
import { getConfig } from "./config.js";

describe("agentConcurrency", () => {
	it("defaults to 1 and parses AGENT_CONCURRENCY", () => {
		delete process.env.AGENT_CONCURRENCY;
		expect(getConfig().agentConcurrency).toBe(1);
		process.env.AGENT_CONCURRENCY = "3";
		expect(getConfig().agentConcurrency).toBe(3);
		delete process.env.AGENT_CONCURRENCY;
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/config.test.ts`
Expected: FAIL — `agentConcurrency` missing.

- [ ] **Step 3: Implement**

In `src/config.ts`: add `agentConcurrency: number;` to `AppConfig`, and in BOTH `getConfig()` and `getOpenAIAppConfig()` add:

```typescript
agentConcurrency: Math.max(1, Number(process.env.AGENT_CONCURRENCY ?? "1")),
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/config.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): AGENT_CONCURRENCY (default 1)"
```

---

## Task 3: Bounded-concurrency runner + sequential fan-out (Part 2)

**Files:**
- Create: `src/concurrency.ts`, `src/concurrency.test.ts`
- Modify: `src/review.ts` (`buildReview`), `src/audit.ts` (`runAuditPass`)

- [ ] **Step 1: Write the failing test**

```typescript
// src/concurrency.test.ts
import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
	it("limit 1 runs strictly sequentially, preserving order", async () => {
		const active: number[] = [];
		let peak = 0;
		const out = await mapWithConcurrency([1, 2, 3], 1, async (n) => {
			active.push(n);
			peak = Math.max(peak, active.length);
			await new Promise((r) => setTimeout(r, 1));
			active.pop();
			return n * 10;
		});
		expect(out).toEqual([10, 20, 30]);
		expect(peak).toBe(1);
	});

	it("respects a higher limit and still returns input order", async () => {
		const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n + 100);
		expect(out).toEqual([101, 102, 103, 104]);
	});

	it("runs an onEach hook between items (for pacing)", async () => {
		const seen: number[] = [];
		await mapWithConcurrency([1, 2], 1, async (n) => n, { onBeforeEach: (i) => { seen.push(i); } });
		expect(seen).toEqual([0, 1]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/concurrency.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/concurrency.ts`**

```typescript
export interface MapOptions {
	/** Called with the item index just before its worker starts — use for pacing/sleep. */
	onBeforeEach?: (index: number) => Promise<void> | void;
}

/** Run `fn` over `items` with at most `limit` concurrent workers; results keep input order. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
	opts: MapOptions = {},
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(limit, items.length || 1));

	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			if (opts.onBeforeEach) await opts.onBeforeEach(i);
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(Array.from({ length: width }, () => worker()));
	return results;
}
```

- [ ] **Step 4: Use it in `buildReview` and `runAuditPass`**

In `src/review.ts` `buildReview`, replace the `Promise.allSettled` block (from Task 1 Step 4) with:

```typescript
import { mapWithConcurrency } from "./concurrency.js";

const outcomes = await mapWithConcurrency(allSkills, context.agentConcurrency ?? 1, async ({ skillPath }, i) => {
	const t0 = Date.now();
	const outcome = await runAgent(skillPath, userMessage, selection, customPrompt);
	console.log("agent done", { idx: i + 1, total: allSkills.length, skillPath, status: outcome.status, ms: Date.now() - t0 });
	return outcome;
});

const agentResults: ModelReview[] = [];
const rateLimited: RateLimitInfo[] = [];
for (const o of outcomes) {
	if (o.status === "ok") {
		agentResults.push(o.review);
		totalPromptTokens += o.usage.promptTokens;
		totalCompletionTokens += o.usage.completionTokens;
	} else if (o.status === "rate_limited") {
		rateLimited.push(o.rateLimit);
	}
}
```

> `buildReview`'s `context` must carry `config` (it already receives `commentPrefix`, `provider`, etc. via `ReviewContext`). Add `agentConcurrency: number` to `ReviewContext` and pass `config.agentConcurrency` from `maybeSubmitReview`'s `buildReview({...})` call. If threading the whole config is cleaner, add `agentConcurrency` to the existing context object — match the existing pattern.

In `src/audit.ts` `runAuditPass`, replace its `Promise.allSettled(TIER1_SKILLS.map(...))` with the same `mapWithConcurrency(TIER1_SKILLS, concurrency, ...)`, reading concurrency from `process.env.AGENT_CONCURRENCY` (the CLI has no AppConfig) defaulting to 1, and collecting `o.status === "ok"`.

- [ ] **Step 5: Run the full suite**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS (update any existing `buildReview`/`runAuditPass` tests that asserted on the old `{review,usage}|null` shape to the new outcome union).

- [ ] **Step 6: Commit**

```bash
git add src/concurrency.ts src/concurrency.test.ts src/review.ts src/audit.ts
git commit -m "feat(review): sequential concurrency-capped agent fan-out + timing logs"
```

---

## Task 4: Adaptive pacing between agents (Part 3)

Use the rate-limit headers from the previous agent to decide whether to sleep before the next one. Bounded so we never exceed the function budget.

**Files:**
- Modify: `src/review.ts` (pacing helper + wire into the `onBeforeEach` hook)
- Test: `src/review.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/review.test.ts (append)
import { computePaceDelayMs } from "./review.js";

describe("computePaceDelayMs", () => {
	const now = Date.parse("2026-06-09T07:20:00Z");
	it("returns 0 when plenty of tokens remain", () => {
		expect(computePaceDelayMs({ inputTokensRemaining: 25000 }, now)).toBe(0);
	});
	it("waits until reset when remaining is below the floor", () => {
		const d = computePaceDelayMs(
			{ inputTokensRemaining: 500, inputTokensResetAt: "2026-06-09T07:20:08Z" },
			now,
		);
		expect(d).toBeGreaterThan(0);
		expect(d).toBeLessThanOrEqual(8000);
	});
	it("honors retry-after and caps the wait", () => {
		expect(computePaceDelayMs({ retryAfterSeconds: 9999 }, now)).toBe(60000); // capped
	});
	it("returns 0 for undefined info", () => {
		expect(computePaceDelayMs(undefined, now)).toBe(0);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/review.test.ts -t computePaceDelayMs`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `src/review.ts`**

```typescript
const PACE_TOKEN_FLOOR = 5000; // below this many remaining input tokens, wait for reset
const PACE_MAX_WAIT_MS = 60_000; // never sleep longer than this between agents

export function computePaceDelayMs(rl: RateLimitInfo | undefined, nowMs: number): number {
	if (!rl) return 0;
	if (rl.retryAfterSeconds && rl.retryAfterSeconds > 0) {
		return Math.min(rl.retryAfterSeconds * 1000, PACE_MAX_WAIT_MS);
	}
	if (rl.inputTokensRemaining !== undefined && rl.inputTokensRemaining < PACE_TOKEN_FLOOR) {
		const resetMs = rl.inputTokensResetAt ? Date.parse(rl.inputTokensResetAt) : nowMs + 1000;
		return Math.min(Math.max(0, resetMs - nowMs), PACE_MAX_WAIT_MS);
	}
	return 0;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
```

Wire it into the runner in `buildReview`: track the most recent `RateLimitInfo` and pace before each subsequent agent. Replace the `mapWithConcurrency` call body so it threads `lastRateLimit`:

```typescript
let lastRateLimit: RateLimitInfo | undefined;
const outcomes = await mapWithConcurrency(
	allSkills,
	context.agentConcurrency ?? 1,
	async ({ skillPath }, i) => {
		const t0 = Date.now();
		const outcome = await runAgent(skillPath, userMessage, selection, customPrompt);
		if (outcome.status === "ok") lastRateLimit = outcome.rateLimit;
		else if (outcome.status === "rate_limited") lastRateLimit = outcome.rateLimit;
		console.log("agent done", { idx: i + 1, total: allSkills.length, skillPath, status: outcome.status, ms: Date.now() - t0 });
		return outcome;
	},
	{
		onBeforeEach: async (i) => {
			if (i === 0) return; // nothing learned yet
			const delay = computePaceDelayMs(lastRateLimit, Date.now());
			if (delay > 0) {
				console.log("pacing before next agent", { idx: i + 1, delayMs: delay });
				await sleep(delay);
			}
		},
	},
);
```

> Pacing only meaningfully helps at concurrency 1 (sequential). With a higher cap it's best-effort. That's fine — default is 1.

- [ ] **Step 4: Run tests**

Run: `npm run test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/review.test.ts
git commit -m "feat(review): header-aware pacing between agents (sleep-until-reset, bounded)"
```

---

## Task 5: Actionable rate-limit fallback comment (Part 4)

When **zero** agents succeeded and at least one was rate-limited, surface an actionable comment with the reset time instead of silently failing.

**Files:**
- Modify: `src/review.ts` (`buildReview` returns a rate-limit signal), `src/github-app.ts` (`maybeSubmitReview` posts the comment)
- Test: `src/review.test.ts`, `src/github-app.test.ts`

- [ ] **Step 1: Write the failing test (review side)**

Reuses the `ai` mock from Task 1 (`vi.mock("ai", …)`) and the file's existing `./prompt.js` mock. A minimal octokit returns no existing reviews and no files, so all five Tier-1 agents run and (mocked) reject with a 429 → zero successes, all rate-limited → `RATE_LIMITED`.

```typescript
// src/review.test.ts (append)
import { buildReview } from "./review.js";

describe("buildReview rate-limit decision", () => {
	it("returns a RATE_LIMITED decision with the reset time when every agent 429s", async () => {
		const err = Object.assign(new Error("429"), {
			statusCode: 429,
			responseHeaders: { "retry-after": "42", "anthropic-ratelimit-input-tokens-reset": "2026-06-09T07:21:30Z" },
		});
		(generateObject as ReturnType<typeof vi.fn>).mockRejectedValue(err);

		const octokit = {
			request: vi.fn(async (route: string) =>
				route.includes("/reviews") ? { data: [] } : { data: {} },
			),
			paginate: vi.fn(async () => []),
		};

		const decision = await buildReview({
			octokit: octokit as never,
			owner: "o", repo: "r", pullNumber: 1, headSha: "sha",
			title: "t", body: null, additions: 0, deletions: 0, changedFiles: 0,
			labels: [], commentPrefix: "ai-review-bot", extraInstructions: "",
			force: true, provider: "anthropic", agentConcurrency: 1,
		});

		expect(decision?.event).toBe("RATE_LIMITED");
		expect(decision?.rateLimitResetAt).toBe("2026-06-09T07:21:30Z");
	});
});
```

Add `"RATE_LIMITED"` to the `ReviewDecision["event"]` union, add optional `rateLimitResetAt?: string` / `rateLimitRetryAfterSeconds?: number` to `ReviewDecision`, and add `agentConcurrency: number` to `ReviewContext` (Task 3 already references it).

- [ ] **Step 2: Implement in `src/review.ts`**

After collecting `outcomes` in `buildReview`, before the existing `if (agentResults.length === 0) throw ...`:

```typescript
if (agentResults.length === 0 && rateLimited.length > 0) {
	const worst = rateLimited.reduce((a, b) => ((b.retryAfterSeconds ?? 0) > (a.retryAfterSeconds ?? 0) ? b : a));
	return {
		event: "RATE_LIMITED",
		body: "",
		comments: [],
		metadata: { model: selection.model, tier1Count: TIER1_SKILLS.length, tier2Skills: [], generalFindings: 0, inlineComments: 0, cost: 0 },
		validLinesByPath: new Map(),
		rateLimitResetAt: worst.inputTokensResetAt,
		rateLimitRetryAfterSeconds: worst.retryAfterSeconds,
	};
}
```

Keep the existing `throw new Error("All review agents failed …")` for the non-rate-limit total failure.

- [ ] **Step 3: Implement the comment in `src/github-app.ts`**

In `maybeSubmitReview`, right after `const review = await buildReview({...})` and the `if (!review) return;` guard, handle the new event before the normal `postReviewWithRetry`:

```typescript
if (review.event === "RATE_LIMITED") {
	const when = review.rateLimitResetAt
		? `resets at ${review.rateLimitResetAt}`
		: review.rateLimitRetryAfterSeconds
			? `retry in ~${review.rateLimitRetryAfterSeconds}s`
			: "will reset shortly";
	const body = `⚠️ **[${config.reviewCommentPrefix}]** Review couldn't run — the model is rate-limited (input-token budget). Budget ${when}. Push again after that, or it will auto-retry on your next commit.`;
	await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
		owner, repo, issue_number: pullNumber, body,
	});
	console.log("posted rate-limit fallback comment", { owner, repo, pullNumber, when });
	return;
}
```

> A `RATE_LIMITED` decision is explicitly **not** an APPROVE and posts no review object — only the comment.

- [ ] **Step 4: Write the github-app test**

`github-app.test.ts` already `vi.mock("./review.js")`. Make `buildReview` return a `RATE_LIMITED` decision and assert the comment.

```typescript
// src/github-app.test.ts (append)
import { buildReview } from "./review.js";
import { maybeSubmitReview } from "./github-app.js";

it("posts an actionable rate-limit comment and no review on RATE_LIMITED", async () => {
	(buildReview as ReturnType<typeof vi.fn>).mockResolvedValue({
		event: "RATE_LIMITED", body: "", comments: [], validLinesByPath: new Map(),
		metadata: { model: "claude-sonnet-4-6", tier1Count: 5, tier2Skills: [], generalFindings: 0, inlineComments: 0, cost: 0 },
		rateLimitResetAt: "2026-06-09T07:21:30Z",
	});
	const requests: Array<{ route: string; params: Record<string, unknown> }> = [];
	const octokit = {
		request: vi.fn(async (route: string, params: Record<string, unknown>) => {
			requests.push({ route, params });
			return { data: {} };
		}),
	};
	const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;

	await maybeSubmitReview({
		app, installationId: 1, owner: "o", repo: "r", pullNumber: 7,
		pullRequest: { draft: false, head: { sha: "sha" }, additions: 0, deletions: 0, changed_files: 0, title: "t", body: null },
		extraInstructions: "", force: true,
		config: { reviewEnabled: true, reviewCommentPrefix: "ai-review-bot" } as never,
	});

	const comment = requests.find((r) => r.route.includes("/issues/{issue_number}/comments"));
	expect(comment?.params.body).toContain("2026-06-09T07:21:30Z");
	expect(requests.some((r) => r.route.includes("/pulls/{pull_number}/reviews"))).toBe(false);
});
```

- [ ] **Step 5: Run the full suite + gates**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/review.ts src/github-app.ts src/review.test.ts src/github-app.test.ts
git commit -m "feat(review): actionable rate-limit fallback comment with reset time (no silent no-review)"
```

---

## Self-review checklist (run after all tasks)

- Spec Part 1 (caching) → Task 1; Part 2 (sequential) → Tasks 2–3; Part 3 (pacing/retry) → Task 1 (`maxRetries`) + Task 4; Part 4 (fallback) → Task 5. ✓
- `AgentOutcome` union used consistently in `runAgent`, `buildReview`, `runAuditPass`.
- `RateLimitInfo` field names match across `runAgent`/`computePaceDelayMs`/the fallback.

## Manual verification

- After deploy (and the operational tier raise), run a large PR; in Vercel prod logs confirm: `agent ok … cacheCreation>0` on the first agent and `cacheRead>0` on the rest, `agent done` timing lines in series, no 429 cascade, a posted review. Confirm the **Anthropic dashboard cache rate** moves 0% → non-zero.
- Force a rate limit (temporarily tiny tier or a forced 429 in a scratch deploy) → confirm the **fallback comment with a concrete reset time** appears instead of silence, and it is not an APPROVE.
- Confirm both `/api/github/webhook` and `/api/github/webhook-openai` behave identically.
