import { beforeEach, describe, expect, it } from "vitest";
import {
	computeSeverityReliability,
	computeSkillSignals,
	detectDuplicateClusters,
	extractIdentifiers,
	type FindingOutcome,
	titleSimilarity,
} from "./trends.js";

// Reset per test rather than shared module state: a leaked counter makes ids
// depend on execution order, so a failure in one suite renames rows in another.
let nextId = 1;
beforeEach(() => {
	nextId = 1;
});

function outcome(over: Partial<FindingOutcome> = {}): FindingOutcome {
	return {
		findingId: nextId++,
		pr: 55,
		path: "src/x.ts",
		title: "a finding",
		severity: "low",
		skills: [],
		backfilled: false,
		intent: "downvote",
		...over,
	};
}

describe("extractIdentifiers", () => {
	it("pulls camelCase symbols out of prose", () => {
		expect(
			extractIdentifiers("appendMidSynthesis discards its file"),
		).toContain("appendMidSynthesis");
	});

	it("pulls symbols out of backticked spans", () => {
		expect(
			extractIdentifiers("`closeSync(dir)` called unconditionally"),
		).toContain("closeSync");
	});

	it("ignores ordinary lowercase words", () => {
		expect(extractIdentifiers("the write path is not guarded")).toEqual([]);
	});

	it("ignores capitalised sentence openers", () => {
		expect(extractIdentifiers("Critical: missing finally block")).toEqual([]);
	});
});

describe("titleSimilarity", () => {
	it("scores restatements of one claim highly", () => {
		expect(
			titleSimilarity(
				"claim not released when buildReview throws",
				"Missing finally block — claim not released on buildReview throw",
			),
		).toBeGreaterThan(0.3);
	});

	it("scores unrelated claims about the same symbol low", () => {
		expect(
			titleSimilarity(
				"atomicWrite on Windows: renameSync over an existing file throws EPERM",
				"takePreWriteSnapshot result is unused if atomicWrite throws",
			),
		).toBeLessThan(0.3);
	});
});

describe("detectDuplicateClusters", () => {
	// Verbatim from cc-recall#55 and ai-review-bot#18.
	const buildReviewTitles = [
		"Critical: Missing `finally` — claim is never released on `buildReview`",
		"Critical: claim not released when buildReview throws",
		"Critical: Missing finally block — claim not released on buildReview throw",
		"Critical: Missing finally block — claim leaked on buildReview throw",
	];

	it("groups repeated restatements of one claim", () => {
		const clusters = detectDuplicateClusters(
			buildReviewTitles.map((title) => outcome({ title, pr: 18 })),
		);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].identifier).toBe("buildReview");
		expect(clusters[0].findingIds).toHaveLength(4);
	});

	it("does not group distinct findings that merely name the same symbol", () => {
		const clusters = detectDuplicateClusters([
			outcome({
				title:
					"atomicWrite on Windows: renameSync over an existing file throws EPERM",
			}),
			outcome({
				title:
					"didRevertTranscript: atomicWrite with empty string rather than unlink",
			}),
			outcome({
				title: "takePreWriteSnapshot result is unused if atomicWrite throws",
			}),
		]);
		expect(clusters).toEqual([]);
	});

	it("ignores findings the maintainer agreed with", () => {
		const clusters = detectDuplicateClusters(
			buildReviewTitles.map((title) =>
				outcome({ title, pr: 18, intent: "upvote" }),
			),
		);
		expect(clusters).toEqual([]);
	});

	it("does not group across different files", () => {
		const clusters = detectDuplicateClusters(
			buildReviewTitles.map((title, i) =>
				outcome({ title, pr: 18, path: `src/f${i}.ts` }),
			),
		);
		expect(clusters).toEqual([]);
	});

	it("respects the minimum cluster size", () => {
		expect(
			detectDuplicateClusters(
				buildReviewTitles.slice(0, 2).map((title) => outcome({ title })),
			),
		).toEqual([]);
	});

	// Raising one real bug from several angles is thorough; restating a rejected
	// claim is the noise this detects. A cluster must not be formed out of
	// findings the maintainer agreed with, even when negatives sit beside them.
	it("clusters only the negative members of a mixed-intent group", () => {
		const clusters = detectDuplicateClusters([
			...buildReviewTitles.map((title) =>
				outcome({ title, pr: 18, intent: "downvote" }),
			),
			...buildReviewTitles.map((title) =>
				outcome({ title, pr: 18, intent: "upvote" }),
			),
		]);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].findingIds).toHaveLength(4);
	});

	it("does not cluster when negatives fall below the minimum after filtering", () => {
		const clusters = detectDuplicateClusters([
			...buildReviewTitles
				.slice(0, 2)
				.map((title) => outcome({ title, pr: 18, intent: "bug_report" })),
			...buildReviewTitles
				.slice(2)
				.map((title) => outcome({ title, pr: 18, intent: "upvote" })),
		]);
		expect(clusters).toEqual([]);
	});

	it("places each finding in only one cluster", () => {
		const clusters = detectDuplicateClusters(
			buildReviewTitles.map((title) => outcome({ title, pr: 18 })),
		);
		const all = clusters.flatMap((c) => c.findingIds);
		expect(new Set(all).size).toBe(all.length);
	});
});

describe("computeSeverityReliability", () => {
	it("ranks the least reliable severity first", () => {
		const result = computeSeverityReliability([
			outcome({ severity: "high", intent: "bug_report" }),
			outcome({ severity: "high", intent: "downvote" }),
			outcome({ severity: "medium", intent: "upvote" }),
			outcome({ severity: "medium", intent: "upvote" }),
		]);
		expect(result[0].severity).toBe("high");
		expect(result[0].usefulRatio).toBe(0);
		expect(result[1].usefulRatio).toBe(1);
	});

	it("separates wrong from merely low-value", () => {
		const [row] = computeSeverityReliability([
			outcome({ severity: "high", intent: "bug_report" }),
			outcome({ severity: "high", intent: "downvote" }),
		]);
		expect(row).toMatchObject({ wrong: 1, lowValue: 1, useful: 0 });
	});

	it("buckets an unlabelled severity rather than dropping it", () => {
		expect(
			computeSeverityReliability([outcome({ severity: null })])[0].severity,
		).toBe("none");
	});

	it("excludes noise from the denominator", () => {
		expect(
			computeSeverityReliability([
				outcome({ severity: "low", intent: "upvote" }),
				outcome({ severity: "low", intent: "noise" }),
			])[0].sampleSize,
		).toBe(1);
	});
});

describe("computeSkillSignals", () => {
	it("excludes backfilled findings, which never recorded a skill", () => {
		expect(
			computeSkillSignals(
				[
					...Array.from({ length: 9 }, () =>
						outcome({ backfilled: true, skills: [] }),
					),
				],
				1,
			),
		).toEqual([]);
	});

	it("ranks the worst-performing skill first", () => {
		const rows = [
			...Array.from({ length: 3 }, () =>
				outcome({ skills: ["bad.md"], intent: "downvote" }),
			),
			...Array.from({ length: 3 }, () =>
				outcome({ skills: ["good.md"], intent: "upvote" }),
			),
		];
		const result = computeSkillSignals(rows, 3);
		expect(result[0].skill).toBe("bad.md");
		expect(result[0].negativeRatio).toBe(1);
	});

	it("suppresses a skill below the minimum sample", () => {
		expect(computeSkillSignals([outcome({ skills: ["rare.md"] })], 8)).toEqual(
			[],
		);
	});

	// `negative` is deliberately intent-agnostic across downvote and bug_report:
	// a skill that is wrong and a skill that is unhelpful both fail the reader,
	// and separating them is the severity/FP analysis, not this ratio.
	it("counts bug_report and downvote alike as negative", () => {
		const result = computeSkillSignals(
			[
				outcome({ skills: ["s.md"], intent: "bug_report" }),
				outcome({ skills: ["s.md"], intent: "downvote" }),
			],
			1,
		);
		expect(result[0]).toMatchObject({ negative: 2, useful: 0, sampleSize: 2 });
	});

	it("excludes noise from both numerator and denominator", () => {
		const result = computeSkillSignals(
			[
				outcome({ skills: ["s.md"], intent: "upvote" }),
				outcome({ skills: ["s.md"], intent: "noise" }),
			],
			1,
		);
		expect(result[0]).toMatchObject({ useful: 1, negative: 0, sampleSize: 1 });
	});

	it("counts a finding once per skill that raised it", () => {
		const result = computeSkillSignals(
			[outcome({ skills: ["a.md", "b.md"], intent: "upvote" })],
			1,
		);
		expect(result.map((r) => r.skill).sort()).toEqual(["a.md", "b.md"]);
	});
});
