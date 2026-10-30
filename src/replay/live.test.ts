import { describe, expect, it } from "vitest";
import { runLiveTier } from "./live.js";
import type { LabelFile, PostedClaim, ReplayFixture, Round } from "./types.js";

function claim(id: string, roundIndex: number, title: string): PostedClaim {
	return {
		id,
		roundIndex,
		reviewId: 1,
		source: "inline",
		commentId: 1,
		path: "src/a.ts",
		line: 10,
		severity: "P1",
		title,
		text: title,
	};
}

function round(index: number, claims: PostedClaim[]): Round {
	return {
		index,
		reviewId: index,
		provider: "anthropic",
		submittedAt: "2026-01-01T00:00:00Z",
		headSha: `h${index}`,
		baseSha: "b",
		mergeBase: null,
		triggerAt: null,
		approximate: false,
		commitsSince: [],
		claims,
	};
}

const fixture = {
	rounds: [
		round(0, [claim("c0", 0, "Missing null check on user input")]),
		round(1, [claim("c1", 1, "Missing null check on user input")]),
	],
} as unknown as ReplayFixture;

function labels(confirmed: boolean): LabelFile {
	return {
		fixtureId: "x",
		provisional: false,
		labels: [
			{
				claimId: "c0",
				label: "fixed",
				confidence: "high",
				evidence: [],
				confirmed,
			},
			{
				claimId: "c1",
				label: "rejected",
				confidence: "high",
				evidence: [],
				confirmed,
			},
		],
		repeatPairs: [{ later: "c1", earlier: "c0", confirmed }],
		negativePairs: [],
		allowedSuppression: [],
	};
}

const finding = (title: string, path = "src/a.ts") => ({
	title,
	path,
	line: 10,
});

function base(over: Partial<Parameters<typeof runLiveTier>[0]> = {}) {
	const lines: string[] = [];
	const calls: string[] = [];
	const opts: Parameters<typeof runLiveTier>[0] = {
		fixture,
		labels: labels(true),
		rounds: [0, 1],
		maxCostUsd: 10,
		review: async (d) => {
			calls.push(d);
			return [];
		},
		estimateCost: () => 1,
		fetchDiff: async (r) => ({ diff: `diff-${r.index}`, approximate: false }),
		out: (s) => lines.push(s),
		...over,
	};
	return { opts, lines, calls };
}

describe("runLiveTier", () => {
	it("stops before a round whose estimated cost would exceed maxCostUsd", async () => {
		const { opts, calls } = base({ maxCostUsd: 1.5 });
		const report = await runLiveTier(opts);
		expect(calls).toEqual(["diff-0"]);
		expect(report.rounds).toHaveLength(1);
		expect(report.spentUsd).toBe(1);
	});

	it("prints the total estimated spend before the first review call", async () => {
		const order: string[] = [];
		const { opts } = base({
			out: (s) => order.push(`out:${s}`),
			review: async () => {
				order.push("review");
				return [];
			},
		});
		await runLiveTier(opts);
		expect(order[0]).toMatch(/^out:.*\$2\.00/);
		expect(order.indexOf("review")).toBeGreaterThan(0);
	});

	it("matches live findings only through confirmed pairs and reports the rest as newUnlabeled", async () => {
		const review = async () => [
			finding("Missing null check on user input"),
			finding("Totally different concern about caching", "src/b.ts"),
		];
		const confirmed = await runLiveTier(base({ review, rounds: [1] }).opts);
		expect(confirmed.rounds[0]).toMatchObject({
			matchedRejected: 1,
			matchedFixed: 0,
			newUnlabeled: 1,
		});
		const unconfirmed = await runLiveTier(
			base({ review, rounds: [1], labels: labels(false) }).opts,
		);
		expect(unconfirmed.rounds[0]).toMatchObject({
			matchedRejected: 0,
			matchedFixed: 0,
			newUnlabeled: 2,
		});
	});

	it("reports no accuracy figure for newUnlabeled findings", async () => {
		const { opts, lines } = base({
			review: async () => [finding("Brand new thing", "src/z.ts")],
			rounds: [0],
		});
		await runLiveTier(opts);
		const text = lines.join("\n");
		expect(text).toContain("1 new unlabeled");
		expect(text).not.toMatch(/\d%/);
	});

	it("counts raw and self-retracted findings per round without dropping them", async () => {
		const { opts, lines } = base({
			rounds: [0],
			review: async () => [
				{
					...finding("Queue slot"),
					body: "It is intended. No actionable defect found.",
					severity: "P3",
				},
				{
					...finding("Auth bypass"),
					body: "No actionable defect found.",
					severity: "P0",
				},
				{ ...finding("Real issue"), body: "The socket is never closed." },
			],
		});
		const report = await runLiveTier(opts);
		expect(report.rounds[0]).toMatchObject({ raw: 3, retracted: 1 });
		expect(lines.join("\n")).toContain("3 raw findings, 1 self-retracted");
		expect(report.rounds[0]?.newUnlabeled).toBe(3);
	});

	it("marks a round approximate when fetchDiff says the history was rewritten", async () => {
		const { opts } = base({
			rounds: [0],
			fetchDiff: async () => ({ diff: "d", approximate: true }),
		});
		const report = await runLiveTier(opts);
		expect(report.rounds[0]?.approximate).toBe(true);
	});
});
