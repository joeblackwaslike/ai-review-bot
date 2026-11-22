import { describe, expect, it } from "vitest";
import { seedReviewInput } from "../replay/seeds/input.js";
import { listSeeds } from "../replay/seeds/schema.js";
import { buildDiffModel } from "./index.js";
import { renderDiffModel } from "./render.js";

async function renderSeed(id: string) {
	const seed = (await listSeeds()).find((s) => s.id === id);
	if (!seed) throw new Error(`no seed ${id}`);
	const input = await seedReviewInput(seed);
	const files = input.files.map((f) => ({
		...f,
		additions: f.additions ?? 0,
		deletions: f.deletions ?? 0,
	}));
	const model = buildDiffModel({
		scopeFiles: files,
		prFiles: files,
		prFilesComplete: true,
		title: input.title,
		body: input.body,
	});
	return renderDiffModel(model, { maxChars: 6000, scopeLabel: "whole PR" });
}

const lines = (text: string, needle: string) =>
	text.split("\n").filter((l) => l.includes(needle));

describe("rendering the real seed models", () => {
	it("words REL-15 original as a re-indented move with a signature line, code lines and a receiver line", async () => {
		const { summary } = await renderSeed("REL-15/original");
		expect(summary).toContain("re-indented one level deeper");
		expect(summary).toContain(
			"Relocation with 4 differences from the original",
		);
		expect(lines(summary, "Changed (signature)")).toHaveLength(1);
		expect(lines(summary, "Changed (code)")).toHaveLength(2);
		expect(lines(summary, "Changed (receiver prefix)")).toHaveLength(1);
	});

	it("words COP-01 original as a copy of context code with the source caveat", async () => {
		const { summary, fileNotes } = await renderSeed("COP-01/original");
		expect(summary).toMatch(/Copy( with \d+ differences?)?: /);
		expect(summary).toContain("(source visible in this diff only)");
		expect(summary).not.toContain(
			"whose source has lines this change also adds",
		);
		expect([...fileNotes.values()].join("\n")).toContain("Copied, lines");
	});
});
