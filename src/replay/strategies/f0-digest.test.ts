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
		expect(skill).toContain(id);
	});

	it("fits the byte budget", () => {
		expect(Buffer.byteLength(skill, "utf8")).toBeLessThanOrEqual(12000);
	});

	it("keeps the severity scale and confidence rule", () => {
		expect(skill).toContain("### Severity scale (P0–P3)");
		expect(skill).toContain("confidence ≥ 0.8");
	});
});
