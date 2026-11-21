import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	entryHeadings,
	loadEntries,
	parseEntries,
	selectEntries,
} from "./f1-runbooks.js";

const SECTIONS = [
	"What it looks like in a diff",
	"How to recognize it",
	"Likely intents",
	"Context to gather",
	"What not to spend review on",
	"Checklist",
	"How it combines with domain playbooks",
	"Red flags",
	"Worked example",
	"ai-review-bot today",
	"Eval seed",
];

function entry(id: string, name: string): string {
	const body = SECTIONS.map((s) => `### ${s}\n\nbody of ${s}\n`).join("\n");
	return `## ${id}: ${name}\n\n${body}`;
}

describe("f1 runbooks", () => {
	it("loads all 60 operation ids from the committed entry files", () => {
		const entries = loadEntries();
		expect(entries.size).toBe(60);
		expect(entries.has("REL-01")).toBe(true);
		expect(entries.has("REL-00")).toBe(false);
	});

	it("keeps only the heading, What not to spend review on, Checklist and Red flags", () => {
		const kept = parseEntries(entry("REL-01", "Rename")).get("REL-01") ?? "";
		expect(kept).toContain("## REL-01: Rename");
		expect(kept).toContain("body of What not to spend review on");
		expect(kept).toContain("body of Checklist");
		expect(kept).toContain("body of Red flags");
		expect(kept).not.toContain("Worked example");
		expect(kept).not.toContain("Eval seed");
		expect(kept).not.toContain("Context to gather");
	});

	it("ignores a heading that is not an operation id", () => {
		const md = `## Field reference\n\n### Checklist\n\nx\n\n${entry("REL-02", "Move")}`;
		expect([...parseEntries(md).keys()]).toEqual(["REL-02"]);
	});

	it("selectEntries drops unknown ids, deduplicates and caps at 4", () => {
		const md = ["01", "02", "03", "04", "05"]
			.map((n) => entry(`REL-${n}`, `Op ${n}`))
			.join("\n");
		const entries = parseEntries(md);
		const out = selectEntries(entries, [
			"REL-03",
			"NOPE-01",
			"REL-03",
			"REL-01",
			"REL-02",
			"REL-04",
			"REL-05",
		]);
		const ids = [...out.matchAll(/^## (REL-\d{2}):/gm)].map((m) => m[1]);
		expect(ids).toEqual(["REL-03", "REL-01", "REL-02", "REL-04"]);
		expect(out).toContain("\n\n## REL-01:");
	});

	it("selectEntries returns the empty string when nothing matches", () => {
		expect(selectEntries(parseEntries(entry("REL-01", "A")), ["X-1"])).toBe("");
	});

	it("entryHeadings returns id and name for REL-01", () => {
		const found = entryHeadings(loadEntries()).find((h) => h.id === "REL-01");
		expect(found?.id).toBe("REL-01");
		expect(found?.name.length).toBeGreaterThan(0);
	});

	it("throws on a duplicate id across files", () => {
		const dir = mkdtempSync(join(tmpdir(), "f1-dup-"));
		writeFileSync(join(dir, "a.md"), entry("REL-01", "one"));
		writeFileSync(join(dir, "b.md"), entry("REL-01", "two"));
		expect(() => loadEntries(dir)).toThrow(/duplicate operation id REL-01/);
	});

	it("throws when an entry has no kept section", () => {
		const dir = mkdtempSync(join(tmpdir(), "f1-empty-"));
		writeFileSync(
			join(dir, "a.md"),
			"## REL-01: one\n\n### Worked example\n\nbody\n",
		);
		expect(() => loadEntries(dir)).toThrow(/REL-01.*no kept section/);
	});
});
