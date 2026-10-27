import { describe, expect, it } from "vitest";
import type { GhClient } from "./gh.js";
import { recordPr } from "./record.js";

const BOT = "anthropicreviewbot";
const AUTHOR = "joe";
const NOW = () => new Date("2026-10-27T00:00:00Z");

interface World {
	reviews: object[];
	comments: object[];
	reactions: Record<number, object[]>;
	threads: object[];
	compares: Record<string, object | Error>;
	commits: Record<string, object>;
}

function review(id: number, sha: string | null, at: string, login = BOT) {
	return {
		id,
		user: { login },
		submitted_at: at,
		commit_id: "ffff",
		body: sha ? `summary\n<!-- ai-review:sha=${sha} -->` : "summary",
	};
}

function comment(id: number, reviewId: number, body: string, login = BOT) {
	return {
		id,
		pull_request_review_id: reviewId,
		user: { login },
		path: "a.ts",
		line: 10,
		body,
	};
}

function fake(w: Partial<World> = {}): GhClient {
	const world: World = {
		reviews: [],
		comments: [],
		reactions: {},
		threads: [],
		compares: {},
		commits: {},
		...w,
	};
	return {
		async rest(route: string) {
			if (/\/pulls\/1$/.test(route))
				return { user: { login: AUTHOR }, base: { sha: "base0" } } as never;
			if (route.endsWith("/pulls/1/reviews")) return world.reviews as never;
			if (route.endsWith("/pulls/1/comments")) return world.comments as never;
			const rx = route.match(/comments\/(\d+)\/reactions$/);
			if (rx) return (world.reactions[Number(rx[1])] ?? []) as never;
			const cmp = route.match(/compare\/(.+)$/);
			if (cmp) {
				const r = world.compares[cmp[1]];
				if (!r || r instanceof Error) throw r ?? new Error("404");
				return r as never;
			}
			const cm = route.match(/commits\/(\w+)$/);
			if (cm && world.commits[cm[1]]) return world.commits[cm[1]] as never;
			throw new Error(`unexpected ${route}`);
		},
		async graphql() {
			return {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: world.threads,
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			} as never;
		},
	};
}

const opts = {
	owner: "o",
	repo: "r",
	pull: 1,
	provider: "anthropic" as const,
	botLogin: BOT,
	now: NOW,
};

const twoReviews = [
	review(2, "bbb2222", "2026-10-02T00:00:00Z"),
	review(1, "aaa1111", "2026-10-01T00:00:00Z"),
	review(3, null, "2026-10-01T12:00:00Z", "codexreviewbot"),
];

describe("recordPr", () => {
	it("builds one round per bot review in submit order", async () => {
		const fx = await recordPr(fake({ reviews: twoReviews }), opts);
		expect(fx.rounds.map((r) => r.index)).toEqual([0, 1]);
		expect(fx.rounds.map((r) => r.headSha)).toEqual(["aaa1111", "bbb2222"]);
		expect(fx.rounds[1].baseSha).toBe("aaa1111");
		expect(fx.author).toBe(AUTHOR);
	});

	it("splits a three-claim inline comment into three claims with one commentId", async () => {
		const body = ["**P1** **A**", "**B**", "**C**"].join("\n\n---\n\n");
		const fx = await recordPr(
			fake({ reviews: twoReviews, comments: [comment(10, 1, body)] }),
			opts,
		);
		const claims = fx.rounds[0].claims.filter((c) => c.source === "inline");
		expect(claims.map((c) => c.title)).toEqual(["A", "B", "C"]);
		expect(new Set(claims.map((c) => c.commentId))).toEqual(new Set([10]));
		expect(new Set(claims.map((c) => c.id)).size).toBe(3);
	});

	it("ignores reviews and replies from other bots", async () => {
		const fx = await recordPr(
			fake({
				reviews: twoReviews,
				comments: [
					comment(10, 1, "**A**"),
					comment(11, 3, "**X**", "codexreviewbot"),
				],
				threads: [
					thread("T1", 10, [
						["bot", BOT, "x"],
						["r1", "codexreviewbot", "hi"],
						["r2", AUTHOR, "done"],
					]),
				],
			}),
			opts,
		);
		expect(fx.rounds).toHaveLength(2);
		expect(fx.rounds.flatMap((r) => r.claims).map((c) => c.commentId)).toEqual([
			10,
		]);
		expect(fx.threads[0]?.replies.map((r) => r.author)).toEqual([AUTHOR]);
	});

	it("keeps only reactions from the PR author, with actor and createdAt", async () => {
		const fx = await recordPr(
			fake({
				reviews: twoReviews,
				comments: [comment(10, 1, "**A**")],
				reactions: {
					10: [
						{ user: { login: AUTHOR }, content: "+1", created_at: "t1" },
						{ user: { login: "other" }, content: "-1", created_at: "t2" },
					],
				},
			}),
			opts,
		);
		expect(fx.reactions).toEqual([
			{ commentId: 10, user: AUTHOR, content: "+1", createdAt: "t1" },
		]);
	});

	it("stores thread isOutdated, isResolved and resolvedBy", async () => {
		const t = thread("T1", 10, [["bot", BOT, "x"]]);
		Object.assign(t, {
			isResolved: true,
			isOutdated: true,
			resolvedBy: { login: AUTHOR },
		});
		const fx = await recordPr(
			fake({
				reviews: twoReviews,
				comments: [comment(10, 1, "**A**")],
				threads: [t],
			}),
			opts,
		);
		expect(fx.threads[0]).toMatchObject({
			threadId: "T1",
			commentId: 10,
			isResolved: true,
			isOutdated: true,
			resolvedBy: AUTHOR,
		});
	});

	it("marks a round approximate when its head SHA is missing from the compare response", async () => {
		const fx = await recordPr(
			fake({
				reviews: twoReviews,
				compares: {
					"base0...aaa1111": {
						merge_base_commit: { sha: "mb" },
						commits: [{ sha: "other", commit: { committer: { date: "d" } } }],
					},
				},
			}),
			opts,
		);
		expect(fx.rounds[0].approximate).toBe(true);
		expect(fx.rounds[0].triggerAt).toBeNull();
		expect(fx.rounds[1].approximate).toBe(true);
	});

	it("records changed files and hunk line ranges per commit between rounds but no patch text", async () => {
		const patch = "@@ -1,2 +1,3 @@\n a\n+b\n@@ -20 +21 @@\n-x\n+y";
		const fx = await recordPr(
			fake({
				reviews: twoReviews,
				compares: {
					"base0...aaa1111": cmpOf("aaa1111", "2026-09-30T00:00:00Z"),
					"aaa1111...bbb2222": cmpOf("bbb2222", "2026-10-01T23:00:00Z"),
				},
				commits: {
					bbb2222: { files: [{ filename: "a.ts", patch }] },
					aaa1111: { files: [] },
				},
			}),
			opts,
		);
		const round = fx.rounds[1];
		expect(round.approximate).toBe(false);
		expect(round.mergeBase).toBe("mb");
		expect(round.triggerAt).toBe("2026-10-01T23:00:00Z");
		expect(round.commitsSince[0].files).toEqual([
			{
				path: "a.ts",
				ranges: [
					[1, 3],
					[21, 21],
				],
			},
		]);
		expect(JSON.stringify(fx)).not.toContain("+y");
	});

	it("stores editedAt for an edited reply and keeps the original createdAt", async () => {
		const t = thread("T1", 10, [
			["bot", BOT, "x"],
			["r1", AUTHOR, "fixed"],
		]);
		(t as { comments: { nodes: object[] } }).comments.nodes[1] = {
			databaseId: 99,
			author: { login: AUTHOR },
			body: "fixed",
			createdAt: "2026-10-01T00:00:00Z",
			lastEditedAt: "2026-10-03T00:00:00Z",
		};
		const fx = await recordPr(
			fake({
				reviews: twoReviews,
				comments: [comment(10, 1, "**A**")],
				threads: [t],
			}),
			opts,
		);
		expect(fx.threads[0].replies[0]).toMatchObject({
			id: 99,
			createdAt: "2026-10-01T00:00:00Z",
			editedAt: "2026-10-03T00:00:00Z",
		});
	});
});

function cmpOf(sha: string, date: string) {
	return {
		merge_base_commit: { sha: "mb" },
		commits: [{ sha, commit: { committer: { date } } }],
	};
}

function thread(id: string, firstId: number, cs: [string, string, string][]) {
	return {
		id,
		isResolved: false,
		isOutdated: false,
		resolvedBy: null,
		comments: {
			nodes: cs.map(([k, login, body], i) => ({
				databaseId: i === 0 ? firstId : k === "r1" ? 98 : 97,
				author: { login },
				body,
				createdAt: "2026-10-01T00:00:00Z",
				lastEditedAt: null,
			})),
		},
	};
}
