import { describe, expect, it } from "vitest";
import { type AgentRecord, formatAgentsMarker } from "./agent-log.js";
import { deriveBaseline } from "./baseline.js";
import type { Ledger, LedgerEntry } from "./ledger/types.js";
import { KNOWN_SKILLS } from "./review.js";
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
		"| Sev | Category | Finding |",
		"|---|---|---|",
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
		expect(deriveBaseline(null, warm([]), KNOWN_SKILLS)).toBeNull();
		expect(
			deriveBaseline({ id: 20, body: "hello" }, warm([]), KNOWN_SKILLS),
		).toBeNull();
	});

	it("carried row with a path suffix gets path, line and a clean title", () => {
		const b = body({
			carried: ["| 🟠 | **Unchecked cast** (`src/a.ts:42`) |"],
		});
		const r = deriveBaseline({ id: 20, body: b }, warm([]), KNOWN_SKILLS);
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

	it("carried row whose path has a space keeps the whole path", () => {
		const b = body({
			carried: ["| 🟡 | **Broken link** (`docs/My File.md:12`) |"],
		});
		const r = deriveBaseline({ id: 20, body: b }, warm([]), KNOWN_SKILLS);
		expect(r?.state.findings).toEqual([
			{
				id: findingId("docs/My File.md", 12, "Broken link"),
				path: "docs/My File.md",
				line: 12,
				title: "Broken link",
				severity: "P2",
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
			KNOWN_SKILLS,
		);
		expect(r?.complete).toBe(true);
		expect(r?.state.findings.map((f) => f.title)).toEqual(["New"]);
	});

	it("ignores body-sourced ledger entries in favor of the body row", () => {
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
			rows: ["| 🟠 | bug | **Missing null check** |"],
			inline: "Inline comments: 1",
		});
		const r = deriveBaseline({ id: 20, body: b }, warm(ledger), KNOWN_SKILLS);
		expect(r?.state.findings.map((f) => f.title).sort()).toEqual([
			"Inline",
			"Missing null check",
		]);
	});

	it("deduplicates an inline ledger entry against the same carried row", () => {
		const ledger: Ledger = [
			entry({
				id: "r1:c2:0",
				round: 1,
				path: "src/a.ts",
				line: 42,
				title: "Unchecked cast",
			}),
		];
		const b = body({
			carried: ["| 🟠 | **Unchecked cast** (`src/a.ts:42`) |"],
			inline: "Inline comments: 1",
		});
		const r = deriveBaseline({ id: 20, body: b }, warm(ledger), KNOWN_SKILLS);
		expect(r?.state.findings).toHaveLength(1);
		expect(r?.state.findings[0].id).toBe(
			findingId("src/a.ts", 42, "Unchecked cast"),
		);
	});

	it("recovers a path suffix on a ledger entry with a null path", () => {
		const ledger: Ledger = [
			entry({ id: "r1:c2:0", round: 1, title: "Race (`src/q.ts:9`)" }),
		];
		const r = deriveBaseline(
			{ id: 20, body: body({ inline: "Inline comments: 1" }) },
			warm(ledger),
			KNOWN_SKILLS,
		);
		expect(r?.state.findings[0]).toMatchObject({
			path: "src/q.ts",
			line: 9,
			title: "Race",
		});
	});

	it("leaves a ledger entry with a path untouched even if the title ends in a suffix", () => {
		const ledger: Ledger = [
			entry({
				id: "r1:c2:0",
				round: 1,
				path: "a.ts",
				line: 3,
				title: "Bad call (`x:1`)",
			}),
		];
		const r = deriveBaseline(
			{ id: 20, body: body({ inline: "Inline comments: 1" }) },
			warm(ledger),
			KNOWN_SKILLS,
		);
		expect(r?.state.findings[0]).toMatchObject({
			path: "a.ts",
			line: 3,
			title: "Bad call (`x:1`)",
		});
	});

	it("a source with no findings gives an empty list", () => {
		const r = deriveBaseline(
			{ id: 20, body: body({}) },
			warm([]),
			KNOWN_SKILLS,
		);
		expect(r?.state.findings).toEqual([]);
		expect(r?.state.event).toBe("COMMENT");
		expect(r?.complete).toBe(true);
	});

	it("unanchored bullets are recovered", () => {
		const b = body({
			bullets: ["> - 🔴 **SQL built from input** (`src/db.ts:17`)"],
		});
		const r = deriveBaseline({ id: 20, body: b }, warm([]), KNOWN_SKILLS);
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
			KNOWN_SKILLS,
		);
		expect(r?.complete).toBe(false);
	});

	it("cold ledger with Inline comments: none is complete", () => {
		const r = deriveBaseline(
			{ id: 20, body: body({ rows: ["| 🟡 | style | **Naming** |"] }) },
			{ entries: [], reviewIds: [], warm: false },
			KNOWN_SKILLS,
		);
		expect(r?.complete).toBe(true);
		expect(r?.state.findings).toHaveLength(1);
	});

	it("source id missing from reviewIds is incomplete", () => {
		const r = deriveBaseline(
			{ id: 99, body: body({}) },
			warm([]),
			KNOWN_SKILLS,
		);
		expect(r?.complete).toBe(false);
	});

	it("a title ending in parentheses without a path:line pair is untouched", () => {
		const b = body({ rows: ["| 🟡 | style | **Retry loop (see docs)** |"] });
		const r = deriveBaseline({ id: 20, body: b }, warm([]), KNOWN_SKILLS);
		expect(r?.state.findings[0]).toMatchObject({
			path: null,
			line: null,
			title: "Retry loop (see docs)",
		});
	});

	it("parses legacy Reviewed commit bodies", () => {
		const b =
			"### ai-review\nReviewed commit: `deadbee`\n\n| Sev | Finding |\n|---|---|\n| 🔴 | Unsafe eval |";
		const r = deriveBaseline({ id: 20, body: b }, warm([]), KNOWN_SKILLS);
		expect(r?.state.lastReviewedSha).toBe("deadbee");
		expect(r?.state.reviewCount).toBe(0);
		expect(r?.state.findings[0].title).toBe("Unsafe eval");
	});
});

describe("deriveBaseline metadata block", () => {
	it("reads the real sha and count, not a quoted earlier review's", () => {
		const quoted =
			"> <!-- ai-review:sha=1111111111111111 -->\n> <!-- ai-review:review=9 -->\n\n";
		const result = deriveBaseline(
			{ id: 20, body: quoted + body({ count: 3 }) },
			warm([]),
			KNOWN_SKILLS,
		);
		expect(result?.state.lastReviewedSha).toBe(SHA);
		expect(result?.state.reviewCount).toBe(3);
	});
});

describe("deriveBaseline incompleteSkills", () => {
	const failed: AgentRecord = {
		skill: "security-sast.md",
		attempt: 2,
		status: "error",
		class: "schema_mismatch",
		retryable: true,
		errorName: "AI_NoObjectGeneratedError",
	};

	it("reads the pending list from the agents marker", () => {
		const marker = formatAgentsMarker(
			[failed],
			["security-sast.md", "comment-analyzer.md"],
			KNOWN_SKILLS,
		);
		const r = deriveBaseline(
			{ id: 20, body: `${body({})}\n${marker}` },
			warm([]),
			KNOWN_SKILLS,
		);
		expect(r?.state.incompleteSkills).toEqual([
			"security-sast.md",
			"comment-analyzer.md",
		]);
	});

	it("drops a pending skill the caller does not know", () => {
		const marker = formatAgentsMarker(
			[failed],
			["security-sast.md", "comment-analyzer.md"],
			KNOWN_SKILLS,
		);
		const r = deriveBaseline(
			{ id: 20, body: `${body({})}\n${marker}` },
			warm([]),
			new Set(["comment-analyzer.md"]),
		);
		expect(r?.state.incompleteSkills).toEqual(["comment-analyzer.md"]);
	});

	it("an old body with no agents marker gives an empty list", () => {
		const r = deriveBaseline(
			{ id: 20, body: body({}) },
			warm([]),
			KNOWN_SKILLS,
		);
		expect(r?.state.incompleteSkills).toEqual([]);
	});

	it("a marker that does not parse gives an empty list", () => {
		const r = deriveBaseline(
			{ id: 20, body: `${body({})}\n<!-- ai-review:agents=notjson -->` },
			warm([]),
			KNOWN_SKILLS,
		);
		expect(r?.state.incompleteSkills).toEqual([]);
	});
});
