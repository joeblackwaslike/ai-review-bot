# Inline-Comment Feedback Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record maintainer 👍/👎 reactions on the review bot's inline comments — with the skill that raised each comment — into Upstash KV, so a later system can refine our review skills.

**Architecture:** Bolt onto the existing review **post** step (persist each posted inline comment + its skill provenance to KV) plus one new Vercel Cron endpoint that polls the GitHub Reactions API and appends 👍/👎 verdict events to an append-only KV list. Provider-agnostic: every record is tagged with the app/installation that posted it. Recording-only — no analysis loop.

**Tech Stack:** TypeScript ESM (Vitest, Biome), `@upstash/redis`, Octokit, Vercel functions (`@vercel/node`). Spec: [docs/superpowers/specs/2026-06-10-inline-feedback-capture-design.md](../specs/2026-06-10-inline-feedback-capture-design.md). Beads: `ai-review-bot-qd6`.

> **Base-branch note:** This branch is off `main` (pre PR #14). `buildReview` here uses `Promise.allSettled` and `runAgent` returns `{review,usage}|null`. If PR #14 (rate-limit resilience) merges first, rebase: the only conflict is the Task 6 provenance block, which adapts 1:1 to the post-#14 `outcomes`/`mapWithConcurrency` shape (iterate `outcomes` with index instead of `settled`).

## Conventions (every task)

- TS ESM: relative imports use `.js` extensions even for `.ts`; **named exports only**.
- Vitest, colocated `*.test.ts`. Biome for lint/format.
- Quality gates — run the **npm scripts** (a hook blocks `npx vitest`): `npm run test`, `npm run typecheck`, `npm run lint`.
- TDD: write the failing test, watch it fail, implement, watch it pass, commit. Stage **explicit paths** — never `git add -A`.

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/feedback/types.ts` | create | Shared types: `Provider`, `Verdict`, `PostedCommentRecord`, `FeedbackEvent`. |
| `src/feedback/kv.ts` | create | `KvClient` interface (the Redis subset we use) + `createUpstashKv()`. |
| `src/feedback/kv.fake.ts` | create | `createFakeKv()` — in-memory `KvClient` for tests (sorted-set + string + list). |
| `src/feedback/store.ts` | create | KV data model: `recordPostedComment`, `listActiveComments`, `markPolled`, `appendFeedbackEvent`, `prune`. |
| `src/feedback/reactions.ts` | create | `computeReactionDelta` (pure) + `diffReactions` (fetch + diff via injected octokit). |
| `src/feedback/poll.ts` | create | `runFeedbackPoll(deps)` — one poll pass over active comments. |
| `src/feedback/persist.ts` | create | `persistPostedComments(opts)` — list a review's created comments, match to provenance, record. |
| `api/cron/poll-feedback.ts` | create | Vercel Cron handler: verify `CRON_SECRET` → `runFeedbackPoll`. |
| `src/config.ts` | modify | `feedbackEnabled: boolean` (env `FEEDBACK_ENABLED`, default false). |
| `src/review.ts` | modify | `feedbackEnabled` on `ReviewContext`; compute `commentProvenance` + invitation line in `buildReview`; `commentProvenance` on `ReviewDecision`. |
| `src/github-app.ts` | modify | `postReviewWithRetry` returns the review id; pass `feedbackEnabled`; best-effort persist after posting. |
| `vercel.json` | modify | Add the `crons` entry + cron function maxDuration. |
| `.env.example` | modify | Document the new env vars. |
| `package.json` | modify | Add `@upstash/redis`. |

---

## Task 1: Types + KV client abstraction + in-memory fake

**Files:**
- Create: `src/feedback/types.ts`, `src/feedback/kv.ts`, `src/feedback/kv.fake.ts`, `src/feedback/kv.fake.test.ts`
- Modify: `package.json` (add dep)

- [ ] **Step 1: Add the dependency**

Run: `npm install @upstash/redis`
Expected: `package.json` gains `@upstash/redis` under dependencies; lockfile updates.

- [ ] **Step 2: Write the types**

Create `src/feedback/types.ts`:

```typescript
export type Provider = "anthropic" | "openai";
export type Verdict = "up" | "down";

/** A posted inline comment we are tracking for reactions. */
export interface PostedCommentRecord {
	commentId: number;
	provider: Provider;
	installationId: number;
	owner: string;
	repo: string;
	pr: number;
	headSha: string;
	path: string;
	line: number;
	/** Skills (skill file names) that raised a finding at this path:line. */
	skills: string[];
	/** Title of the displayed inline comment. */
	title: string;
	body: string;
	postedAtMs: number;
	expiresAtMs: number;
	/** Latest verdict we have already recorded per reactor login — for idempotent diffs. */
	lastSeenReactions: Record<string, Verdict>;
}

/** An append-only verdict observation, denormalized so the events log is self-contained. */
export interface FeedbackEvent {
	commentId: number;
	provider: Provider;
	owner: string;
	repo: string;
	pr: number;
	path: string;
	line: number;
	skills: string[];
	title: string;
	verdict: Verdict;
	reactor: string;
	reactedAtMs: number;
	capturedAtMs: number;
}
```

- [ ] **Step 3: Write the `KvClient` interface + Upstash adapter**

Create `src/feedback/kv.ts`:

```typescript
import { Redis } from "@upstash/redis";

/** The minimal Redis surface the feedback store needs. Score bounds accept numbers or the
 * Redis tokens "-inf"/"+inf"/"(123" (exclusive). Values are opaque strings (callers JSON-encode). */
export interface KvClient {
	zadd(key: string, score: number, member: string): Promise<unknown>;
	zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
	zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
	set(key: string, value: string, ttlSeconds?: number): Promise<unknown>;
	get(key: string): Promise<string | null>;
	del(...keys: string[]): Promise<unknown>;
	lpush(key: string, value: string): Promise<unknown>;
}

export function createUpstashKv(): KvClient {
	const url = process.env.KV_REST_API_URL;
	const token = process.env.KV_REST_API_TOKEN;
	if (!url || !token) {
		throw new Error(
			"KV_REST_API_URL and KV_REST_API_TOKEN are required when FEEDBACK_ENABLED=true",
		);
	}
	// automaticDeserialization:false keeps values as the raw strings we JSON-encode.
	const redis = new Redis({ url, token, automaticDeserialization: false });
	return {
		zadd: (key, score, member) => redis.zadd(key, { score, member }),
		zrangebyscore: (key, min, max) =>
			redis.zrange(key, min, max, { byScore: true }) as Promise<string[]>,
		zremrangebyscore: (key, min, max) => redis.zremrangebyscore(key, min, max),
		set: (key, value, ttlSeconds) =>
			ttlSeconds ? redis.set(key, value, { ex: ttlSeconds }) : redis.set(key, value),
		get: (key) => redis.get<string>(key),
		del: (...keys) => redis.del(...keys),
		lpush: (key, value) => redis.lpush(key, value),
	};
}
```

- [ ] **Step 4: Write the failing test for the fake**

Create `src/feedback/kv.fake.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createFakeKv } from "./kv.fake.js";

describe("createFakeKv", () => {
	it("stores and reads strings with del", async () => {
		const kv = createFakeKv();
		await kv.set("a", "1");
		expect(await kv.get("a")).toBe("1");
		expect(await kv.get("missing")).toBeNull();
		await kv.del("a");
		expect(await kv.get("a")).toBeNull();
	});

	it("zrangebyscore returns members in score order within inclusive bounds", async () => {
		const kv = createFakeKv();
		await kv.zadd("z", 30, "c");
		await kv.zadd("z", 10, "a");
		await kv.zadd("z", 20, "b");
		expect(await kv.zrangebyscore("z", 15, "+inf")).toEqual(["b", "c"]);
		expect(await kv.zrangebyscore("z", "-inf", 25)).toEqual(["a", "b"]);
	});

	it("zremrangebyscore removes matching members and supports exclusive '(' bounds", async () => {
		const kv = createFakeKv();
		await kv.zadd("z", 10, "a");
		await kv.zadd("z", 20, "b");
		const removed = await kv.zremrangebyscore("z", "-inf", "(20");
		expect(removed).toBe(1);
		expect(await kv.zrangebyscore("z", "-inf", "+inf")).toEqual(["b"]);
	});

	it("lpush prepends", async () => {
		const kv = createFakeKv();
		await kv.lpush("l", "x");
		await kv.lpush("l", "y");
		expect(kv._dump().lists.get("l")).toEqual(["y", "x"]);
	});
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npm run test -- src/feedback/kv.fake.test.ts`
Expected: FAIL — `./kv.fake.js` does not exist.

- [ ] **Step 6: Implement the fake**

Create `src/feedback/kv.fake.ts`:

```typescript
import type { KvClient } from "./kv.js";

/** Parse a Redis score bound: number, "-inf"/"+inf", or exclusive "(123". */
function parseBound(v: number | string): { value: number; exclusive: boolean } {
	if (typeof v === "number") return { value: v, exclusive: false };
	if (v === "-inf") return { value: Number.NEGATIVE_INFINITY, exclusive: false };
	if (v === "+inf") return { value: Number.POSITIVE_INFINITY, exclusive: false };
	if (v.startsWith("(")) return { value: Number(v.slice(1)), exclusive: true };
	return { value: Number(v), exclusive: false };
}

export interface FakeKv extends KvClient {
	_dump(): {
		strings: Map<string, string>;
		zsets: Map<string, Map<string, number>>;
		lists: Map<string, string[]>;
	};
}

export function createFakeKv(): FakeKv {
	const strings = new Map<string, string>();
	const zsets = new Map<string, Map<string, number>>();
	const lists = new Map<string, string[]>();

	function inRange(score: number, min: number | string, max: number | string): boolean {
		const lo = parseBound(min);
		const hi = parseBound(max);
		const aboveLo = lo.exclusive ? score > lo.value : score >= lo.value;
		const belowHi = hi.exclusive ? score < hi.value : score <= hi.value;
		return aboveLo && belowHi;
	}

	return {
		async zadd(key, score, member) {
			let z = zsets.get(key);
			if (!z) {
				z = new Map();
				zsets.set(key, z);
			}
			z.set(member, score);
		},
		async zrangebyscore(key, min, max) {
			const z = zsets.get(key) ?? new Map<string, number>();
			return [...z.entries()]
				.filter(([, s]) => inRange(s, min, max))
				.sort((a, b) => a[1] - b[1])
				.map(([m]) => m);
		},
		async zremrangebyscore(key, min, max) {
			const z = zsets.get(key);
			if (!z) return 0;
			let n = 0;
			for (const [m, s] of [...z.entries()]) {
				if (inRange(s, min, max)) {
					z.delete(m);
					n++;
				}
			}
			return n;
		},
		async set(key, value) {
			strings.set(key, value);
		},
		async get(key) {
			return strings.has(key) ? (strings.get(key) as string) : null;
		},
		async del(...keys) {
			for (const k of keys) strings.delete(k);
		},
		async lpush(key, value) {
			const l = lists.get(key) ?? [];
			l.unshift(value);
			lists.set(key, l);
		},
		_dump() {
			return { strings, zsets, lists };
		},
	};
}
```

> The fake ignores TTL (irrelevant for unit tests). `_dump()` is a test-only escape hatch.

- [ ] **Step 7: Run tests + gates**

Run: `npm run test -- src/feedback/kv.fake.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/feedback/types.ts src/feedback/kv.ts src/feedback/kv.fake.ts src/feedback/kv.fake.test.ts
git commit -m "feat(feedback): KV client abstraction + in-memory fake + shared types"
```

---

## Task 2: KV data-model store

**Files:**
- Create: `src/feedback/store.ts`, `src/feedback/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/feedback/store.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createFakeKv } from "./kv.fake.js";
import {
	appendFeedbackEvent,
	listActiveComments,
	markPolled,
	prune,
	recordPostedComment,
} from "./store.js";
import type { FeedbackEvent, PostedCommentRecord } from "./types.js";

const NOW = 1_000_000;
const DAY = 24 * 60 * 60 * 1000;

function rec(over: Partial<PostedCommentRecord> = {}): PostedCommentRecord {
	return {
		commentId: 1,
		provider: "anthropic",
		installationId: 99,
		owner: "o",
		repo: "r",
		pr: 7,
		headSha: "sha",
		path: "src/x.ts",
		line: 42,
		skills: ["code-reviewer.md"],
		title: "Bug",
		body: "body",
		postedAtMs: NOW,
		expiresAtMs: NOW + 14 * DAY,
		lastSeenReactions: {},
		...over,
	};
}

describe("feedback store", () => {
	it("records a posted comment and lists it as active", async () => {
		const kv = createFakeKv();
		await recordPostedComment(kv, rec(), NOW);
		const active = await listActiveComments(kv, NOW);
		expect(active).toHaveLength(1);
		expect(active[0]?.commentId).toBe(1);
		expect(active[0]?.skills).toEqual(["code-reviewer.md"]);
	});

	it("markPolled persists the updated lastSeenReactions", async () => {
		const kv = createFakeKv();
		await recordPostedComment(kv, rec(), NOW);
		await markPolled(kv, rec(), { octocat: "up" }, NOW);
		const active = await listActiveComments(kv, NOW);
		expect(active[0]?.lastSeenReactions).toEqual({ octocat: "up" });
	});

	it("prune removes expired comments and drops them from the active set", async () => {
		const kv = createFakeKv();
		await recordPostedComment(kv, rec({ commentId: 1, expiresAtMs: NOW + DAY }), NOW);
		await recordPostedComment(kv, rec({ commentId: 2, expiresAtMs: NOW - DAY }), NOW);
		const removed = await prune(kv, NOW);
		expect(removed).toBe(1);
		const active = await listActiveComments(kv, NOW);
		expect(active.map((c) => c.commentId)).toEqual([1]);
	});

	it("appendFeedbackEvent pushes onto the events list", async () => {
		const kv = createFakeKv();
		const event: FeedbackEvent = {
			commentId: 1,
			provider: "anthropic",
			owner: "o",
			repo: "r",
			pr: 7,
			path: "src/x.ts",
			line: 42,
			skills: ["code-reviewer.md"],
			title: "Bug",
			verdict: "down",
			reactor: "octocat",
			reactedAtMs: NOW,
			capturedAtMs: NOW,
		};
		await appendFeedbackEvent(kv, event);
		const list = kv._dump().lists.get("fb:events");
		expect(list).toHaveLength(1);
		expect(JSON.parse(list?.[0] as string).verdict).toBe("down");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/feedback/store.test.ts`
Expected: FAIL — `./store.js` missing.

- [ ] **Step 3: Implement the store**

Create `src/feedback/store.ts`:

```typescript
import type { KvClient } from "./kv.js";
import type { FeedbackEvent, PostedCommentRecord, Verdict } from "./types.js";

const POLL_SET = "fb:poll";
const EVENTS_LIST = "fb:events";

function ref(provider: string, commentId: number): string {
	return `${provider}:${commentId}`;
}

function cmtKey(provider: string, commentId: number): string {
	return `fb:cmt:${provider}:${commentId}`;
}

function ttlSeconds(expiresAtMs: number, nowMs: number): number {
	return Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000));
}

export async function recordPostedComment(
	kv: KvClient,
	record: PostedCommentRecord,
	nowMs: number,
): Promise<void> {
	await kv.set(
		cmtKey(record.provider, record.commentId),
		JSON.stringify(record),
		ttlSeconds(record.expiresAtMs, nowMs),
	);
	await kv.zadd(POLL_SET, record.expiresAtMs, ref(record.provider, record.commentId));
}

export async function listActiveComments(
	kv: KvClient,
	nowMs: number,
): Promise<PostedCommentRecord[]> {
	const refs = await kv.zrangebyscore(POLL_SET, nowMs, "+inf");
	const out: PostedCommentRecord[] = [];
	for (const r of refs) {
		const sep = r.indexOf(":");
		const provider = r.slice(0, sep);
		const commentId = Number(r.slice(sep + 1));
		const raw = await kv.get(cmtKey(provider, commentId));
		if (raw) out.push(JSON.parse(raw) as PostedCommentRecord);
	}
	return out;
}

export async function markPolled(
	kv: KvClient,
	record: PostedCommentRecord,
	lastSeenReactions: Record<string, Verdict>,
	nowMs: number,
): Promise<void> {
	const updated: PostedCommentRecord = { ...record, lastSeenReactions };
	await kv.set(
		cmtKey(record.provider, record.commentId),
		JSON.stringify(updated),
		ttlSeconds(record.expiresAtMs, nowMs),
	);
}

export async function appendFeedbackEvent(kv: KvClient, event: FeedbackEvent): Promise<void> {
	await kv.lpush(EVENTS_LIST, JSON.stringify(event));
}

/** Remove comments whose expiry is strictly before now (score < now). Returns count removed. */
export async function prune(kv: KvClient, nowMs: number): Promise<number> {
	const expired = await kv.zrangebyscore(POLL_SET, "-inf", `(${nowMs}`);
	for (const r of expired) {
		const sep = r.indexOf(":");
		await kv.del(cmtKey(r.slice(0, sep), Number(r.slice(sep + 1))));
	}
	return kv.zremrangebyscore(POLL_SET, "-inf", `(${nowMs}`);
}
```

- [ ] **Step 4: Run tests + gates**

Run: `npm run test -- src/feedback/store.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feedback/store.ts src/feedback/store.test.ts
git commit -m "feat(feedback): KV data model (poll-set, comment records, events log, prune)"
```

---

## Task 3: Reactions fetch + pure verdict diff

**Files:**
- Create: `src/feedback/reactions.ts`, `src/feedback/reactions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/feedback/reactions.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { computeReactionDelta, diffReactions } from "./reactions.js";
import type { PostedCommentRecord } from "./types.js";

describe("computeReactionDelta", () => {
	it("emits a change for a new verdict and records it in lastSeen", () => {
		const out = computeReactionDelta(
			[{ login: "octocat", content: "+1", createdAtMs: 100 }],
			{},
		);
		expect(out.changes).toEqual([{ reactor: "octocat", verdict: "up", reactedAtMs: 100 }]);
		expect(out.lastSeen).toEqual({ octocat: "up" });
	});

	it("emits no change when the verdict is unchanged", () => {
		const out = computeReactionDelta(
			[{ login: "octocat", content: "-1", createdAtMs: 100 }],
			{ octocat: "down" },
		);
		expect(out.changes).toEqual([]);
		expect(out.lastSeen).toEqual({ octocat: "down" });
	});

	it("emits a change when a reactor flips up→down", () => {
		const out = computeReactionDelta(
			[{ login: "octocat", content: "-1", createdAtMs: 200 }],
			{ octocat: "up" },
		);
		expect(out.changes).toEqual([{ reactor: "octocat", verdict: "down", reactedAtMs: 200 }]);
	});

	it("ignores non-verdict reactions", () => {
		const out = computeReactionDelta(
			[{ login: "octocat", content: "heart", createdAtMs: 100 }],
			{},
		);
		expect(out.changes).toEqual([]);
		expect(out.lastSeen).toEqual({});
	});

	it("drops a removed reaction from lastSeen without emitting a change", () => {
		const out = computeReactionDelta([], { octocat: "up" });
		expect(out.changes).toEqual([]);
		expect(out.lastSeen).toEqual({});
	});

	it("uses the reactor's latest verdict-bearing reaction", () => {
		const out = computeReactionDelta(
			[
				{ login: "octocat", content: "+1", createdAtMs: 100 },
				{ login: "octocat", content: "-1", createdAtMs: 200 },
			],
			{},
		);
		expect(out.changes).toEqual([{ reactor: "octocat", verdict: "down", reactedAtMs: 200 }]);
	});
});

describe("diffReactions", () => {
	it("fetches reactions and maps changes to enriched FeedbackEvents", async () => {
		const record = {
			commentId: 5,
			provider: "anthropic",
			installationId: 1,
			owner: "o",
			repo: "r",
			pr: 7,
			headSha: "sha",
			path: "src/x.ts",
			line: 42,
			skills: ["security-sast.md"],
			title: "Injection",
			body: "b",
			postedAtMs: 0,
			expiresAtMs: 0,
			lastSeenReactions: {},
		} satisfies PostedCommentRecord;

		const octokit = {
			request: vi.fn(async () => ({
				data: [
					{ user: { login: "maint" }, content: "-1", created_at: "2026-06-10T00:00:00Z" },
				],
			})),
		};

		const { events, lastSeen } = await diffReactions(octokit, record, 12345);
		expect(octokit.request).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
			expect.objectContaining({ owner: "o", repo: "r", comment_id: 5 }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			commentId: 5,
			skills: ["security-sast.md"],
			title: "Injection",
			verdict: "down",
			reactor: "maint",
			capturedAtMs: 12345,
		});
		expect(lastSeen).toEqual({ maint: "down" });
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/feedback/reactions.test.ts`
Expected: FAIL — `./reactions.js` missing.

- [ ] **Step 3: Implement reactions**

Create `src/feedback/reactions.ts`:

```typescript
import type { FeedbackEvent, PostedCommentRecord, Verdict } from "./types.js";

export interface RawReaction {
	login: string;
	content: string;
	createdAtMs: number;
}

interface VerdictChange {
	reactor: string;
	verdict: Verdict;
	reactedAtMs: number;
}

/** Pure: reduce current reactions to one verdict per reactor (latest +1/-1 wins), then diff
 * against the last-seen map. New/changed verdicts become changes; removals drop from the map
 * but emit no change. */
export function computeReactionDelta(
	current: RawReaction[],
	lastSeen: Record<string, Verdict>,
): { changes: VerdictChange[]; lastSeen: Record<string, Verdict> } {
	const latest = new Map<string, { verdict: Verdict; reactedAtMs: number }>();
	for (const r of current) {
		const verdict: Verdict | null =
			r.content === "+1" ? "up" : r.content === "-1" ? "down" : null;
		if (!verdict) continue;
		const prev = latest.get(r.login);
		if (!prev || r.createdAtMs > prev.reactedAtMs) {
			latest.set(r.login, { verdict, reactedAtMs: r.createdAtMs });
		}
	}

	const changes: VerdictChange[] = [];
	const nextLastSeen: Record<string, Verdict> = {};
	for (const [login, { verdict, reactedAtMs }] of latest) {
		nextLastSeen[login] = verdict;
		if (lastSeen[login] !== verdict) changes.push({ reactor: login, verdict, reactedAtMs });
	}
	return { changes, lastSeen: nextLastSeen };
}

interface OctokitLike {
	request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
}

interface RawReactionResponse {
	user: { login: string } | null;
	content: string;
	created_at: string;
}

/** Fetch a comment's reactions and return the new verdict events + the new last-seen map. */
export async function diffReactions(
	octokit: OctokitLike,
	record: PostedCommentRecord,
	nowMs: number,
): Promise<{ events: FeedbackEvent[]; lastSeen: Record<string, Verdict> }> {
	const res = await octokit.request(
		"GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
		{ owner: record.owner, repo: record.repo, comment_id: record.commentId, per_page: 100 },
	);
	const raw: RawReaction[] = (res.data as RawReactionResponse[]).map((x) => ({
		login: x.user?.login ?? "unknown",
		content: x.content,
		createdAtMs: Date.parse(x.created_at),
	}));

	const { changes, lastSeen } = computeReactionDelta(raw, record.lastSeenReactions);
	const events: FeedbackEvent[] = changes.map((c) => ({
		commentId: record.commentId,
		provider: record.provider,
		owner: record.owner,
		repo: record.repo,
		pr: record.pr,
		path: record.path,
		line: record.line,
		skills: record.skills,
		title: record.title,
		verdict: c.verdict,
		reactor: c.reactor,
		reactedAtMs: c.reactedAtMs,
		capturedAtMs: nowMs,
	}));
	return { events, lastSeen };
}
```

- [ ] **Step 4: Run tests + gates**

Run: `npm run test -- src/feedback/reactions.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feedback/reactions.ts src/feedback/reactions.test.ts
git commit -m "feat(feedback): reactions fetch + pure verdict-diff logic"
```

---

## Task 4: Poll orchestration

**Files:**
- Create: `src/feedback/poll.ts`, `src/feedback/poll.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/feedback/poll.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createFakeKv } from "./kv.fake.js";
import { runFeedbackPoll } from "./poll.js";
import { recordPostedComment } from "./store.js";
import type { PostedCommentRecord } from "./types.js";

const NOW = 1_000_000;
const DAY = 24 * 60 * 60 * 1000;

function rec(over: Partial<PostedCommentRecord> = {}): PostedCommentRecord {
	return {
		commentId: 1,
		provider: "anthropic",
		installationId: 5,
		owner: "o",
		repo: "r",
		pr: 7,
		headSha: "sha",
		path: "src/x.ts",
		line: 42,
		skills: ["code-reviewer.md"],
		title: "Bug",
		body: "b",
		postedAtMs: NOW,
		expiresAtMs: NOW + 14 * DAY,
		lastSeenReactions: {},
		...over,
	};
}

describe("runFeedbackPoll", () => {
	it("records new verdict events, marks polled, and prunes expired", async () => {
		const kv = createFakeKv();
		await recordPostedComment(kv, rec({ commentId: 1 }), NOW);
		await recordPostedComment(kv, rec({ commentId: 2, expiresAtMs: NOW - DAY }), NOW);

		const octokit = {
			request: vi.fn(async () => ({
				data: [{ user: { login: "maint" }, content: "+1", created_at: "2026-06-10T00:00:00Z" }],
			})),
		};
		const getOctokit = vi.fn(async () => octokit);

		const result = await runFeedbackPoll({ kv, getOctokit, nowMs: NOW });

		expect(result).toEqual({ polled: 1, events: 1, pruned: 1 });
		const events = kv._dump().lists.get("fb:events");
		expect(events).toHaveLength(1);
		expect(JSON.parse(events?.[0] as string)).toMatchObject({ commentId: 1, verdict: "up", reactor: "maint" });
		// re-poll is idempotent: lastSeen now persisted, no new event
		const again = await runFeedbackPoll({ kv, getOctokit, nowMs: NOW });
		expect(again.events).toBe(0);
	});

	it("continues past a comment whose reaction fetch throws", async () => {
		const kv = createFakeKv();
		await recordPostedComment(kv, rec({ commentId: 1 }), NOW);
		await recordPostedComment(kv, rec({ commentId: 2 }), NOW);
		const octokit = {
			request: vi
				.fn()
				.mockRejectedValueOnce(new Error("boom"))
				.mockResolvedValue({ data: [{ user: { login: "m" }, content: "-1", created_at: "2026-06-10T00:00:00Z" }] }),
		};
		const result = await runFeedbackPoll({ kv, getOctokit: async () => octokit, nowMs: NOW });
		expect(result.polled).toBe(2);
		expect(result.events).toBe(1); // one failed, one succeeded
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/feedback/poll.test.ts`
Expected: FAIL — `./poll.js` missing.

- [ ] **Step 3: Implement the poller**

Create `src/feedback/poll.ts`:

```typescript
import { diffReactions } from "./reactions.js";
import {
	appendFeedbackEvent,
	listActiveComments,
	markPolled,
	prune,
} from "./store.js";
import type { KvClient } from "./kv.js";
import type { Provider } from "./types.js";

interface OctokitLike {
	request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export interface PollDeps {
	kv: KvClient;
	getOctokit: (provider: Provider, installationId: number) => Promise<OctokitLike>;
	nowMs: number;
}

/** One poll pass: for each active comment, fetch reactions, append new verdict events, persist
 * last-seen, then prune expired comments. Per-comment failures are logged and skipped. */
export async function runFeedbackPoll(
	deps: PollDeps,
): Promise<{ polled: number; events: number; pruned: number }> {
	const { kv, getOctokit, nowMs } = deps;
	const records = await listActiveComments(kv, nowMs);
	let events = 0;

	for (const record of records) {
		try {
			const octokit = await getOctokit(record.provider, record.installationId);
			const { events: newEvents, lastSeen } = await diffReactions(octokit, record, nowMs);
			for (const event of newEvents) {
				await appendFeedbackEvent(kv, event);
				events++;
			}
			await markPolled(kv, record, lastSeen, nowMs);
		} catch (err) {
			console.error("feedback poll: comment failed", {
				commentId: record.commentId,
				provider: record.provider,
				err,
			});
		}
	}

	const pruned = await prune(kv, nowMs);
	return { polled: records.length, events, pruned };
}
```

- [ ] **Step 4: Run tests + gates**

Run: `npm run test -- src/feedback/poll.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feedback/poll.ts src/feedback/poll.test.ts
git commit -m "feat(feedback): poll orchestration (per-comment resilient, idempotent, prunes)"
```

---

## Task 5: `FEEDBACK_ENABLED` config

**Files:**
- Modify: `src/config.ts` (`AppConfig` + both factories)
- Test: `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/config.test.ts` (use the file's existing required-env helper — read the file first to match its setup pattern, e.g. `setRequiredEnv()`):

```typescript
import { getConfig } from "./config.js";

describe("feedbackEnabled", () => {
	it("defaults to false and is true only when FEEDBACK_ENABLED=true", () => {
		setRequiredEnv();
		delete process.env.FEEDBACK_ENABLED;
		expect(getConfig().feedbackEnabled).toBe(false);
		process.env.FEEDBACK_ENABLED = "true";
		expect(getConfig().feedbackEnabled).toBe(true);
		process.env.FEEDBACK_ENABLED = "1";
		expect(getConfig().feedbackEnabled).toBe(false); // only exact "true" enables
		delete process.env.FEEDBACK_ENABLED;
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/config.test.ts`
Expected: FAIL — `feedbackEnabled` missing.

- [ ] **Step 3: Implement**

In `src/config.ts`: add `feedbackEnabled: boolean;` to the `AppConfig` interface, and in BOTH `getConfig()` and `getOpenAIAppConfig()` return objects add:

```typescript
feedbackEnabled: process.env.FEEDBACK_ENABLED === "true",
```

- [ ] **Step 4: Run tests + gates**

Run: `npm run test -- src/config.test.ts && npm run typecheck`
Expected: PASS.

> If `src/github-app.test.ts` builds an inline `AppConfig` fixture, it will now fail typecheck for the missing field — add `feedbackEnabled: false` to those fixtures (do not change other assertions). Run `npm run test` to confirm the whole suite is green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts src/github-app.test.ts
git commit -m "feat(config): FEEDBACK_ENABLED (default false)"
```

---

## Task 6: Provenance + invitation in `buildReview`

**Files:**
- Modify: `src/review.ts` (`ReviewContext`, `ReviewDecision`, `buildReview`)
- Test: `src/review.test.ts`

**Context:** `buildReview` runs agents with `const settled = await Promise.allSettled(agentPromises)` where `agentPromises = allSkills.map(({ skillPath }) => runAgent(...))`, so `allSkills[i]` ↔ `settled[i]`. It then builds `modelReview = mergeReviews(agentResults)` and `reviewComments = buildReviewComments(files, modelReview.inline_comments)`. We compute provenance after both exist. Do **not** modify `mergeReviews`.

- [ ] **Step 1: Write the failing test**

Append to `src/review.test.ts` (the file mocks `./prompt.js` and `./models.js`; mirror the existing `buildReview` test's octokit + context shape — read the file first). The test drives two agents that both flag `src/x.ts:10`:

```typescript
import { buildReview } from "./review.js";

describe("buildReview comment provenance", () => {
	it("attaches the set of skills that flagged each posted inline comment", async () => {
		// Two agents flag the same path:line; provenance should carry both skills.
		// (Mock generateObject / runAgent per the file's existing mock; here we assume the
		// file already mocks the agent layer to return one inline comment per agent at x.ts:10.)
		// See the existing buildReview test for the octokit + files mock; reuse it, returning a
		// single changed file `src/x.ts` whose patch makes line 10 a valid right-side line.

		const decision = await buildReviewWithTwoAgentsFlagging("src/x.ts", 10, [
			"code-reviewer.md",
			"security-sast.md",
		]);

		expect(decision?.commentProvenance).toBeDefined();
		const prov = decision?.commentProvenance?.get("src/x.ts:10");
		expect(prov?.skills.sort()).toEqual(["code-reviewer.md", "security-sast.md"]);
		expect(prov?.title.length).toBeGreaterThan(0);
	});

	it("omits provenance when feedbackEnabled is false", async () => {
		const decision = await buildReviewWithTwoAgentsFlagging(
			"src/x.ts",
			10,
			["code-reviewer.md"],
			{ feedbackEnabled: false },
		);
		expect(decision?.commentProvenance).toBeUndefined();
	});
});
```

> **Implementer note:** `buildReviewWithTwoAgentsFlagging` is a helper you write in the test file using the file's existing mock seams (the same `generateObject`/`./models.js` mocks the other `buildReview` tests use). It must: mock the agent layer so the first two `TIER1_SKILLS` each return one inline comment `{ title: "Issue", body: "b", path, line, start_line: null, suggestion: null }` and the rest return none; mock octokit so `GET …/reviews` → `[]`, `paginate …/files` → one file `src/x.ts` with a patch where `line` is a valid right-side line (e.g. `@@ -1,0 +1,20 @@` followed by 20 `+` lines); and call `buildReview` with a full `ReviewContext` including `feedbackEnabled: true` (overridable). If the file's existing mock can only make ALL agents return the same comment, that is fine — assert the skills set contains the agents that ran. Match the existing test's exact mock mechanics rather than inventing new ones.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/review.test.ts -t "comment provenance"`
Expected: FAIL — `commentProvenance` / `feedbackEnabled` do not exist.

- [ ] **Step 3: Implement in `src/review.ts`**

3a. Add `feedbackEnabled` to `ReviewContext` (in the interface):

```typescript
	provider: "anthropic" | "openai";
	feedbackEnabled: boolean;
```

3b. Add the provenance field to `ReviewDecision`:

```typescript
export interface ReviewDecision {
	event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
	body: string;
	comments: ReviewComment[];
	metadata: ReviewMetadata;
	validLinesByPath: Map<string, Set<number>>;
	/** path:line → skills that flagged it + the displayed title. Present only when feedbackEnabled. */
	commentProvenance?: Map<string, { skills: string[]; title: string }>;
}
```

3c. In `buildReview`, AFTER `const reviewComments = buildReviewComments(files, modelReview.inline_comments);` (and after `modelReview` exists), compute provenance:

```typescript
	let commentProvenance: Map<string, { skills: string[]; title: string }> | undefined;
	if (context.feedbackEnabled) {
		const skillsByKey = new Map<string, Set<string>>();
		settled.forEach((result, i) => {
			if (result.status !== "fulfilled" || result.value === null) return;
			const skillPath = allSkills[i]?.skillPath;
			if (!skillPath) return;
			for (const c of result.value.review.inline_comments) {
				const key = `${c.path}:${c.line}`;
				const set = skillsByKey.get(key) ?? new Set<string>();
				set.add(skillPath);
				skillsByKey.set(key, set);
			}
		});
		const titleByKey = new Map<string, string>();
		for (const c of modelReview.inline_comments) {
			titleByKey.set(`${c.path}:${c.line}`, c.title);
		}
		commentProvenance = new Map();
		for (const rc of reviewComments) {
			const key = `${rc.path}:${rc.line}`;
			commentProvenance.set(key, {
				skills: [...(skillsByKey.get(key) ?? [])],
				title: titleByKey.get(key) ?? "",
			});
		}
	}
```

3d. Add the invitation line to the body. In the `body` array assembly, add a `feedbackInvite` constant and include it (it is filtered out when empty because the assembly already does `.filter((part) => part.length > 0)`):

```typescript
	const feedbackInvite =
		context.feedbackEnabled && reviewComments.length > 0
			? "💬 React 👍 / 👎 on any inline comment to tell us if it helped — it trains our reviewers."
			: "";
```

Then insert `feedbackInvite,` into the `body` array, just after the `inlineSummary` entry (so it appears under the inline-comment count).

3e. Add `commentProvenance` to the returned `ReviewDecision` object (the final `return { event: finalEvent, body, comments: reviewComments, metadata: {...}, validLinesByPath: validLines }`):

```typescript
		validLinesByPath: validLines,
		commentProvenance,
```

- [ ] **Step 4: Run tests + gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS. Update any existing `buildReview` test that constructs a `ReviewContext` to include `feedbackEnabled: false` (mirror how `provider` is set). Do not weaken assertions.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/review.test.ts
git commit -m "feat(review): compute inline-comment skill provenance + feedback invitation"
```

---

## Task 7: Persist posted comments

**Files:**
- Create: `src/feedback/persist.ts`, `src/feedback/persist.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/feedback/persist.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createFakeKv } from "./kv.fake.js";
import { persistPostedComments } from "./persist.js";
import { listActiveComments } from "./store.js";

const NOW = 1_000_000;

describe("persistPostedComments", () => {
	it("records only this review's comments that have provenance, with TTL and provenance", async () => {
		const kv = createFakeKv();
		const octokit = {
			paginate: vi.fn(async () => [
				{ id: 100, path: "src/x.ts", line: 10, body: "b1", pull_request_review_id: 55 },
				{ id: 101, path: "src/y.ts", line: 20, body: "b2", pull_request_review_id: 55 },
				{ id: 102, path: "src/z.ts", line: 30, body: "b3", pull_request_review_id: 999 }, // other review
			]),
		};
		const provenance = new Map([
			["src/x.ts:10", { skills: ["code-reviewer.md"], title: "Bug" }],
			["src/y.ts:20", { skills: ["security-sast.md"], title: "XSS" }],
		]);

		const count = await persistPostedComments({
			kv,
			octokit,
			owner: "o",
			repo: "r",
			pr: 7,
			reviewId: 55,
			headSha: "sha",
			installationId: 5,
			provider: "anthropic",
			provenance,
			nowMs: NOW,
		});

		expect(count).toBe(2); // 102 excluded (different review)
		const active = await listActiveComments(kv, NOW);
		const byId = Object.fromEntries(active.map((a) => [a.commentId, a]));
		expect(byId[100]?.skills).toEqual(["code-reviewer.md"]);
		expect(byId[100]?.title).toBe("Bug");
		expect(byId[100]?.expiresAtMs).toBe(NOW + 14 * 24 * 60 * 60 * 1000);
		expect(byId[101]?.skills).toEqual(["security-sast.md"]);
		expect(byId[102]).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/feedback/persist.test.ts`
Expected: FAIL — `./persist.js` missing.

- [ ] **Step 3: Implement persist**

Create `src/feedback/persist.ts`:

```typescript
import { recordPostedComment } from "./store.js";
import type { KvClient } from "./kv.js";
import type { Provider } from "./types.js";

const TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface OctokitLike {
	paginate: (route: string, params: Record<string, unknown>) => Promise<unknown[]>;
}

interface ReviewCommentResponse {
	id: number;
	path: string;
	line: number | null;
	body: string;
	pull_request_review_id: number | null;
}

/** List a review's created comments, match each to its provenance by path:line, and persist
 * the ones we recognize so the cron can later read their reactions. Returns the count stored. */
export async function persistPostedComments(opts: {
	kv: KvClient;
	octokit: OctokitLike;
	owner: string;
	repo: string;
	pr: number;
	reviewId: number;
	headSha: string;
	installationId: number;
	provider: Provider;
	provenance: Map<string, { skills: string[]; title: string }>;
	nowMs: number;
}): Promise<number> {
	const comments = (await opts.octokit.paginate(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
		{ owner: opts.owner, repo: opts.repo, pull_number: opts.pr, per_page: 100 },
	)) as ReviewCommentResponse[];

	let count = 0;
	for (const c of comments) {
		if (c.pull_request_review_id !== opts.reviewId) continue;
		const prov = opts.provenance.get(`${c.path}:${c.line}`);
		if (!prov) continue;
		await recordPostedComment(
			opts.kv,
			{
				commentId: c.id,
				provider: opts.provider,
				installationId: opts.installationId,
				owner: opts.owner,
				repo: opts.repo,
				pr: opts.pr,
				headSha: opts.headSha,
				path: c.path,
				line: c.line ?? 0,
				skills: prov.skills,
				title: prov.title,
				body: c.body,
				postedAtMs: opts.nowMs,
				expiresAtMs: opts.nowMs + TTL_MS,
				lastSeenReactions: {},
			},
			opts.nowMs,
		);
		count++;
	}
	return count;
}
```

- [ ] **Step 4: Run tests + gates**

Run: `npm run test -- src/feedback/persist.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feedback/persist.ts src/feedback/persist.test.ts
git commit -m "feat(feedback): persist posted inline comments with provenance"
```

---

## Task 8: Wire persistence into `maybeSubmitReview`

**Files:**
- Modify: `src/github-app.ts` (`postReviewWithRetry` return type; KV singleton; pass `feedbackEnabled`; persist block)
- Test: `src/github-app.test.ts`

**Context:** `maybeSubmitReview` calls `await postReviewWithRetry(octokit, {...})` (currently returns `void`) inside a `try`, then runs best-effort blocks (PR-description patch, check-run, stale-thread resolution) each wrapped in their own try/catch. `maybeSubmitReview`'s args include `installationId`, `config`, `owner`, `repo`, `pullNumber`. `config.provider` and (new) `config.feedbackEnabled` are available.

- [ ] **Step 1: Write the failing test**

Append to `src/github-app.test.ts` (`./review.js` is already `vi.mock`ed there; add a `vi.mock("./feedback/persist.js", …)` and `vi.mock("./feedback/kv.js", …)` so no real KV is touched):

```typescript
import { persistPostedComments } from "./feedback/persist.js";
// at top-level with the other vi.mock calls:
vi.mock("./feedback/persist.js", () => ({ persistPostedComments: vi.fn(async () => 1) }));
vi.mock("./feedback/kv.js", () => ({ createUpstashKv: vi.fn(() => ({})) }));

it("persists posted comments when feedbackEnabled and a review with comments is posted", async () => {
	(buildReview as ReturnType<typeof vi.fn>).mockResolvedValue({
		event: "COMMENT",
		body: "b",
		comments: [{ path: "src/x.ts", line: 10, body: "c", side: "RIGHT" }],
		validLinesByPath: new Map(),
		metadata: { model: "m", tier1Count: 5, tier2Skills: [], generalFindings: 0, inlineComments: 1, cost: 0 },
		commentProvenance: new Map([["src/x.ts:10", { skills: ["code-reviewer.md"], title: "Bug" }]]),
	});
	// octokit.request for POST /reviews returns an id; other routes return {}.
	const octokit = {
		request: vi.fn(async (route: string) =>
			route.includes("/reviews") ? { data: { id: 55 } } : { data: {} },
		),
		paginate: vi.fn(async () => []),
	};
	const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;

	await maybeSubmitReview({
		app,
		installationId: 5,
		owner: "o",
		repo: "r",
		pullNumber: 7,
		pullRequest: { draft: false, head: { sha: "sha" }, additions: 0, deletions: 0, changed_files: 0, title: "t", body: null },
		extraInstructions: "",
		force: true,
		config: { reviewEnabled: true, reviewCommentPrefix: "ai-review-bot", provider: "anthropic", feedbackEnabled: true } as never,
	});

	expect(persistPostedComments).toHaveBeenCalledWith(
		expect.objectContaining({ owner: "o", repo: "r", pr: 7, reviewId: 55, installationId: 5, provider: "anthropic" }),
	);
});

it("does NOT persist when feedbackEnabled is false", async () => {
	(persistPostedComments as ReturnType<typeof vi.fn>).mockClear();
	(buildReview as ReturnType<typeof vi.fn>).mockResolvedValue({
		event: "COMMENT",
		body: "b",
		comments: [{ path: "src/x.ts", line: 10, body: "c", side: "RIGHT" }],
		validLinesByPath: new Map(),
		metadata: { model: "m", tier1Count: 5, tier2Skills: [], generalFindings: 0, inlineComments: 1, cost: 0 },
		commentProvenance: new Map([["src/x.ts:10", { skills: ["code-reviewer.md"], title: "Bug" }]]),
	});
	const octokit = {
		request: vi.fn(async (route: string) => (route.includes("/reviews") ? { data: { id: 55 } } : { data: {} })),
		paginate: vi.fn(async () => []),
	};
	const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;
	await maybeSubmitReview({
		app, installationId: 5, owner: "o", repo: "r", pullNumber: 7,
		pullRequest: { draft: false, head: { sha: "sha" }, additions: 0, deletions: 0, changed_files: 0, title: "t", body: null },
		extraInstructions: "", force: true,
		config: { reviewEnabled: true, reviewCommentPrefix: "ai-review-bot", provider: "anthropic", feedbackEnabled: false } as never,
	});
	expect(persistPostedComments).not.toHaveBeenCalled();
});

it("a persistence failure does not fail the review", async () => {
	(persistPostedComments as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("kv down"));
	(buildReview as ReturnType<typeof vi.fn>).mockResolvedValue({
		event: "COMMENT", body: "b",
		comments: [{ path: "src/x.ts", line: 10, body: "c", side: "RIGHT" }],
		validLinesByPath: new Map(),
		metadata: { model: "m", tier1Count: 5, tier2Skills: [], generalFindings: 0, inlineComments: 1, cost: 0 },
		commentProvenance: new Map([["src/x.ts:10", { skills: ["x"], title: "t" }]]),
	});
	const octokit = {
		request: vi.fn(async (route: string) => (route.includes("/reviews") ? { data: { id: 55 } } : { data: {} })),
		paginate: vi.fn(async () => []),
	};
	const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;
	await expect(
		maybeSubmitReview({
			app, installationId: 5, owner: "o", repo: "r", pullNumber: 7,
			pullRequest: { draft: false, head: { sha: "sha" }, additions: 0, deletions: 0, changed_files: 0, title: "t", body: null },
			extraInstructions: "", force: true,
			config: { reviewEnabled: true, reviewCommentPrefix: "ai-review-bot", provider: "anthropic", feedbackEnabled: true } as never,
		}),
	).resolves.not.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/github-app.test.ts`
Expected: FAIL — persistence not wired; `postReviewWithRetry` returns void so no `reviewId`.

- [ ] **Step 3: Implement in `src/github-app.ts`**

3a. Imports at the top:

```typescript
import { createUpstashKv } from "./feedback/kv.js";
import { persistPostedComments } from "./feedback/persist.js";
import type { KvClient } from "./feedback/kv.js";
```

3b. Lazy KV singleton (module scope):

```typescript
let kvSingleton: KvClient | null = null;
function getKv(): KvClient | null {
	if (kvSingleton) return kvSingleton;
	try {
		kvSingleton = createUpstashKv();
		return kvSingleton;
	} catch (err) {
		console.error("feedback: KV unavailable — skipping persistence", err);
		return null;
	}
}
```

3c. Make `postReviewWithRetry` return the created review id. Change its signature to `Promise<number>` and, on the successful request, capture and return the id:

```typescript
			const response = await octokit.request(
				"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
				{ /* unchanged params */ },
			);
			return (response.data as { id: number }).id;
```

(Leave the retry/`throw lastError` flow otherwise unchanged. The function currently `return;`s on success — replace that with the `return id` above. TypeScript will require all success paths to return a number; the catch/throw path is fine.)

3d. In `maybeSubmitReview`: pass `feedbackEnabled` into the `buildReview({...})` context object literal (next to `provider: config.provider`):

```typescript
		provider: config.provider,
		feedbackEnabled: config.feedbackEnabled,
```

3e. Capture the review id and add a best-effort persist block. Change `await postReviewWithRetry(...)` to `const reviewId = await postReviewWithRetry(...)`, and after the existing best-effort blocks (PR-description patch, check-run, stale-thread) but still inside the `try`, add:

```typescript
			if (
				config.feedbackEnabled &&
				review.comments.length > 0 &&
				review.commentProvenance &&
				review.commentProvenance.size > 0
			) {
				try {
					const kv = getKv();
					if (kv) {
						const stored = await persistPostedComments({
							kv,
							octokit,
							owner,
							repo,
							pr: pullNumber,
							reviewId,
							headSha,
							installationId,
							provider: config.provider,
							provenance: review.commentProvenance,
							nowMs: Date.now(),
						});
						console.log("feedback: recorded posted comments", { owner, repo, pullNumber, stored });
					}
				} catch (feedbackErr) {
					console.error("feedback: failed to record posted comments", feedbackErr);
				}
			}
```

- [ ] **Step 4: Run tests + gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS. (If other `maybeSubmitReview` tests assert `postReviewWithRetry` interactions, they remain valid — the function still posts the same request; it now also returns the id.)

- [ ] **Step 5: Commit**

```bash
git add src/github-app.ts src/github-app.test.ts
git commit -m "feat(github-app): persist inline comments for feedback after posting (best-effort)"
```

---

## Task 9: Cron handler core + endpoint + Vercel config + docs

> Logic lives in `src/feedback/cron.ts` (covered by the existing `src/**` test glob); `api/cron/poll-feedback.ts` is a thin shim with nothing to unit-test. This avoids placing a test under `api/` (which the vitest `include` may not cover) and keeps the handler logic testable.

**Files:**
- Create: `src/feedback/cron.ts`, `src/feedback/cron.test.ts`, `api/cron/poll-feedback.ts`
- Modify: `vercel.json`, `.env.example`

- [ ] **Step 1: Write the failing test**

Create `src/feedback/cron.test.ts` (drives the real `runFeedbackPoll` with a FakeKv that has no active comments, so no mocking of the poller is needed — we test the auth + enabled gates + wiring):

```typescript
import { describe, expect, it, vi } from "vitest";
import { createFakeKv } from "./kv.fake.js";
import { pollFeedbackRequest } from "./cron.js";

function buildDeps() {
	return { kv: createFakeKv(), getOctokit: vi.fn(), nowMs: 1_000_000 };
}

describe("pollFeedbackRequest", () => {
	it("401s when the authorization does not match the secret", async () => {
		const out = await pollFeedbackRequest({
			authorization: undefined,
			secret: "s3cret",
			feedbackEnabled: true,
			buildDeps,
		});
		expect(out.status).toBe(401);
	});

	it("401s when no secret is configured", async () => {
		const out = await pollFeedbackRequest({
			authorization: "Bearer x",
			secret: undefined,
			feedbackEnabled: true,
			buildDeps,
		});
		expect(out.status).toBe(401);
	});

	it("skips (200) when feedback is disabled, without building deps", async () => {
		const deps = vi.fn(buildDeps);
		const out = await pollFeedbackRequest({
			authorization: "Bearer s3cret",
			secret: "s3cret",
			feedbackEnabled: false,
			buildDeps: deps,
		});
		expect(out.status).toBe(200);
		expect(out.body).toMatchObject({ skipped: expect.any(String) });
		expect(deps).not.toHaveBeenCalled();
	});

	it("runs the poll (200) when authorized and enabled", async () => {
		const out = await pollFeedbackRequest({
			authorization: "Bearer s3cret",
			secret: "s3cret",
			feedbackEnabled: true,
			buildDeps,
		});
		expect(out.status).toBe(200);
		expect(out.body).toEqual({ polled: 0, events: 0, pruned: 0 });
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/feedback/cron.test.ts`
Expected: FAIL — `./cron.js` missing.

- [ ] **Step 3: Implement the handler core**

Create `src/feedback/cron.ts`:

```typescript
import { type PollDeps, runFeedbackPoll } from "./poll.js";

/** Framework-agnostic cron logic: verify the secret, check the feature flag, run one poll.
 * `buildDeps` is only invoked once authorized AND enabled (so KV/app clients aren't built
 * for rejected calls). Returns the HTTP status + JSON body for the caller to send. */
export async function pollFeedbackRequest(opts: {
	authorization: string | undefined;
	secret: string | undefined;
	feedbackEnabled: boolean;
	buildDeps: () => PollDeps;
}): Promise<{ status: number; body: unknown }> {
	if (!opts.secret || opts.authorization !== `Bearer ${opts.secret}`) {
		return { status: 401, body: { error: "Unauthorized" } };
	}
	if (!opts.feedbackEnabled) {
		return { status: 200, body: { skipped: "FEEDBACK_ENABLED is not true" } };
	}
	const result = await runFeedbackPoll(opts.buildDeps());
	return { status: 200, body: result };
}
```

> Export `PollDeps` from `src/feedback/poll.ts` (it is already declared there as an `export interface`).

- [ ] **Step 4: Implement the thin Vercel endpoint**

Create `api/cron/poll-feedback.ts`:

```typescript
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { pollFeedbackRequest } from "../../src/feedback/cron.js";
import { createUpstashKv } from "../../src/feedback/kv.js";
import type { Provider } from "../../src/feedback/types.js";
import { getGitHubApp, getOpenAIGitHubApp } from "../../src/github-app.js";

interface OctokitLike {
	request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
	const { status, body } = await pollFeedbackRequest({
		authorization: req.headers.authorization,
		secret: process.env.CRON_SECRET,
		feedbackEnabled: process.env.FEEDBACK_ENABLED === "true",
		buildDeps: () => ({
			kv: createUpstashKv(),
			getOctokit: async (provider: Provider, installationId: number): Promise<OctokitLike> => {
				const app = provider === "anthropic" ? getGitHubApp() : getOpenAIGitHubApp();
				return (await app.getInstallationOctokit(installationId)) as unknown as OctokitLike;
			},
			nowMs: Date.now(),
		}),
	});
	console.log("feedback poll request", { status, body });
	res.status(status).json(body);
}
```

- [ ] **Step 5: Add the Vercel Cron + function config**

In `vercel.json`, add a `crons` array and a function entry for the new endpoint:

```jsonc
{
	"buildCommand": "",
	"functions": {
		"api/github/webhook.ts": { "maxDuration": 800 },
		"api/github/webhook-openai.ts": { "maxDuration": 800 },
		"api/cron/poll-feedback.ts": { "maxDuration": 60 }
	},
	"crons": [{ "path": "/api/cron/poll-feedback", "schedule": "*/10 * * * *" }]
}
```

- [ ] **Step 5: Document env vars**

Append to `.env.example` (under the shared-behavior block):

```bash
# Inline-comment feedback capture (all optional)
# FEEDBACK_ENABLED=false       # set true to record 👍/👎 reactions on inline comments
# KV_REST_API_URL=             # Upstash Redis REST URL (required when FEEDBACK_ENABLED=true)
# KV_REST_API_TOKEN=           # Upstash Redis REST token (required when FEEDBACK_ENABLED=true)
# CRON_SECRET=                 # shared secret the /api/cron/poll-feedback endpoint requires
```

- [ ] **Step 6: Run the full suite + gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/cron/poll-feedback.ts api/cron/poll-feedback.test.ts vercel.json .env.example
git commit -m "feat(feedback): Vercel Cron endpoint to poll reactions + env docs"
```

---

## Self-review checklist (run after all tasks)

- Spec §Components — every file in the table has a task: types/kv/fake → T1; store → T2; reactions → T3; poll → T4; config → T5; review provenance+invite → T6; persist → T7; github-app wiring → T8; cron+vercel+env → T9. ✓
- `PostedCommentRecord` / `FeedbackEvent` field names are identical across `types.ts`, `store.ts`, `reactions.ts`, `persist.ts`. ✓
- `KvClient` method names match between `kv.ts`, `kv.fake.ts`, and every `store.ts` call. ✓
- Verdict mapping (`+1`→up, `-1`→down, others ignored) lives only in `computeReactionDelta`. ✓
- Recording is best-effort everywhere it touches the review path (T8 wraps persist in try/catch; KV-unavailable returns null). ✓
- Nothing reads reactions via webhooks (none exist); only the cron polls. ✓

## Manual verification (post-deploy)

- Provision Upstash KV; set `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `CRON_SECRET`, `FEEDBACK_ENABLED=true` in Vercel.
- Open a PR, let the bot post inline comments; confirm the summary shows the 👍/👎 invitation line and `fb:poll` + `fb:cmt:*` keys appear in KV.
- React 👍 on one inline comment and 👎 on another; within ~10 min confirm two entries appear in the `fb:events` list with the correct `skills`, `verdict`, and `reactor`.
- Confirm re-running the cron does not duplicate events (idempotent), and that an expired (>14d) comment is pruned from `fb:poll`.
