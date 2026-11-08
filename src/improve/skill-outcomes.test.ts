import { describe, expect, it } from "vitest";
import type { Ledger, LedgerEntry } from "../ledger/types.js";
import {
	type CatalogFinding,
	formatSkillOutcomes,
	ledgerKey,
	summarizeSkillOutcomes,
} from "./skill-outcomes.js";

const finding = (over: Partial<CatalogFinding> = {}): CatalogFinding => ({
	id: 1,
	owner: "o",
	repo: "r",
	pr: 7,
	reviewer: "claude",
	commentId: 11,
	path: "src/a.ts",
	line: 10,
	title: "Token cache never expires",
	skills: ["code-reviewer.md"],
	postedAt: "2026-11-03T10:00:00Z",
	...over,
});

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
	id: "r0:c11:0",
	round: 0,
	path: "src/a.ts",
	line: 10,
	severity: "P2",
	title: "Token cache never expires",
	status: "open",
	decidedBy: null,
	reason: null,
	evidence: [],
	...over,
});

const summarize = (findings: CatalogFinding[], ledger: Ledger) =>
	summarizeSkillOutcomes(findings, () => ledger);

const bySkill = (rows: ReturnType<typeof summarize>, skill: string) => {
	const row = rows.find((r) => r.skill === skill);
	if (!row) throw new Error(`no row for ${skill}`);
	return row;
};

describe("summarizeSkillOutcomes", () => {
	it("reads author outcomes from the ledger: fixed, rejected, deferred, unanswered", () => {
		const findings = [
			finding({ id: 1, commentId: 11, title: "A" }),
			finding({ id: 2, commentId: 12, title: "B", line: 40 }),
			finding({ id: 3, commentId: 13, title: "C", line: 80 }),
			finding({ id: 4, commentId: 14, title: "D", line: 120 }),
		];
		const ledger: Ledger = [
			entry({
				id: "r0:c11:0",
				title: "A",
				status: "fixed",
				decidedBy: "author",
			}),
			entry({
				id: "r0:c12:0",
				title: "B",
				line: 40,
				status: "rejected",
				decidedBy: "author",
			}),
			entry({
				id: "r0:c13:0",
				title: "C",
				line: 80,
				status: "deferred",
				decidedBy: "author",
			}),
			entry({ id: "r0:c14:0", title: "D", line: 120 }),
		];
		const row = bySkill(summarize(findings, ledger), "code-reviewer.md");
		expect(row).toMatchObject({
			posted: 4,
			accepted: 1,
			rejected: 1,
			deferred: 1,
			unanswered: 1,
			unmatched: 0,
		});
	});

	it("counts a thumbs-down on an open entry as rejected", () => {
		const row = bySkill(
			summarize([finding()], [entry({ reactions: ["down"] })]),
			"code-reviewer.md",
		);
		expect(row.rejected).toBe(1);
		expect(row.unanswered).toBe(0);
	});

	it("credits a finding to every skill that raised it", () => {
		const rows = summarize(
			[finding({ skills: ["code-reviewer.md", "security-sast.md"] })],
			[entry({ status: "fixed", decidedBy: "author" })],
		);
		expect(bySkill(rows, "code-reviewer.md").accepted).toBe(1);
		expect(bySkill(rows, "security-sast.md").accepted).toBe(1);
	});

	it("counts a finding with no ledger entry as unmatched, never as an outcome", () => {
		const row = bySkill(summarize([finding()], []), "code-reviewer.md");
		expect(row).toMatchObject({
			posted: 1,
			unmatched: 1,
			accepted: 0,
			rejected: 0,
			deferred: 0,
			unanswered: 0,
		});
	});

	it("matches a finding to its own claim when one comment carries several", () => {
		const findings = [
			finding({ id: 1, title: "First claim", skills: ["a.md"] }),
			finding({ id: 2, title: "Second claim", line: 30, skills: ["b.md"] }),
		];
		const ledger: Ledger = [
			entry({
				id: "r0:c11:0",
				title: "First claim",
				status: "fixed",
				decidedBy: "author",
			}),
			entry({
				id: "r0:c11:1",
				title: "Second claim",
				line: 30,
				status: "rejected",
				decidedBy: "author",
			}),
		];
		const rows = summarize(findings, ledger);
		expect(bySkill(rows, "a.md").accepted).toBe(1);
		expect(bySkill(rows, "b.md").rejected).toBe(1);
	});

	it("counts a later finding that restates an earlier one on the same PR and reviewer", () => {
		const earlier = finding({ id: 1, commentId: 11 });
		const later = finding({
			id: 2,
			commentId: 12,
			line: 12,
			postedAt: "2026-11-04T10:00:00Z",
			skills: ["silent-failure-hunter.md"],
		});
		const rows = summarize([earlier, later], []);
		expect(bySkill(rows, "silent-failure-hunter.md").restated).toBe(1);
		expect(bySkill(rows, "code-reviewer.md").restated).toBe(0);
	});

	it("does not call it a restatement across reviewers or PRs", () => {
		const base = finding({ id: 1 });
		const otherReviewer = finding({
			id: 2,
			commentId: 12,
			reviewer: "codex",
			skills: ["x.md"],
		});
		const otherPr = finding({
			id: 3,
			commentId: 13,
			pr: 8,
			skills: ["y.md"],
		});
		const rows = summarize([base, otherReviewer, otherPr], []);
		expect(bySkill(rows, "x.md").restated).toBe(0);
		expect(bySkill(rows, "y.md").restated).toBe(0);
	});

	it("looks up each finding's ledger by repo, PR and reviewer", () => {
		const seen: string[] = [];
		summarizeSkillOutcomes([finding()], (f) => {
			seen.push(ledgerKey(f));
			return [];
		});
		expect(seen).toEqual(["o/r#7:claude"]);
	});
});

describe("formatSkillOutcomes", () => {
	it("renders one row per skill with the rejection rate over answered findings", () => {
		const table = formatSkillOutcomes([
			{
				skill: "code-reviewer.md",
				posted: 10,
				accepted: 3,
				rejected: 1,
				deferred: 0,
				unanswered: 5,
				unmatched: 1,
				restated: 2,
			},
		]);
		expect(table).toContain("| Skill |");
		expect(table).toContain(
			"| code-reviewer.md | 10 | 3 | 1 | 0 | 5 | 2 | 1 | 25% |",
		);
	});

	it("shows a dash when nothing was answered", () => {
		const table = formatSkillOutcomes([
			{
				skill: "a.md",
				posted: 2,
				accepted: 0,
				rejected: 0,
				deferred: 0,
				unanswered: 2,
				unmatched: 0,
				restated: 0,
			},
		]);
		expect(table).toContain("| a.md | 2 | 0 | 0 | 0 | 2 | 0 | 0 | - |");
	});
});
