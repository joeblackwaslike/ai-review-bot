import { describe, expect, it } from "vitest";
import { buildAnnotations } from "./check-run.js";
import type { ReviewDecision } from "./review.js";

function buildReview(overrides?: Partial<ReviewDecision>): ReviewDecision {
	return {
		event: "COMMENT",
		body: "Review body.",
		comments: [],
		metadata: {
			model: "claude-sonnet-4-6",
			tier1Count: 5,
			tier2Skills: [],
			generalFindings: 0,
			inlineComments: 0,
			cost: 0.001,
		},
		validLinesByPath: new Map(),
		...overrides,
	};
}

describe("buildAnnotations", () => {
	it("maps review comments to annotations", () => {
		const review = buildReview({
			event: "REQUEST_CHANGES",
			comments: [
				{
					path: "src/file.ts",
					line: 10,
					side: "RIGHT",
					body: "**Missing null check**\n\nThis could throw.",
				},
			],
		});

		const annotations = buildAnnotations(review);

		expect(annotations).toHaveLength(1);
		expect(annotations[0]).toMatchObject({
			path: "src/file.ts",
			start_line: 10,
			end_line: 10,
			annotation_level: "warning",
			title: "Missing null check",
		});
	});

	it("uses notice level for COMMENT reviews", () => {
		const review = buildReview({
			event: "COMMENT",
			comments: [
				{
					path: "src/file.ts",
					line: 5,
					side: "RIGHT",
					body: "**Consider refactoring**\n\nThis is complex.",
				},
			],
		});

		const annotations = buildAnnotations(review);
		expect(annotations[0].annotation_level).toBe("notice");
	});

	it("returns empty array when no comments", () => {
		const review = buildReview({ comments: [] });
		expect(buildAnnotations(review)).toEqual([]);
	});

	it("uses start_line for multi-line comments", () => {
		const review = buildReview({
			comments: [
				{
					path: "src/file.ts",
					line: 15,
					start_line: 10,
					start_side: "RIGHT",
					side: "RIGHT",
					body: "**Range issue**\n\nSpans multiple lines.",
				},
			],
		});

		const annotations = buildAnnotations(review);
		expect(annotations[0].start_line).toBe(10);
		expect(annotations[0].end_line).toBe(15);
	});
});
