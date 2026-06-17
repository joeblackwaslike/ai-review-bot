# QStash Review Scheduler (PR2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-process `setTimeout` review delay (which burns the 800s Vercel function budget doing nothing, killing 8-agent reviews mid-run) with a QStash delayed callback, so the delay costs zero function time and the review runs fresh with the full budget. Re-enable Tier 2 once the budget is freed.

**Architecture:** On a `pull_request` event the webhook publishes a delayed QStash message to a new `/api/github/review-run` endpoint and returns immediately. QStash invokes that endpoint after the delay; it verifies the Upstash signature, drops the message if the PR head has moved on (coalescing via staleness check), and runs `maybeSubmitReview` with the full 800s budget. The `issue_comment /ai-review` path stays direct (no delay), as today.

**Tech Stack:** TypeScript ESM, Vitest, `@upstash/qstash` (`Client` + `Receiver`), Octokit, Vercel functions. Named exports only; `.js` import extensions; Biome.

**Spec:** `docs/superpowers/specs/2026-06-17-review-state-aware-incremental-review-design.md`
**Branch:** `feat/qstash-review-scheduler` (created; off `main` after #21 merged)
**Epic bead:** `ai-review-bot-9nv` · **PR bead:** `ai-review-bot-27t`

---

## Design decisions (read before coding — two real footguns)

1. **`deduplicationId` does NOT cancel a pending delayed message.** It only drops a *duplicate of the same message* within a window. So it cannot "replace the older SHA's pending review." **Coalescing is done by a head-SHA staleness check at callback time:** the message body carries the head SHA that was current at publish; `/api/github/review-run` fetches the PR's *current* head and **no-ops if it differs** (a newer push superseded this one). `deduplicationId = {provider}:{pr}:{headSha}` is still set, but only to dedup GitHub webhook *redeliveries* of the same push — not for cross-push coalescing. The existing per-`(pr,headSha)` idempotency claim inside `maybeSubmitReview` remains the last line of defense against double-review.

2. **The publish URL and the verify URL must be byte-identical** — QStash signs the destination URL into the JWT `sub` claim, and `Receiver.verify({url})` checks it. Derive both from a single configured `PUBLIC_URL` (the stable production origin, e.g. `https://ai-review-bot.vercel.app`), NOT from per-request host headers (which differ between preview/prod and would break verification). Publish to `${PUBLIC_URL}/api/github/review-run`; verify against the same string.

3. **Delay is in seconds** (`publishJSON({ delay: 300 })`). Reuse `selectReviewDelayMs(action, config)` / 1000.

4. **Graceful degradation:** if QStash is not configured (`QSTASH_TOKEN` absent), fall back to today's behavior — run the review inline after the in-process delay — so the bot still works without QStash. Never silently drop a review.

---

## File Structure

- **Create `src/scheduler.ts`** — `scheduleReview(args)` (QStash `publishJSON` with delay + deduplicationId, or `null` when unconfigured), `verifyQStashSignature(body, signature)` (wraps `Receiver.verify`), `reviewRunCallbackUrl()`. One responsibility: the QStash transport.
- **Create `src/scheduler.test.ts`** — publish args, unconfigured→null, signature verify pass/fail.
- **Create `api/github/review-run.ts`** — Vercel function: read raw body, verify Upstash signature, parse `ReviewRunMessage`, staleness-check head SHA, dispatch to `maybeSubmitReview` for the right provider. Mirrors the structure of `api/github/webhook.ts`.
- **Modify `src/github-app.ts`** — the `pull_request` handler in `registerHandlers`: publish a QStash message instead of `sleep` + inline review (fallback to inline when QStash unconfigured). Export a `runScheduledReview(message, app, config)` helper the endpoint calls.
- **Modify `src/config.ts`** — add `qstashToken`, `qstashCurrentSigningKey`, `qstashNextSigningKey`, `publicUrl` to `AppConfig` (+ both config builders); flip `tier2Enabled` default → `process.env.REVIEW_TIER2_ENABLED !== "false"` (ON unless explicitly disabled).
- **Modify `src/config.test.ts`** — tier2 default flip; QStash fields parsed.
- **Modify `.env.example`, `CLAUDE.md`, `vercel.json`** — document `QSTASH_*` + `PUBLIC_URL`; register the new function's `maxDuration: 800`.

---

## Task 1: Config — QStash keys + flip Tier 2 default ON

**Files:** `src/config.ts`, `src/config.test.ts`

- [ ] **Step 1: failing tests** (add to `src/config.test.ts`; add the new keys to the `afterEach` cleanup array)

```typescript
describe("qstash + publicUrl config", () => {
	it("parses QStash keys and PUBLIC_URL", () => {
		setRequiredEnv({
			QSTASH_TOKEN: "qs-tok",
			QSTASH_CURRENT_SIGNING_KEY: "cur",
			QSTASH_NEXT_SIGNING_KEY: "nxt",
			PUBLIC_URL: "https://example.test",
		});
		const c = getConfig();
		expect(c.qstashToken).toBe("qs-tok");
		expect(c.qstashCurrentSigningKey).toBe("cur");
		expect(c.qstashNextSigningKey).toBe("nxt");
		expect(c.publicUrl).toBe("https://example.test");
	});
	it("leaves QStash fields undefined when unset (graceful fallback)", () => {
		setRequiredEnv();
		expect(getConfig().qstashToken).toBeUndefined();
	});
});

describe("tier2Enabled default (PR2 flips it ON)", () => {
	it("defaults to TRUE now that QStash frees the budget", () => {
		setRequiredEnv();
		delete process.env.REVIEW_TIER2_ENABLED;
		expect(getConfig().tier2Enabled).toBe(true);
	});
	it("is false only when explicitly REVIEW_TIER2_ENABLED=false", () => {
		setRequiredEnv({ REVIEW_TIER2_ENABLED: "false" });
		expect(getConfig().tier2Enabled).toBe(false);
	});
});
```

> Note: PR1's existing tier2 tests assert the *old* default-OFF semantics — UPDATE them to the new default-ON (`!== "false"`) rather than leaving them contradictory.

- [ ] **Step 2: run, expect FAIL.** `npx vitest run src/config.test.ts --pool=forks --reporter=basic`

- [ ] **Step 3: implement** in `src/config.ts`:
  - Add to `interface AppConfig`: `qstashToken?: string; qstashCurrentSigningKey?: string; qstashNextSigningKey?: string; publicUrl?: string;`
  - Change `tier2Enabled` in BOTH builders to: `tier2Enabled: process.env.REVIEW_TIER2_ENABLED !== "false",`
  - Add to BOTH builders: `qstashToken: process.env.QSTASH_TOKEN, qstashCurrentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY, qstashNextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY, publicUrl: process.env.PUBLIC_URL,` (use `firstNonBlank`-style or raw `process.env` to match the file's existing optional-string handling — match how other optional strings are read).
  - Update the PR1 tier2 tests to the new default.

- [ ] **Step 4: run, expect PASS.**
- [ ] **Step 5: commit** `feat(config): add QStash keys + PUBLIC_URL; default Tier 2 ON`

---

## Task 2: `scheduler.ts` — QStash publish + signature verify

**Files:** `src/scheduler.ts` (new), `src/scheduler.test.ts` (new)

First: `npm install @upstash/qstash` (add to dependencies). Confirm it lands in `package.json`.

- [ ] **Step 1: failing tests** (mock `@upstash/qstash`)

```typescript
import { describe, expect, it, vi } from "vitest";

const publishJSON = vi.hoisted(() => vi.fn());
const verify = vi.hoisted(() => vi.fn());
vi.mock("@upstash/qstash", () => ({
	Client: vi.fn(() => ({ publishJSON })),
	Receiver: vi.fn(() => ({ verify })),
}));

import { scheduleReview, verifyQStashSignature } from "./scheduler.js";

const cfg = {
	qstashToken: "tok",
	qstashCurrentSigningKey: "cur",
	qstashNextSigningKey: "nxt",
	publicUrl: "https://example.test",
} as never;

const msg = { provider: "anthropic", owner: "o", repo: "r", pullNumber: 7, headSha: "abc", action: "synchronize", installationId: 1 };

describe("scheduleReview", () => {
	it("publishes a delayed JSON message to the review-run URL with a per-head dedup id", async () => {
		publishJSON.mockResolvedValueOnce({ messageId: "m1" });
		const out = await scheduleReview(cfg, msg, 300);
		expect(out).toEqual({ messageId: "m1" });
		expect(publishJSON).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.test/api/github/review-run",
				body: msg,
				delay: 300,
				deduplicationId: "anthropic:7:abc",
			}),
		);
	});
	it("returns null when QStash is unconfigured (caller falls back to inline)", async () => {
		const out = await scheduleReview({ ...cfg, qstashToken: undefined } as never, msg, 300);
		expect(out).toBeNull();
		expect(publishJSON).not.toHaveBeenCalled();
	});
});

describe("verifyQStashSignature", () => {
	it("returns true on a valid signature", async () => {
		verify.mockResolvedValueOnce(true);
		expect(await verifyQStashSignature(cfg, "raw-body", "sig")).toBe(true);
		expect(verify).toHaveBeenCalledWith({ body: "raw-body", signature: "sig", url: "https://example.test/api/github/review-run" });
	});
	it("returns false when verify throws or rejects", async () => {
		verify.mockRejectedValueOnce(new Error("bad"));
		expect(await verifyQStashSignature(cfg, "raw-body", "sig")).toBe(false);
	});
});
```

- [ ] **Step 2: run, expect FAIL (module missing).**
- [ ] **Step 3: implement** `src/scheduler.ts`:

```typescript
import { Client, Receiver } from "@upstash/qstash";
import type { AppConfig } from "./config.js";

export interface ReviewRunMessage {
	provider: "anthropic" | "openai";
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	action: string;
	installationId: number;
}

export function reviewRunCallbackUrl(config: AppConfig): string {
	return `${config.publicUrl}/api/github/review-run`;
}

// Publish a delayed review-run callback. Returns null when QStash isn't
// configured (or PUBLIC_URL is missing) so the caller can fall back to running
// the review inline — never silently drops the review.
export async function scheduleReview(
	config: AppConfig,
	message: ReviewRunMessage,
	delaySeconds: number,
): Promise<{ messageId: string } | null> {
	if (!config.qstashToken || !config.publicUrl) return null;
	const client = new Client({ token: config.qstashToken });
	const res = await client.publishJSON({
		url: reviewRunCallbackUrl(config),
		body: message,
		delay: Math.max(0, Math.floor(delaySeconds)),
		// Dedups GitHub webhook REDELIVERIES of the same push only. Cross-push
		// coalescing is handled by the head-SHA staleness check in the callback —
		// deduplicationId cannot cancel an already-scheduled older-SHA message.
		deduplicationId: `${message.provider}:${message.pullNumber}:${message.headSha}`,
	});
	return { messageId: (res as { messageId: string }).messageId };
}

export async function verifyQStashSignature(
	config: AppConfig,
	rawBody: string,
	signature: string,
): Promise<boolean> {
	if (!config.qstashCurrentSigningKey || !config.qstashNextSigningKey) return false;
	const receiver = new Receiver({
		currentSigningKey: config.qstashCurrentSigningKey,
		nextSigningKey: config.qstashNextSigningKey,
	});
	try {
		return await receiver.verify({
			body: rawBody,
			signature,
			url: reviewRunCallbackUrl(config),
		});
	} catch {
		return false;
	}
}
```

- [ ] **Step 4: run, expect PASS.**
- [ ] **Step 5: commit** `feat(scheduler): QStash publish + signature verify`

---

## Task 3: `runScheduledReview` helper + webhook publishes instead of sleeping

**Files:** `src/github-app.ts`, `src/github-app.test.ts`

- [ ] **Step 1: failing test** — assert the `pull_request.synchronize` handler calls `scheduleReview` (mock `./scheduler.js`) with the right message + delay and does NOT call the in-process `sleep`, when QStash is configured; and that `runScheduledReview(message, app, config)` invokes `maybeSubmitReview` with the message's fields. Reuse the existing `github-app.test.ts` harness + `buildPullRequestPayload`. (If exercising the octokit webhooks handler directly is hard, test `runScheduledReview` directly and test a small extracted `publishOrRunReview(config, message, delayMs, app)` unit that branches on QStash-configured.)

- [ ] **Step 2: run, expect FAIL.**
- [ ] **Step 3: implement** in `src/github-app.ts`:
  - Add `export async function runScheduledReview(message: ReviewRunMessage, app: App, config: AppConfig)` that resolves the installation octokit and calls `maybeSubmitReview` with the message fields (`force: false`). This is what `/api/github/review-run` calls.
  - In the `pull_request` handler, replace the `sleep(delayMs)` + inline `maybeSubmitReview` block with: build the `ReviewRunMessage` (provider from `config.provider`, ids from payload, `headSha = prPayload.pull_request.head.sha`), then `const scheduled = await scheduleReview(config, message, delayMs / 1000);` — if `scheduled === null` (QStash unconfigured) fall back to the existing `sleep` + `maybeSubmitReview` path (keep it as the `else`). Publishing is fast, so it still fits inside the webhook's `waitUntil` window.
  - Import `scheduleReview` + `ReviewRunMessage` from `./scheduler.js`.
- [ ] **Step 4: run, expect PASS** (+ full suite).
- [ ] **Step 5: commit** `feat(review): schedule reviews via QStash instead of in-process delay`

---

## Task 4: `/api/github/review-run` endpoint

**Files:** `api/github/review-run.ts` (new)

- [ ] **Step 1:** (endpoint files have no unit tests in this repo — mirror `api/github/webhook.ts`; the logic it calls is unit-tested in Tasks 2–3. Verify by `npm run typecheck`.)
- [ ] **Step 2: implement** `api/github/review-run.ts`, mirroring `api/github/webhook.ts`:
  - `POST` only.
  - `const rawBody = (await readRawBody(req)).toString("utf8");`
  - Read `Upstash-Signature` header; `400` if missing.
  - Determine provider from the parsed body, pick `getConfig()` vs `getOpenAIAppConfig()` and `getGitHubApp()` vs `getOpenAIGitHubApp()` accordingly. (Parse the body BEFORE verifying so you can pick the right signing keys — but treat the parse as untrusted; verification gates all side effects.)
  - `const ok = await verifyQStashSignature(config, rawBody, signature);` → `401` if false.
  - Parse `ReviewRunMessage` from `rawBody`.
  - **Staleness check (coalescing):** fetch the PR's current head via the installation octokit (`GET /repos/{owner}/{repo}/pulls/{pull_number}` → `.head.sha`); if it !== `message.headSha`, respond `200 {skipped:"superseded"}` and return — a newer push owns the review now.
  - Else `await runScheduledReview(message, app, config);` then `res.status(200).json({ ok: true })`.
  - Wrap work in try/catch → `500` with a logged error (QStash retries on non-2xx, which is the desired resilience). Use `waitUntil` only if the review must outlive the response — but here we WANT the function to stay alive for the full review (up to 800s), so `await` it directly and respond after.
- [ ] **Step 3:** `npm run typecheck && npm run lint`
- [ ] **Step 4: commit** `feat(api): QStash-verified /api/github/review-run endpoint`

---

## Task 5: vercel.json + docs + env

**Files:** `vercel.json`, `.env.example`, `CLAUDE.md`

- [ ] **Step 1:** In `vercel.json` add `api/github/review-run.ts` with `"maxDuration": 800` (mirror the webhook functions). Confirm the existing two webhook functions are unchanged.
- [ ] **Step 2:** `.env.example` — add `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `PUBLIC_URL` (with a comment: required for the QStash scheduler; without them the bot falls back to the in-process delay). Note `REVIEW_TIER2_ENABLED` now defaults ON.
- [ ] **Step 3:** `CLAUDE.md` — document the scheduler flow in the request-flow section, the new env vars, and that Tier 2 is back ON. Update the request-flow diagram to mention QStash.
- [ ] **Step 4: commit** `docs: QStash scheduler env + vercel function + request flow`

---

## Final verification

- [ ] `npm run typecheck && npm run lint && npx vitest run --pool=forks --reporter=basic` — all green
- [ ] Final adversarial code-review subagent over the branch diff (focus: signature-verify-before-side-effects ordering; staleness-check correctness; the QStash-unconfigured fallback never drops a review; publish-URL == verify-URL).
- [ ] Push, open PR targeting `main`, reference epic `ai-review-bot-9nv`.
- [ ] **Before merge:** set `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `PUBLIC_URL` in Vercel prod (the bot falls back to inline delay until they're set — safe, but the 800s fix isn't active until they exist). Confirm `REVIEW_TIER2_ENABLED` is unset (so it defaults ON) or set to `true`.

## Follow-ups (separate beads, NOT this PR)
- `ai-review-bot-art` (PR3): peer-delay-skip — when peer bots already reviewed the current head, schedule with near-zero delay.
- `ai-review-bot-tbh`: INCREMENTAL clean-delta-with-unresolved-priors → re-stamp + skip instead of re-posting.
- The PR1 minors bead (OctokitLike param type, inline severity, empty-delta fan-out).

## Self-Review (author)
- Spec coverage: in-process sleep replaced (T3) ✓; QStash delayed callback + endpoint (T2/T4) ✓; coalescing (staleness check, T4) ✓ — note: via staleness check, NOT deduplicationId (footgun documented); signature verify (T2/T4) ✓; Tier 2 re-enabled (T1) ✓; QSTASH_* env (T1/T5) ✓; graceful fallback when unconfigured (T2/T3) ✓.
- Footguns captured: dedup≠cancel; publish-URL must equal verify-URL; verify-before-side-effects.
- Risk for implementer: the octokit webhooks handler may not cleanly expose a seam for testing the publish branch — extract a `publishOrRunReview` helper if so (noted in T3). Confirm `@upstash/qstash` `publishJSON` delay-unit (seconds) and `Receiver.verify` arg shape against the installed version before relying on the snippets here.
