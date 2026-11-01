import { describe, expect, it } from "vitest";
import {
	blocksVerdict,
	suppressInReview,
	suppressOpenRestatements,
	suppressSettled,
} from "./suppress.js";
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

const open: LedgerEntry = {
	...settled,
	id: "r0:c11:0",
	status: "open",
	decidedBy: null,
	reason: null,
};
const generalOpen: LedgerEntry = {
	...open,
	id: "r0:body:0",
	path: null,
	line: null,
	severity: "P3",
	title: "README example still uses the removed flag name",
};
const generalRepeat = {
	path: null,
	line: null,
	severity: "P3",
	title: "README example still uses the removed flag name",
};

describe("suppressOpenRestatements", () => {
	it("drops a restatement of an open entry and never matches a settled one", () => {
		const out = suppressOpenRestatements([repeat, fresh], [settled, open]);
		expect(out.kept).toEqual([fresh]);
		expect(out.suppressed).toEqual([{ finding: repeat, entry: open }]);
		expect(suppressOpenRestatements([repeat], [settled]).kept).toEqual([
			repeat,
		]);
	});

	it("matches an inline restatement of a routed off-diff finding by its location suffix", () => {
		const routed: LedgerEntry = {
			...open,
			id: "r0:body:1",
			path: null,
			line: null,
			title: "Retry loop never backs off on 429 (`src/a.ts:40`)",
		};
		const restated = {
			path: "src/a.ts",
			line: 40,
			severity: "P1",
			title: "Retry loop never backs off on 429",
		};
		const out = suppressOpenRestatements([restated], [routed]);
		expect(out.kept).toEqual([]);
		expect(out.suppressed[0]?.entry.id).toBe("r0:body:1");
	});
});

describe("suppressOpenRestatements and the verdict", () => {
	const title = "Retry loop never backs off on rate limited responses";
	const pathless = (severity: string): LedgerEntry => ({
		id: "g1",
		round: 1,
		path: null,
		line: null,
		severity,
		title,
		status: "open",
		decidedBy: null,
		reason: null,
		evidence: [],
	});
	const inlineRestatement = {
		path: "src/a.ts",
		line: 5,
		severity: "P2",
		title,
	};

	it("keeps an inline restatement of a pathless P2 entry, since the entry would not block", () => {
		const out = suppressOpenRestatements([inlineRestatement], [pathless("P2")]);
		expect(out.kept).toEqual([inlineRestatement]);
		expect(out.suppressed).toEqual([]);
	});

	it("still suppresses it when the pathless entry is P1 and blocks", () => {
		const out = suppressOpenRestatements([inlineRestatement], [pathless("P1")]);
		expect(out.kept).toEqual([]);
	});

	it("still suppresses a pathed restatement of a pathed entry", () => {
		const entry = { ...pathless("P2"), path: "src/a.ts", line: 5 };
		const out = suppressOpenRestatements([inlineRestatement], [entry]);
		expect(out.kept).toEqual([]);
	});

	it("does not downgrade the event when the inline restatement is kept", () => {
		const out = suppressInReview(
			{
				event: "REQUEST_CHANGES",
				general_findings: [],
				inline_comments: [inlineRestatement],
			},
			[pathless("P2")],
		);
		expect(out.review.event).toBe("REQUEST_CHANGES");
		expect(out.review.inline_comments).toHaveLength(1);
	});
});

describe("suppressInReview with open entries", () => {
	it("drops an open restatement and reports it as restatedOpen", () => {
		const out = suppressInReview(
			{ event: "COMMENT", general_findings: [], inline_comments: [repeat] },
			[open],
		);
		expect(out.review.inline_comments).toEqual([]);
		expect(out.suppressed).toEqual([]);
		expect(out.restatedOpen).toEqual([{ finding: repeat, entry: open }]);
	});

	it("keeps REQUEST_CHANGES when the only finding restated a blocking open entry", () => {
		const out = suppressInReview(
			{
				event: "REQUEST_CHANGES",
				general_findings: [],
				inline_comments: [repeat],
			},
			[open],
		);
		expect(out.review.inline_comments).toEqual([]);
		expect(out.review.event).toBe("REQUEST_CHANGES");
	});

	it("still downgrades when the open restatement is a general P3 and the rest were settled", () => {
		const out = suppressInReview(
			{
				event: "REQUEST_CHANGES",
				general_findings: [generalRepeat],
				inline_comments: [repeat],
			},
			[settled, generalOpen],
		);
		expect(out.review.general_findings).toEqual([]);
		expect(out.review.event).toBe("COMMENT");
		expect(out.restatedOpen).toEqual([
			{ finding: generalRepeat, entry: generalOpen },
		]);
	});

	it("holds when a P0 finding restates a general P3 entry", () => {
		const out = suppressInReview(
			{
				event: "REQUEST_CHANGES",
				general_findings: [{ ...generalRepeat, severity: "P0" }],
				inline_comments: [],
			},
			[generalOpen],
		);
		expect(out.review.general_findings).toEqual([]);
		expect(out.review.event).toBe("REQUEST_CHANGES");
	});
});

describe("blocksVerdict advisory", () => {
	it("never blocks an advisory finding, even with a path", () => {
		expect(
			blocksVerdict({ path: "a.ts", severity: "P2", advisory: true }),
		).toBe(false);
		expect(blocksVerdict({ path: "a.ts", severity: "P2" })).toBe(true);
	});
});
