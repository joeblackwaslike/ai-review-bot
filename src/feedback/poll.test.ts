import { describe, expect, it, vi } from "vitest";
import { createFakeKv } from "./kv.fake.js";
import { runFeedbackPoll } from "./poll.js";
import { listActiveComments, recordPostedComment } from "./store.js";
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
		await recordPostedComment(
			kv,
			rec({ commentId: 2, expiresAtMs: NOW - DAY }),
			NOW,
		);

		const octokit = {
			request: vi.fn(async () => ({
				data: [
					{
						user: { login: "maint" },
						content: "+1",
						created_at: "2026-06-10T00:00:00Z",
					},
				],
			})),
		};
		const getOctokit = vi.fn(async () => octokit);

		const result = await runFeedbackPoll({ kv, getOctokit, nowMs: NOW });

		expect(result).toEqual({ polled: 1, events: 1, pruned: 1 });
		const events = kv._dump().lists.get("fb:events");
		expect(events).toHaveLength(1);
		expect(JSON.parse(events?.[0] as string)).toMatchObject({
			commentId: 1,
			verdict: "up",
			reactor: "maint",
		});
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
				.mockResolvedValue({
					data: [
						{
							user: { login: "m" },
							content: "-1",
							created_at: "2026-06-10T00:00:00Z",
						},
					],
				}),
		};
		const result = await runFeedbackPoll({
			kv,
			getOctokit: async () => octokit,
			nowMs: NOW,
		});
		expect(result.polled).toBe(2);
		expect(result.events).toBe(1); // one failed, one succeeded
		const active = await listActiveComments(kv, NOW);
		const failed = active.find((c) => c.commentId === 1);
		expect(failed?.lastSeenReactions).toEqual({}); // errored comment not advanced
	});
});
