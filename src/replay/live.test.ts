import { describe, expect, it } from "vitest";
import {
	type LiveFinding,
	type LiveReviewOutput,
	LiveRunError,
	runLiveTier,
} from "./live.js";
import type {
	ReviewStrategy,
	StrategyInput,
	ToolCallRecord,
} from "./strategy.js";
import { ledgerForRound } from "./trace.js";
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
	threads: [],
	reactions: [],
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

const out = (findings: LiveFinding[]) => ({
	findings,
	candidates: [],
	posted: [],
	usage: {},
});

const finding = (title: string, path = "src/a.ts") => ({
	title,
	path,
	line: 10,
});

type Review = (
	diff: string,
	round: Round,
	input: StrategyInput,
) => Promise<
	LiveReviewOutput & Partial<{ wallMs: number; toolCalls: ToolCallRecord[] }>
>;

function stub(
	review: Review,
	estimateCost: (diff: string, round: Round) => number = () => 1,
): ReviewStrategy {
	return {
		name: "stub",
		version: "1",
		needsCheckout: false,
		estimateCost: (i) => estimateCost(i.diff, i.round),
		run: async (i) => ({
			wallMs: 0,
			toolCalls: [],
			...(await review(i.diff, i.round, i)),
		}),
	};
}

type Over = Partial<Parameters<typeof runLiveTier>[0]> & {
	review?: Review;
	estimateCost?: (diff: string, round: Round) => number;
};

function base({ review: r, estimateCost: e, ...over }: Over = {}) {
	const lines: string[] = [];
	const calls: string[] = [];
	const review: Review =
		r ??
		(async (d) => {
			calls.push(d);
			return out([]);
		});
	const opts: Parameters<typeof runLiveTier>[0] = {
		fixture,
		labels: labels(true),
		rounds: [0, 1],
		maxCostUsd: 10,
		strategy: stub(review, e),
		fetchDiff: async (r) => ({
			diff: `diff-${r.index}`,
			files: [],
			approximate: false,
		}),
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
				return out([]);
			},
		});
		await runLiveTier(opts);
		expect(order[0]).toMatch(/^out:.*\$2\.00/);
		expect(order.indexOf("review")).toBeGreaterThan(0);
	});

	it("matches live findings only through confirmed pairs and reports the rest as newUnlabeled", async () => {
		const review = async () =>
			out([
				finding("Missing null check on user input"),
				finding("Totally different concern about caching", "src/b.ts"),
			]);
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
			review: async () => out([finding("Brand new thing", "src/z.ts")]),
			rounds: [0],
		});
		await runLiveTier(opts);
		const text = lines.join("\n");
		expect(text).toContain("1 new unlabeled");
		expect(text).not.toMatch(/\d%/);
	});

	it("counts raw and candidate retraction findings per round without dropping them", async () => {
		const { opts, lines } = base({
			rounds: [0],
			review: async () =>
				out([
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
					{
						...finding("Lost write"),
						body: "No actionable defect found.",
						severity: "P1",
					},
				]),
		});
		const report = await runLiveTier(opts);
		expect(report.rounds[0]).toMatchObject({ raw: 4, retracted: 1 });
		expect(lines.join("\n")).toContain(
			"4 raw findings, 1 candidate retractions",
		);
		expect(report.rounds[0]?.newUnlabeled).toBe(4);
	});

	it("marks a round approximate when fetchDiff says the history was rewritten", async () => {
		const { opts } = base({
			rounds: [0],
			fetchDiff: async () => ({ diff: "d", files: [], approximate: true }),
		});
		const report = await runLiveTier(opts);
		expect(report.rounds[0]?.approximate).toBe(true);
	});

	it.each([
		[Number.NaN, "NaN"],
		[Number.POSITIVE_INFINITY, "Infinity"],
		[-1, "-1"],
	])("rejects an estimate of %s before any review runs", async (value, shown) => {
		const { opts, calls } = base({
			estimateCost: (_d, r) => (r.index === 1 ? value : 1),
		});
		await expect(runLiveTier(opts)).rejects.toThrow(
			`round 1: invalid cost estimate ${shown}`,
		);
		expect(calls).toHaveLength(0);
	});

	it("still runs every round when each estimate is valid", async () => {
		const { opts, calls } = base({ estimateCost: () => 0 });
		await runLiveTier(opts);
		expect(calls).toEqual(["diff-0", "diff-1"]);
	});

	it("prints token usage per skill after the round line, in skill order", async () => {
		const usage = {
			"code-reviewer.md": { promptTokens: 2269, completionTokens: 21 },
			"silent-failure-hunter.md": { promptTokens: 3380, completionTokens: 340 },
		};
		const { opts, lines } = base({
			rounds: [1],
			review: async () => ({
				findings: [],
				candidates: [],
				posted: [],
				usage,
			}),
		});
		await runLiveTier(opts);
		const at = lines.findIndex((l) => l.startsWith("round 1"));
		expect(lines[at + 1]).toBe(
			"  usage: code-reviewer.md 2269+21, silent-failure-hunter.md 3380+340",
		);
	});

	it("prints no usage line when a round has no usage", async () => {
		const { opts, lines } = base({ rounds: [1] });
		await runLiveTier(opts);
		expect(lines.some((l) => l.trimStart().startsWith("usage:"))).toBe(false);
	});

	it("reports candidates, joined-to-labelled count and usage per round", async () => {
		const usage = { "code-reviewer": { promptTokens: 5, completionTokens: 2 } };
		const cand = (title: string, path: string) => ({
			skill: "code-reviewer",
			title,
			path,
			line: 10,
			severity: "P1",
		});
		const { opts, lines } = base({
			rounds: [1],
			review: async () => ({
				findings: [],
				candidates: [
					cand("Missing null check on user input", "src/a.ts"),
					cand("Totally different concern about caching", "src/b.ts"),
				],
				posted: [],
				usage,
			}),
		});
		const report = await runLiveTier(opts);
		expect(report.rounds[0]).toMatchObject({ candidates: 2, joined: 1, usage });
		expect(lines.join("\n")).toContain(
			"2 candidates, 1 joined to labelled claims",
		);
	});

	it("passes the round to the review and reports how many findings would post", async () => {
		const seen: number[] = [];
		const posted = {
			skill: "code-reviewer.md",
			title: "Missing null check on user input",
			path: "src/a.ts",
			line: 10,
			severity: "P1",
		};
		const { opts, lines } = base({
			rounds: [1],
			review: async (_d, r) => {
				seen.push(r.index);
				return { ...out([]), posted: [posted, { ...posted, line: 11 }] };
			},
		});
		const report = await runLiveTier(opts);
		expect(seen).toEqual([1]);
		expect(report.rounds[0]?.posted).toBe(2);
		expect(lines.join("\n")).toContain("2 would post");
	});

	it("hands the strategy no checkout, the round's ledger, the remaining cap and a live signal", async () => {
		const inputs: StrategyInput[] = [];
		const { opts } = base({
			rounds: [0, 1],
			maxCostUsd: 10,
			review: async (_d, _r, input) => {
				inputs.push(input);
				return out([]);
			},
		});
		await runLiveTier(opts);
		expect(inputs).toHaveLength(2);
		expect(inputs[0]).toMatchObject({
			checkout: null,
			diff: "diff-0",
			files: [],
			approximateDiff: false,
			budget: { maxUsd: 10, maxWallMs: 210_000 },
		});
		expect(inputs[0]?.history.ledger).toEqual(
			ledgerForRound(fixture, labels(true), fixture.rounds[0] as Round),
		);
		expect(inputs[0]).not.toHaveProperty("labels");
		expect(inputs[1]?.budget).toEqual({ maxUsd: 9, maxWallMs: 210_000 });
		expect(inputs[0]?.signal).not.toBe(inputs[1]?.signal);
		expect(inputs[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(inputs[0]?.signal.aborted).toBe(false);
	});

	it("throws a LiveRunError naming strategy and round, with the cause and the failing round's estimated spend and the finished rows", async () => {
		const boom = new Error("model exploded");
		const { opts } = base({
			review: async (_d, r) => {
				if (r.index === 1) throw boom;
				return out([]);
			},
		});
		const err = await runLiveTier(opts).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LiveRunError);
		const failure = err as LiveRunError;
		expect(failure.message).toBe("stub round 1: model exploded");
		expect(failure.cause).toBe(boom);
		expect(failure.partial.spentUsd).toBe(2);
		expect(failure.partial.rounds.map((r) => r.index)).toEqual([0]);
	});

	it("carries wallMs and toolCalls into the round row", async () => {
		const { opts } = base({
			rounds: [0],
			review: async () => ({
				...out([]),
				wallMs: 1234,
				toolCalls: [{ name: "grep", wallMs: 5, costUsd: 0 }],
			}),
		});
		const report = await runLiveTier(opts);
		expect(report.rounds[0]).toMatchObject({ wallMs: 1234, toolCalls: 1 });
	});

	it("prints wall time and tool-call count after the round line", async () => {
		const { opts, lines } = base({
			rounds: [0],
			review: async () => ({
				...out([]),
				wallMs: 1234,
				toolCalls: [{ name: "grep", wallMs: 5, costUsd: 0 }],
			}),
		});
		await runLiveTier(opts);
		expect(lines).toContain("  wall 1234ms, 1 tool calls");
	});

	describe("checkouts", () => {
		const handle = { path: "/tmp/x", baseSha: "b", headSha: "h" };
		const toolStrategy = (seen: (StrategyInput["checkout"] | "run")[]) =>
			({
				...stub(async (_d, _r, input) => {
					seen.push(input.checkout);
					return out([]);
				}),
				needsCheckout: true,
			}) satisfies ReviewStrategy;

		it("hands a needsCheckout strategy a checkout and asks for the round's shas", async () => {
			const seen: StrategyInput["checkout"][] = [];
			const asked: { baseSha: string; headSha: string }[] = [];
			const { opts } = base({
				rounds: [1],
				strategy: toolStrategy(seen),
				withCheckout: async (o, fn) => {
					asked.push({ baseSha: o.baseSha, headSha: o.headSha });
					return fn(handle);
				},
			});
			await runLiveTier(opts);
			expect(seen).toEqual([handle]);
			expect(asked).toEqual([{ baseSha: "b", headSha: "h1" }]);
		});

		it("gives a diff-only strategy null and never touches git", async () => {
			let attempts = 0;
			const seen: StrategyInput["checkout"][] = [];
			const { opts } = base({
				review: async (_d, _r, input) => {
					seen.push(input.checkout);
					return out([]);
				},
				withCheckout: async (_o, fn) => {
					attempts++;
					return fn(handle);
				},
			});
			await runLiveTier(opts);
			expect(attempts).toBe(0);
			expect(seen).toEqual([null, null]);
		});

		it("skips an unavailable round, records it and reports the count per strategy", async () => {
			const seen: StrategyInput["checkout"][] = [];
			const { opts, lines } = base({
				strategy: toolStrategy(seen),
				withCheckout: async (o, fn) =>
					o.headSha === "h0"
						? { unavailable: true as const, reason: "gone" }
						: fn(handle),
			});
			const report = await runLiveTier(opts);
			expect(report.checkoutUnavailable).toEqual([0]);
			expect(report.rounds.map((r) => r.index)).toEqual([1]);
			expect(seen).toEqual([handle]);
			expect(lines.join("\n")).toMatch(
				/stub: 1 of 2 round\(s\) could not run \(checkout unavailable\)/,
			);
		});
	});
});
