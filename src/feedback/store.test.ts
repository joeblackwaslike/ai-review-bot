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
		reviewer: "claude",
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
		await recordPostedComment(
			kv,
			rec({ commentId: 1, expiresAtMs: NOW + DAY }),
			NOW,
		);
		await recordPostedComment(
			kv,
			rec({ commentId: 2, expiresAtMs: NOW - DAY }),
			NOW,
		);
		const removed = await prune(kv, NOW);
		expect(removed).toBe(1);
		const active = await listActiveComments(kv, NOW);
		expect(active.map((c) => c.commentId)).toEqual([1]);
	});

	it("prune does not remove a comment expiring exactly at nowMs (inclusive active boundary)", async () => {
		const kv = createFakeKv();
		await recordPostedComment(kv, rec({ commentId: 1, expiresAtMs: NOW }), NOW);
		const removed = await prune(kv, NOW);
		expect(removed).toBe(0);
		const active = await listActiveComments(kv, NOW);
		expect(active.map((c) => c.commentId)).toEqual([1]);
	});

	it("appendFeedbackEvent pushes onto the events list", async () => {
		const kv = createFakeKv();
		const event: FeedbackEvent = {
			commentId: 1,
			reviewer: "claude",
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

	it("reads back a record stored before reviewer existed, under the same KV key", async () => {
		const kv = createFakeKv();
		const { reviewer: _drop, ...legacy } = rec({
			commentId: 9,
			provider: "openai",
		});
		await kv.set("fb:cmt:openai:9", JSON.stringify(legacy), 60);
		await kv.zadd("fb:poll", NOW + DAY, "openai:9");
		const active = await listActiveComments(kv, NOW);
		expect(active).toHaveLength(1);
		expect(active[0]?.reviewer).toBe("codex");
		expect(active[0]?.provider).toBe("openai");
	});

	it("keeps the legacy fb:cmt key for claude and codex", async () => {
		const kv = createFakeKv();
		await recordPostedComment(kv, rec({ commentId: 3 }), NOW);
		await recordPostedComment(
			kv,
			rec({ commentId: 3, provider: "openai", reviewer: "codex" }),
			NOW,
		);
		expect([...kv._dump().strings.keys()].sort()).toEqual([
			"fb:cmt:anthropic:3",
			"fb:cmt:openai:3",
		]);
	});

	it("gives two reviewers on one provider distinct rows for the same comment id", async () => {
		const kv = createFakeKv();
		await recordPostedComment(kv, rec({ commentId: 4 }), NOW);
		await recordPostedComment(
			kv,
			rec({ commentId: 4, provider: "claude-lite", reviewer: "claude-lite" }),
			NOW,
		);
		const active = await listActiveComments(kv, NOW);
		expect(active.map((r) => r.reviewer).sort()).toEqual([
			"claude",
			"claude-lite",
		]);
		expect([...kv._dump().strings.keys()].sort()).toEqual([
			"fb:cmt:anthropic:4",
			"fb:cmt:claude-lite:4",
		]);
	});
});
