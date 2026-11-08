import { describe, expect, it } from "vitest";
import { formatScoreReport } from "./report.js";
import type { ExperimentScore } from "./score.js";

const base = (over: Partial<ExperimentScore> = {}): ExperimentScore => ({
	final: false,
	directional: false,
	exploratory: null,
	partial: false,
	overCapCells: 0,
	staleExcluded: 0,
	baseline: "a",
	perPr: [],
	summaries: [
		{
			strategy: "a",
			provider: "anthropic",
			nPrs: 12,
			precision: 0.5,
			recall: 0.6,
			real: 10,
			notReal: 10,
			unresolved: 3,
			unadjudicated: 4,
			singleFamily: 2,
			moved: 1,
			provisional: 0,
			medianCostUsd: 1.5,
			medianWallMs: 42_000,
			fitShare: 0.95,
			joinRate: { joined: 3, candidates: 7, matcher: "isSameClaim@X" },
		},
	],
	comparisons: [
		{
			candidate: "b",
			provider: "anthropic",
			comparison: {
				precision: { mean: 0.2, lo: 0.1, hi: 0.3, n: 11 },
				recallDiffPoints: -1.5,
				medianCostCandidate: 1,
				medianCostBaseline: 1.5,
				fitShare: 0.95,
				nPrs: 11,
				excludedIncomplete: 2,
				excludedNullPrecision: 1,
				intersectionCells: 22,
				emptyIntersectionPrs: ["o/r#9"],
			},
		},
	],
	verdicts: [],
	...over,
});

const text = (s: ExperimentScore) =>
	formatScoreReport(s, { planHash: "abc", hostedFitSeconds: 180 });

describe("formatScoreReport", () => {
	it("prints the join rate with the matcher", () => {
		expect(text(base())).toMatch(/join rate 3\/7 \(matcher isSameClaim@X\)/);
	});

	it("always says per-round only and prints unresolved counts next to the figures", () => {
		const out = text(base());
		expect(out).toMatch(/per-round mode only/i);
		expect(out).toMatch(/chained/i);
		expect(out).toMatch(/unresolved 3/);
		expect(out).toMatch(/unadjudicated 4/);
		expect(out).toMatch(/single-family 2/);
	});

	it("shows the paired interval and the intersection size", () => {
		const out = text(base());
		expect(out).toMatch(/b vs a/);
		expect(out).toMatch(/n=11/);
		expect(out).toMatch(
			/excluded 2 PR\(s\) for incomplete coverage, 1 for no judged/,
		);
		expect(out).toMatch(/\[0\.100, 0\.300\]/);
	});

	it("renders the plan's hosted seconds, median latency, intersection and empty-intersection PRs", () => {
		const out = text(base());
		expect(out).toMatch(/inside 180s/);
		expect(out).not.toMatch(/inside 210s/);
		expect(out).toMatch(/median latency 42\.0s/);
		expect(out).toMatch(/22 shared cell/);
		expect(out).toMatch(/no shared cell: o\/r#9/);
	});

	it("says no verdict outside --final", () => {
		expect(text(base())).toMatch(/no verdict outside --final/);
	});

	it("labels directional, partial, stale and exploratory", () => {
		const out = text(
			base({
				directional: true,
				partial: true,
				staleExcluded: 2,
				exploratory: "exploratory: 3 test PR(s) were already scored",
			}),
		);
		expect(out).toMatch(/DIRECTIONAL/);
		expect(out).toMatch(/PARTIAL/);
		expect(out).toMatch(/2 stale/);
		expect(out).toMatch(/exploratory/);
	});

	it("prints a final verdict, but none when directional", () => {
		const verdicts = [
			{
				candidate: "b",
				verdict: {
					label: "Anthropic-only, unconfirmed on OpenAI",
					go: null,
					hosted: true,
					reasons: [],
				},
			},
		];
		const final = text(base({ final: true, verdicts }));
		expect(final).toMatch(/b: Anthropic-only, unconfirmed on OpenAI/);
		const directional = text(
			base({ final: true, directional: true, verdicts }),
		);
		expect(directional).not.toMatch(/unconfirmed on OpenAI/);
		expect(directional).toMatch(/no go or no-go claim/);
	});
});

describe("formatScoreReport chained", () => {
	it("chained report omits precision and cost", () => {
		const out = text(
			base({
				chained: {
					perPr: [],
					summaries: [
						{
							strategy: "a",
							provider: "anthropic",
							nPrs: 4,
							recycling: 0.25,
							convergenceRound: 2,
							recall: 0.5,
							incompleteRate: 0.25,
						},
					],
					comparisons: [
						{
							candidate: "b",
							provider: "anthropic",
							nPrs: 3,
							excludedIncomplete: 1,
							recycling: { mean: -0.1, lo: -0.2, hi: 0, n: 3 },
							convergence: { mean: -1, lo: -2, hi: 0, n: 3 },
						},
					],
				},
			}),
		);
		expect(out).toContain("chained: recycling and convergence only");
		expect(out).toContain("recycling is an upper bound");
		expect(out).not.toMatch(/precision|cost|latency/i);
	});
});
