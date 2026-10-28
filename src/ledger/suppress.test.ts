import { describe, expect, it } from "vitest";
import { suppressInReview, suppressSettled } from "./suppress.js";
import type { LedgerEntry } from "./types.js";

const settled: LedgerEntry = {
	id: "e1",
	round: 1,
	path: "src/a.ts",
	line: 10,
	severity: "P1",
	title: "`listFindings` drops the body column in the SQL query",
	status: "rejected",
	decidedBy: "author",
	reason: "intentional",
	evidence: [],
};
const repeat = {
	path: "src/a.ts",
	line: 12,
	title: "`listFindings` drops the body column in the SQL query",
};
const fresh = {
	path: "src/z.ts",
	line: 1,
	title: "Unrelated race condition in cache invalidation",
};

describe("suppressSettled", () => {
	it("preserves order and pairs suppressed findings with their entry", () => {
		const other = { ...fresh, line: 2 };
		const { kept, suppressed } = suppressSettled(
			[fresh, repeat, other],
			[settled],
		);
		expect(kept).toEqual([fresh, other]);
		expect(suppressed).toEqual([{ finding: repeat, entry: settled }]);
	});
});

describe("suppressInReview", () => {
	it("downgrades REQUEST_CHANGES to COMMENT when everything is suppressed", () => {
		const review = {
			event: "REQUEST_CHANGES",
			general_findings: [],
			inline_comments: [repeat],
		};
		const out = suppressInReview(review, [settled]);
		expect(out.review.event).toBe("COMMENT");
		expect(out.review.inline_comments).toEqual([]);
		expect(out.suppressed).toHaveLength(1);
		expect(review.event).toBe("REQUEST_CHANGES");
	});

	it("keeps REQUEST_CHANGES when one finding survives", () => {
		const out = suppressInReview(
			{
				event: "REQUEST_CHANGES",
				general_findings: [fresh],
				inline_comments: [repeat],
			},
			[settled],
		);
		expect(out.review.event).toBe("REQUEST_CHANGES");
		expect(out.review.general_findings).toEqual([fresh]);
	});
});
