import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync("skills/f0-runbook-reviewer.md", "utf8");
const opsDir = "docs/review-ontology/operations";

const ids = readdirSync(opsDir)
	.filter((f) => f.endsWith(".md") && f !== "_template.md")
	.flatMap((f) =>
		[
			...readFileSync(`${opsDir}/${f}`, "utf8").matchAll(/^## ([A-Z]+-\d+):/gm),
		].map((m) => m[1]),
	);

describe("f0 runbook digest", () => {
	it("finds the operation ids", () => {
		expect(ids.length).toBeGreaterThanOrEqual(50);
	});

	it.each(ids)("covers %s", (id) => {
		expect(skill).toMatch(new RegExp(`^${id} `, "m"));
	});

	it.each(ids)("gives %s a skip clause", (id) => {
		const line = skill.split("\n").find((l) => l.startsWith(`${id} `));
		expect(line).toMatch(/\bskip\b/);
	});

	it("fits the byte budget", () => {
		expect(Buffer.byteLength(skill, "utf8")).toBeLessThanOrEqual(13000);
	});

	it("copies the a0 severity section verbatim", () => {
		const a0 = readFileSync("skills/a0-single-reviewer.md", "utf8");
		const section = a0.match(
			/^## Severity, Fields, and Suggestions\n[\s\S]*?(?=^## )/m,
		)?.[0];
		expect(section).toBeTruthy();
		expect(skill).toContain(section?.trimEnd() ?? "");
	});

	it("copies the a0 general checklist verbatim and before the runbook triage", () => {
		const a0 = readFileSync("skills/a0-single-reviewer.md", "utf8");
		const section = a0.match(/^## What to look for\n[\s\S]*?(?=^## )/m)?.[0];
		expect(section).toBeTruthy();
		const body = section?.trimEnd() ?? "";
		expect(skill).toContain(body);
		expect(skill.indexOf(body)).toBeLessThan(skill.indexOf("## Triage"));
	});

	it("keeps the severity scale and confidence rule", () => {
		expect(skill).toContain("### Severity scale (P0–P3)");
		expect(skill).toContain("confidence ≥ 0.8");
	});
});
