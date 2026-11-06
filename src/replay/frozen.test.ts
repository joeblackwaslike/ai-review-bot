import { describe, expect, it } from "vitest";
import { freezeFixture } from "./frozen.js";
import type { PostedClaim, ReplayFixture, Round } from "./types.js";

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

function reply(id: number, createdAt: string, editedAt: string | null = null) {
	return { id, author: "a", createdAt, editedAt, body: `r${id}` };
}

function claimOn(roundIndex: number, commentId: number): PostedClaim {
	return {
		id: `c${commentId}`,
		roundIndex,
		reviewId: roundIndex,
		source: "inline",
		commentId,
		path: "a.ts",
		line: 1,
		severity: "P1",
		title: "t",
		text: "t",
	};
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

	it("keeps the cutoff round's metadata but empties its claims, earlier rounds keep theirs", () => {
		const src = build();
		const [r0, r1, r2] = src.rounds as [Round, Round, Round];
		r0.claims = [claimOn(0, 100)];
		r1.claims = [claimOn(1, 101)];
		r2.claims = [claimOn(2, 102)];
		const f = freezeFixture(src, 1);
		expect(f.rounds[0]?.claims).toHaveLength(1);
		expect(f.rounds[1]).toMatchObject({ index: 1, headSha: "h1", claims: [] });
		expect(f.rounds).toHaveLength(2);
		expect(src.rounds[1]?.claims).toHaveLength(1);
	});

	it("sets isOutdated false on kept threads", () => {
		const src = build();
		(src.threads[0] as { isOutdated: boolean }).isOutdated = true;
		expect(freezeFixture(src, 1).threads[0]?.isOutdated).toBe(false);
	});

	it("drops threads rooted on a claim of the cutoff or a later round and counts them as later", () => {
		const src = build();
		const [r0, r1, r2] = src.rounds as [Round, Round, Round];
		r0.claims = [claimOn(0, 10)];
		r1.claims = [claimOn(1, 11)];
		r2.claims = [claimOn(2, 12)];
		const mkThread = (commentId: number) => ({
			threadId: `t${commentId}`,
			commentId,
			isResolved: false,
			isOutdated: false,
			resolvedBy: null,
			replies: [],
		});
		src.threads = [mkThread(10), mkThread(11), mkThread(12)];
		src.reactions = [];
		const f = freezeFixture(src, 1);
		expect(f.threads.map((t) => t.commentId)).toEqual([10]);
		expect(f.excluded.later).toBe(3);
	});

	it("excludes replies edited after the cutoff, and counts unparseable edit times as unknown", () => {
		const src = build([
			reply(5, "2026-01-01T14:00:00Z", "2026-01-09T00:00:00Z"),
			reply(6, "2026-01-01T15:00:00Z", "garbage"),
			reply(7, "2026-01-01T16:00:00Z", "2026-01-01T17:00:00Z"),
		]);
		const f = freezeFixture(src, 1);
		expect(f.threads[0]?.replies.map((r) => r.id)).toEqual([1, 7]);
		expect(f.excluded).toEqual({ unknownTimestamp: 1, later: 3 });
	});
});
