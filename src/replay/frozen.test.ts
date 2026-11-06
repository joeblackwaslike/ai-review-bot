import { describe, expect, it } from "vitest";
import { freezeFixture } from "./frozen.js";
import type { ReplayFixture, Round } from "./types.js";

function round(index: number, submittedAt: string): Round {
	return {
		index,
		reviewId: index,
		provider: "anthropic",
		submittedAt,
		headSha: `h${index}`,
		baseSha: "b",
		mergeBase: null,
		triggerAt: null,
		approximate: false,
		commitsSince: [],
		claims: [],
		trace: { candidates: [], posted: [], usage: {} },
	};
}

function reply(id: number, createdAt: string) {
	return { id, author: "a", createdAt, editedAt: null, body: `r${id}` };
}

function build(
	extraReplies = [reply(3, "2026-01-03T00:00:00Z")],
): ReplayFixture {
	return {
		schemaVersion: 1,
		owner: "o",
		repo: "r",
		pull: 1,
		provider: "anthropic",
		author: "me",
		recordedAt: "2026-02-01T00:00:00Z",
		rounds: [
			round(0, "2026-01-01T00:00:00Z"),
			round(1, "2026-01-02T00:00:00Z"),
			round(2, "2026-01-04T00:00:00Z"),
		],
		threads: [
			{
				threadId: "t",
				commentId: 10,
				isResolved: true,
				isOutdated: false,
				resolvedBy: "me",
				replies: [reply(1, "2026-01-01T12:00:00Z"), ...extraReplies],
			},
		],
		reactions: [
			{
				commentId: 10,
				user: "u",
				content: "+1",
				createdAt: "2026-01-01T13:00:00Z",
			},
			{
				commentId: 10,
				user: "v",
				content: "-1",
				createdAt: "2026-01-05T00:00:00Z",
			},
		],
	};
}

describe("freezeFixture", () => {
	it("drops later rounds, replies and reactions and counts them", () => {
		const f = freezeFixture(build(), 1);
		expect(f.rounds.map((r) => r.index)).toEqual([0, 1]);
		expect(f.rounds.every((r) => r.trace === undefined)).toBe(true);
		expect(f.threads[0]?.replies.map((r) => r.id)).toEqual([1]);
		expect(f.reactions.map((r) => r.user)).toEqual(["u"]);
		expect(f.excluded).toEqual({ unknownTimestamp: 0, later: 3 });
	});

	it("recomputes isResolved as false because resolution time is not recorded", () => {
		const f = freezeFixture(build(), 1);
		expect(f.threads[0]?.isResolved).toBe(false);
		expect(f.threads[0]?.resolvedBy).toBeNull();
	});

	it("excludes items with unparseable timestamps and counts them", () => {
		const f = freezeFixture(build([reply(4, "unknown")]), 1);
		expect(f.threads[0]?.replies.map((r) => r.id)).toEqual([1]);
		expect(f.excluded.unknownTimestamp).toBe(1);
	});

	it("does not mutate the source fixture", () => {
		const src = build();
		freezeFixture(src, 0);
		expect(src.rounds).toHaveLength(3);
		expect(src.threads[0]?.replies).toHaveLength(2);
	});
});
