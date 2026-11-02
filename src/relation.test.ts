import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "./ledger/types.js";
import {
	causedByLine,
	declaredRepeat,
	parseRelation,
	resolveRelations,
	shortFindingId,
	uniqueShortIds,
} from "./relation.js";
import { findingId } from "./review-state.js";

const entry: LedgerEntry = {
	id: "r0:c4242:0",
	round: 0,
	path: "src/a.ts",
	line: 10,
	severity: "P1",
	title: "retry loop has no exponential backoff delay",
	status: "open",
	decidedBy: null,
	reason: null,
	evidence: [],
};
const shortId = shortFindingId(
	findingId("src/a.ts", 10, "retry loop has no exponential backoff delay"),
);
type Related = {
	relation: { kind: string; entry_id: string };
	causedBy?: string;
};
const pr = { owner: "o", repo: "r", pullNumber: 7 };

describe("parseRelation", () => {
	it("keeps a shown id and drops an unknown one", () => {
		const shown = new Set([shortId]);
		expect(
			parseRelation({ kind: "repeats", entry_id: shortId }, shown),
		).toEqual({ kind: "repeats", entry_id: shortId });
		expect(
			parseRelation({ kind: "repeats", entry_id: `#${shortId}` }, shown),
		).toEqual({ kind: "repeats", entry_id: shortId });
		expect(
			parseRelation({ kind: "repeats", entry_id: "ffffff" }, shown),
		).toBeUndefined();
		expect(parseRelation(null, shown)).toBeUndefined();
	});
});

describe("resolveRelations", () => {
	it("nulls an unknown id and links a caused_by finding to the earlier comment", () => {
		const [bad, good] = resolveRelations<Related>(
			[
				{ relation: { kind: "repeats", entry_id: "ffffff" } },
				{ relation: { kind: "caused_by", entry_id: shortId } },
			],
			new Set([shortId]),
			[entry],
			pr,
		);
		expect(bad?.relation).toBeNull();
		expect(good?.causedBy).toBe(
			"Caused by an earlier finding: https://github.com/o/r/pull/7#discussion_r4242",
		);
	});

	it("falls back to the quoted title for an entry with no comment", () => {
		expect(causedByLine({ ...entry, id: "r0:body:0" }, pr)).toBe(
			'Caused by an earlier finding: "retry loop has no exponential backoff delay"',
		);
	});
});

describe("declaredRepeat", () => {
	const declared = (kind: string, extra = {}) => ({
		path: "src/a.ts",
		line: 12,
		title: "retry loop has no exponential backoff delay",
		severity: "P1",
		relation: { kind, entry_id: shortId },
		...extra,
	});

	it("resolves a same-claim, same-path repeat that is not more severe", () => {
		const find = declaredRepeat([entry]);
		expect(find(declared("repeats"))).toBe(entry);
		expect(find(declared("repeats", { severity: "P3" }))).toBe(entry);
		expect(find(declared("caused_by"))).toBeUndefined();
	});

	it("ignores a repeat on another path", () => {
		expect(
			declaredRepeat([entry])(declared("repeats", { path: "src/b.ts" })),
		).toBeUndefined();
	});

	it("ignores a repeat of a different claim", () => {
		expect(
			declaredRepeat([entry])(
				declared("repeats", { title: "SQL injection in the search handler" }),
			),
		).toBeUndefined();
	});

	it("ignores a repeat more severe than the entry", () => {
		expect(
			declaredRepeat([entry])(declared("repeats", { severity: "P0" })),
		).toBeUndefined();
		expect(
			declaredRepeat([{ ...entry, severity: "P3" }])(declared("repeats")),
		).toBeUndefined();
	});
});

describe("declaredRepeat at P0", () => {
	const p0 = {
		...entry,
		severity: "P0" as const,
		title: "Unvalidated token in verify()",
	};
	const declared = (title: string, line = 12) => ({
		path: "src/a.ts",
		line,
		title,
		severity: "P0",
		relation: {
			kind: "repeats",
			entry_id: shortFindingId(
				findingId("src/a.ts", 10, "Unvalidated token in verify()"),
			),
		},
	});

	it("refuses a related-but-different P0 two lines away", () => {
		expect(
			declaredRepeat([p0])(declared("Token bypass in verify()", 12)),
		).toBeUndefined();
	});

	it("refuses a related P0 far from the entry", () => {
		expect(
			declaredRepeat([p0])(
				declared("Unvalidated token in verify() allows forgery", 200),
			),
		).toBeUndefined();
	});

	it("still accepts a true P0 restatement", () => {
		expect(
			declaredRepeat([p0])(declared("Unvalidated token in verify()")),
		).toBe(p0);
	});

	describe("without a path", () => {
		const title = "Unvalidated session token allows account takeover";
		const general = { ...p0, path: null, line: null, title };
		const repeat = (t: string) => ({
			path: null,
			line: null,
			title: t,
			severity: "P0",
			relation: {
				kind: "repeats",
				entry_id: shortFindingId(findingId(null, null, title)),
			},
		});

		it("refuses a related P0 below the 0.8 bar", () => {
			expect(
				declaredRepeat([general])(
					repeat("Unvalidated session token allows account hijack"),
				),
			).toBeUndefined();
		});

		it("accepts the same P0 claim", () => {
			expect(declaredRepeat([general])(repeat(title))).toBe(general);
		});
	});
});

describe("uniqueShortIds", () => {
	it("drops the id from both items of a collision and keeps the rest", () => {
		const out = uniqueShortIds([
			{ shortId: "aaaaaa" },
			{ shortId: "bbbbbb" },
			{ shortId: "aaaaaa" },
		]);
		expect(out.map((f) => f.shortId)).toEqual([undefined, "bbbbbb", undefined]);
	});
});
