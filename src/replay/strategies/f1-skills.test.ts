import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const a0 = readFileSync("skills/a0-single-reviewer.md", "utf8");
const f0 = readFileSync("skills/f0-runbook-reviewer.md", "utf8");
const reviewer = readFileSync("skills/f1-runbook-reviewer.md", "utf8");
const triage = readFileSync("skills/f1-triage.md", "utf8");

const section = (text: string, heading: string) =>
	text
		.match(new RegExp(`^## ${heading}\\n[\\s\\S]*?(?=^## )`, "m"))?.[0]
		.trimEnd() ?? "";

describe("f1 reviewer skill", () => {
	it("copies the a0 severity section verbatim", () => {
		const body = section(a0, "Severity, Fields, and Suggestions");
		expect(body).toBeTruthy();
		expect(reviewer).toContain(body);
	});

	it("copies the a0 general checklist verbatim", () => {
		const body = section(a0, "What to look for");
		expect(body).toBeTruthy();
		expect(reviewer).toContain(body);
	});

	it("says a check needing information outside the diff is skipped, never asked", () => {
		expect(reviewer).toContain("outside the diff");
		expect(reviewer).toMatch(/skipped/);
		expect(reviewer).toMatch(/never reported as a question/);
	});

	it("says the entries below add to the general list and that skip clauses bind", () => {
		expect(reviewer).toMatch(/add to the general list/);
		expect(reviewer).toMatch(/skip clause is binding/);
		expect(reviewer).toMatch(/end of a finding's `body`/);
		expect(reviewer).toMatch(/never in `title`/);
	});

	it("has no operation lines and no triage table", () => {
		expect(reviewer).not.toMatch(/^REL-01 /m);
		expect(reviewer).not.toContain("| Diff shape | Operations |");
	});

	it("keeps the confidence section", () => {
		expect(reviewer).toContain("confidence ≥ 0.8");
	});
});

describe("f1 triage skill", () => {
	const rows = f0
		.split("\n")
		.filter((l) => l.startsWith("| ") && !l.startsWith("| Diff shape"))
		.filter((l) => !l.startsWith("|---"))
		.filter((l) => f0.indexOf(l) > f0.indexOf("| Diff shape"));

	it("carries every diff-shape row of the f0 triage table", () => {
		expect(rows).toHaveLength(17);
		for (const row of rows) expect(triage).toContain(row);
	});

	it("asks for ids only and at most 4", () => {
		expect(triage).toMatch(/ids only/i);
		expect(triage).toMatch(/at most 4/);
		expect(triage).toMatch(/none when nothing matches/i);
	});

	it("ends with the Operations line", () => {
		expect(triage.trimEnd().split("\n").pop()).toBe("Operations:");
	});

	it("tells triage to use listed ids and never a range", () => {
		expect(triage).toContain("never write a range");
		expect(triage).toContain("ids from the list after `Operations:`");
	});

	it("tells the reviewer to skip steps that need a tool it lacks", () => {
		expect(reviewer).toContain("a tool you do not have");
	});
});
