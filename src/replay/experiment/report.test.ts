import { describe, expect, it } from "vitest";
import { formatScoreReport } from "./report.js";
import type { ExperimentScore } from "./score.js";

const base = (over: Partial<ExperimentScore> = {}): ExperimentScore => ({
	final: false,
	directional: false,
	exploratory: null,
	partial: false,
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
			fitShare: 0.95,
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
			},
		},
	],
	verdicts: [],
	...over,
});

const text = (s: ExperimentScore) => formatScoreReport(s, { planHash: "abc" });

describe("formatScoreReport", () => {
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
