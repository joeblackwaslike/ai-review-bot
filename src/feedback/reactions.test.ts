import { describe, expect, it, vi } from "vitest";
import { computeReactionDelta, diffReactions } from "./reactions.js";
import type { PostedCommentRecord } from "./types.js";

describe("computeReactionDelta", () => {
	it("emits a change for a new verdict and records it in lastSeen", () => {
		const out = computeReactionDelta(
			[{ login: "octocat", content: "+1", createdAtMs: 100 }],
			{},
		);
		expect(out.changes).toEqual([
			{ reactor: "octocat", verdict: "up", reactedAtMs: 100 },
		]);
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
		expect(out.changes).toEqual([
			{ reactor: "octocat", verdict: "down", reactedAtMs: 200 },
		]);
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
		expect(out.changes).toEqual([
			{ reactor: "octocat", verdict: "down", reactedAtMs: 200 },
		]);
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
					{
						user: { login: "maint" },
						content: "-1",
						created_at: "2026-06-10T00:00:00Z",
					},
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

	it("falls back to nowMs when a reaction timestamp is unparseable", async () => {
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
					{ user: { login: "m" }, content: "+1", created_at: "not-a-date" },
				],
			})),
		};

		const { events } = await diffReactions(octokit, record, 999);
		expect(events[0]?.reactedAtMs).toBe(999);
	});
});
