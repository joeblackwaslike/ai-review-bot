import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "./ledger/types.js";
import {
	causedByLine,
	declaredRepeat,
	parseRelation,
	resolveRelations,
	shortFindingId,
} from "./relation.js";
import { findingId } from "./review-state.js";

const entry: LedgerEntry = {
	id: "r0:c4242:0",
	round: 0,
	path: "src/a.ts",
	line: 10,
	severity: "P1",
	title: "retry has no backoff",
	status: "open",
	decidedBy: null,
	reason: null,
	evidence: [],
};
const shortId = shortFindingId(
	findingId("src/a.ts", 10, "retry has no backoff"),
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
			'Caused by an earlier finding: "retry has no backoff"',
		);
	});
});

describe("declaredRepeat", () => {
	it("resolves only repeats relations", () => {
		const find = declaredRepeat([entry]);
		expect(find({ relation: { kind: "repeats", entry_id: shortId } })).toBe(
			entry,
		);
		expect(
			find({ relation: { kind: "caused_by", entry_id: shortId } }),
		).toBeUndefined();
	});
});
