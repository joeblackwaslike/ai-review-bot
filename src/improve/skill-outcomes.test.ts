import { describe, expect, it } from "vitest";
import type { Ledger, LedgerEntry } from "../ledger/types.js";
import {
	type CatalogFinding,
	formatSkillOutcomes,
	ledgerKey,
	loadLedgers,
	parseSinceDate,
	prefixCandidates,
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

	it("does not hand a merged comment's only ledger entry to a different claim", () => {
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
		];
		const rows = summarize(findings, ledger);
		expect(bySkill(rows, "a.md").accepted).toBe(1);
		expect(bySkill(rows, "b.md")).toMatchObject({ accepted: 0, unmatched: 1 });
	});

	it("leaves a finding unmatched when several claims share its comment and none has its title", () => {
		const ledger: Ledger = [
			entry({ id: "r0:c11:0", title: "Something else" }),
			entry({ id: "r0:c11:1", title: "Another thing", line: 30 }),
		];
		expect(
			bySkill(summarize([finding()], ledger), "code-reviewer.md"),
		).toMatchObject({ unmatched: 1, unanswered: 0 });
	});

	it("leaves a finding with no comment id unmatched", () => {
		const row = bySkill(
			summarize([finding({ commentId: null })], [entry()]),
			"code-reviewer.md",
		);
		expect(row.unmatched).toBe(1);
	});

	it("counts a restatement of a finding posted before the reporting window, without counting the old one", () => {
		const before = finding({
			id: 1,
			commentId: 11,
			postedAt: "2026-11-01T10:00:00Z",
			skills: ["old.md"],
		});
		const inWindow = finding({
			id: 2,
			commentId: 12,
			line: 12,
			postedAt: "2026-11-03T10:00:00Z",
			skills: ["new.md"],
		});
		const rows = summarizeSkillOutcomes([before, inWindow], () => [], {
			since: new Date("2026-11-02T00:00:00Z"),
		});
		expect(rows.map((r) => r.skill)).toEqual(["new.md"]);
		expect(bySkill(rows, "new.md")).toMatchObject({ posted: 1, restated: 1 });
	});

	it("does not give a comment's only ledger entry to a claim whose unattributed sibling shares the comment", () => {
		const attributed = finding({ id: 1, title: "Attributed claim" });
		const sibling = finding({
			id: 2,
			title: "Unattributed claim",
			line: 30,
			skills: [],
		});
		const ledger: Ledger = [
			entry({
				id: "r0:c11:1",
				title: "Unattributed claim",
				line: 30,
				status: "fixed",
				decidedBy: "author",
			}),
		];
		const row = bySkill(
			summarize([attributed, sibling], ledger),
			"code-reviewer.md",
		);
		expect(row).toMatchObject({ accepted: 0, unmatched: 1 });
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

describe("prefixCandidates", () => {
	it("tries the configured prefix first, then the reviewer default and the bare ai-review heading", () => {
		expect(prefixCandidates("claude", "ai-review-bot")).toEqual([
			"ai-review-bot",
			"claude-review-bot",
			"ai-review",
		]);
	});

	it("lists each prefix once", () => {
		expect(prefixCandidates("codex", "codex-review-bot")).toEqual([
			"codex-review-bot",
			"ai-review",
		]);
	});
});

describe("parseSinceDate", () => {
	it("accepts a real calendar date as midnight UTC", () => {
		expect(parseSinceDate("2026-11-02")?.toISOString()).toBe(
			"2026-11-02T00:00:00.000Z",
		);
	});

	it.each([
		"2026-02-30",
		"2026-13-01",
		"2026-1-5",
		"yesterday",
		"",
	])("rejects %j", (input) => {
		expect(parseSinceDate(input)).toBeNull();
	});
});

describe("loadLedgers", () => {
	const f1 = finding({ id: 1, pr: 7 });
	const f2 = finding({ id: 2, pr: 7, commentId: 12 });
	const f3 = finding({ id: 3, pr: 8, commentId: 13 });
	const populated: Ledger = [entry()];
	const configured = () => "ai-review-bot";

	it("falls back to the next prefix when the first ledger is empty", async () => {
		const tried: string[] = [];
		const { ledgers, failed } = await loadLedgers(
			[f1],
			async (_f, prefix) => {
				tried.push(prefix);
				return prefix === "claude-review-bot" ? populated : [];
			},
			configured,
		);
		expect(tried).toEqual(["ai-review-bot", "claude-review-bot"]);
		expect(ledgers.get(ledgerKey(f1))).toBe(populated);
		expect(failed.size).toBe(0);
	});

	it("keeps an empty ledger as a success when every prefix is empty", async () => {
		const { ledgers, failed } = await loadLedgers(
			[f1],
			async () => [],
			configured,
		);
		expect(ledgers.get(ledgerKey(f1))).toEqual([]);
		expect(failed.size).toBe(0);
	});

	it("does not let an earlier empty ledger hide a later fetch failure", async () => {
		const { ledgers, failed } = await loadLedgers(
			[f1],
			async (_f, prefix) => {
				if (prefix === "ai-review-bot") return [];
				throw new Error("403 from GitHub");
			},
			configured,
		);
		expect(ledgers.has(ledgerKey(f1))).toBe(false);
		expect(failed.get(ledgerKey(f1))).toContain("403 from GitHub");
	});

	it("loads each PR and reviewer once and records a failed one once", async () => {
		let calls = 0;
		const { ledgers, failed } = await loadLedgers(
			[f1, f2, f3],
			async (f) => {
				calls += 1;
				if (f.pr === 8) throw new Error("boom");
				return populated;
			},
			configured,
		);
		expect(ledgers.has(ledgerKey(f1))).toBe(true);
		expect([...failed.keys()]).toEqual([ledgerKey(f3)]);
		expect(calls).toBe(2);
	});
});
