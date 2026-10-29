import { describe, expect, it } from "vitest";
import { deriveBaseline } from "./baseline.js";
import type { Ledger, LedgerEntry } from "./ledger/types.js";
import { findingId } from "./review-state.js";

const SHA = "abc1234567890abc1234567890abc1234567890a";

function entry(
	o: Partial<LedgerEntry> & { id: string; round: number },
): LedgerEntry {
	return {
		path: null,
		line: null,
		severity: "P1",
		title: "t",
		status: "open",
		decidedBy: null,
		reason: null,
		evidence: [],
		...o,
	};
}

function body(parts: {
	rows?: string[];
	carried?: string[];
	bullets?: string[];
	inline?: string;
	count?: number;
}): string {
	const lines = [
		"### Review",
		"",
		"| Sev | Finding |",
		"|---|---|",
		...(parts.rows ?? []),
		"",
	];
	if (parts.carried?.length) {
		lines.push(
			"#### Still open from the previous review",
			"",
			"These were flagged in a previous review; the agents were instructed not to restate them, so they are carried forward as still open.",
			"",
			"| Sev | Finding |",
			"|---|---|",
			...parts.carried,
			"",
		);
	}
	if (parts.bullets?.length) {
		lines.push(
			`> ⚠️ ${parts.bullets.length} inline comment could not be anchored to the diff and was posted here instead:`,
			...parts.bullets,
			"",
		);
	}
	lines.push(
		parts.inline ?? "Inline comments: none",
		`<!-- ai-review:sha=${SHA} -->`,
		`<!-- ai-review:review=${parts.count ?? 2} -->`,
	);
	return lines.join("\n");
}

const warm = (entries: Ledger, reviewIds = [10, 20]) => ({
	entries,
	reviewIds,
	warm: true,
});

describe("deriveBaseline", () => {
	it("returns null with no source or no sha marker", () => {
		expect(deriveBaseline(null, warm([]))).toBeNull();
		expect(deriveBaseline({ id: 20, body: "hello" }, warm([]))).toBeNull();
	});

	it("carried row with a path suffix gets path, line and a clean title", () => {
		const b = body({
			carried: ["| 🟠 | **Unchecked cast** (`src/a.ts:42`) |"],
		});
		const r = deriveBaseline({ id: 20, body: b }, warm([]));
		expect(r?.state.lastReviewedSha).toBe(SHA);
		expect(r?.state.reviewCount).toBe(2);
		expect(r?.state.event).toBe("REQUEST_CHANGES");
		expect(r?.state.findings).toEqual([
			{
				id: findingId("src/a.ts", 42, "Unchecked cast"),
				path: "src/a.ts",
				line: 42,
				title: "Unchecked cast",
				severity: "P1",
				status: "open",
			},
		]);
	});

	it("only the source review's round is read", () => {
		const ledger: Ledger = [
			entry({ id: "r0:c1:0", round: 0, path: "a.ts", line: 1, title: "Old" }),
			entry({ id: "r1:c2:0", round: 1, path: "b.ts", line: 2, title: "New" }),
			entry({
				id: "r1:c3:0",
				round: 1,
				path: "c.ts",
				line: 3,
				title: "Done",
				status: "fixed",
			}),
		];
		const r = deriveBaseline(
			{ id: 20, body: body({ inline: "Inline comments: 2" }) },
			warm(ledger),
		);
		expect(r?.complete).toBe(true);
		expect(r?.state.findings.map((f) => f.title)).toEqual(["New"]);
	});

	it("deduplicates a ledger body entry against its body row", () => {
		const ledger: Ledger = [
			entry({ id: "r1:body:0", round: 1, title: "Missing null check" }),
			entry({
				id: "r1:c2:0",
				round: 1,
				path: "b.ts",
				line: 2,
				title: "Inline",
			}),
		];
		const b = body({
			rows: ["| 🟠 | **Missing null check** |"],
			inline: "Inline comments: 1",
		});
		const r = deriveBaseline({ id: 20, body: b }, warm(ledger));
		expect(r?.state.findings.map((f) => f.title).sort()).toEqual([
			"Inline",
			"Missing null check",
		]);
	});

	it("a source with no findings gives an empty list", () => {
		const r = deriveBaseline({ id: 20, body: body({}) }, warm([]));
		expect(r?.state.findings).toEqual([]);
		expect(r?.state.event).toBe("COMMENT");
		expect(r?.complete).toBe(true);
	});

	it("unanchored bullets are recovered", () => {
		const b = body({
			bullets: ["> - 🔴 **SQL built from input** (`src/db.ts:17`)"],
		});
		const r = deriveBaseline({ id: 20, body: b }, warm([]));
		expect(r?.state.findings).toEqual([
			{
				id: findingId("src/db.ts", 17, "SQL built from input"),
				path: "src/db.ts",
				line: 17,
				title: "SQL built from input",
				severity: "P0",
				status: "open",
			},
		]);
	});

	it("cold ledger with inline comments is incomplete", () => {
		const r = deriveBaseline(
			{ id: 20, body: body({ inline: "Inline comments: 3" }) },
			{ entries: [], reviewIds: [], warm: false },
		);
		expect(r?.complete).toBe(false);
	});

	it("cold ledger with Inline comments: none is complete", () => {
		const r = deriveBaseline(
			{ id: 20, body: body({ rows: ["| 🟡 | **Naming** |"] }) },
			{ entries: [], reviewIds: [], warm: false },
		);
		expect(r?.complete).toBe(true);
		expect(r?.state.findings).toHaveLength(1);
	});

	it("source id missing from reviewIds is incomplete", () => {
		const r = deriveBaseline({ id: 99, body: body({}) }, warm([]));
		expect(r?.complete).toBe(false);
	});

	it("a title ending in parentheses without a path:line pair is untouched", () => {
		const b = body({ rows: ["| 🟡 | **Retry loop (see docs)** |"] });
		const r = deriveBaseline({ id: 20, body: b }, warm([]));
		expect(r?.state.findings[0]).toMatchObject({
			path: null,
			line: null,
			title: "Retry loop (see docs)",
		});
	});

	it("parses legacy Reviewed commit bodies", () => {
		const b =
			"### ai-review\nReviewed commit: `deadbee`\n\n| Sev | Finding |\n|---|---|\n| 🔴 | Unsafe eval |";
		const r = deriveBaseline({ id: 20, body: b }, warm([]));
		expect(r?.state.lastReviewedSha).toBe("deadbee");
		expect(r?.state.reviewCount).toBe(0);
		expect(r?.state.findings[0].title).toBe("Unsafe eval");
	});
});
