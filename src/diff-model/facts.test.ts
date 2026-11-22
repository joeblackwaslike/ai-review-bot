import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildPrFacts } from "./facts.js";

function f(filename: string): PushFile {
	return { filename, status: "modified", additions: 1, deletions: 0 };
}

const base = { title: "t", body: null };

describe("buildPrFacts", () => {
	it("testsChanged is unknown when prFilesComplete is false", () => {
		const facts = buildPrFacts({
			...base,
			prFiles: [f("src/a.ts")],
			prFilesComplete: false,
		});
		expect(facts.testsChanged).toBe("unknown");
	});

	it("testsChanged is false when the list is complete and has no test", () => {
		const facts = buildPrFacts({
			...base,
			prFiles: [f("src/a.ts")],
			prFilesComplete: true,
		});
		expect(facts.testsChanged).toBe(false);
	});

	it("testsChanged is true when a test path changed", () => {
		const facts = buildPrFacts({
			...base,
			prFiles: [f("src/a.test.ts")],
			prFilesComplete: false,
		});
		expect(facts.testsChanged).toBe(true);
	});

	it("intent claims capture 'no functional change' with the PR text span", () => {
		const text = "This is a refactor. No functional change here.";
		const facts = buildPrFacts({
			prFiles: [],
			prFilesComplete: true,
			title: "Tidy",
			body: text,
		});
		const start = text.indexOf("No functional");
		expect(facts.intentClaims).toEqual([
			{
				phrase: "no functional change",
				source: "body",
				start,
				end: start + "No functional change".length,
			},
		]);
	});

	it("attributes a title claim to the title source", () => {
		const facts = buildPrFacts({
			prFiles: [],
			prFilesComplete: true,
			title: "Refactor only: split module",
			body: null,
		});
		expect(facts.intentClaims).toEqual([
			{ phrase: "refactor only", source: "title", start: 0, end: 13 },
		]);
	});

	it("does not match a phrase inside a longer word or a negation", () => {
		const facts = buildPrFacts({
			prFiles: [],
			prFilesComplete: true,
			title: "Renamed the helper",
			body: "There are no functional changes. Also a renamed field.",
		});
		expect(facts.intentClaims).toEqual([]);
	});
});
