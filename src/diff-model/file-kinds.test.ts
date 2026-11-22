import { describe, expect, it } from "vitest";
import { DATA_FILE, PROSE_FILE, UNMATCHED_FILES } from "./file-kinds.js";

describe("file kinds", () => {
	it.each([
		"go.sum",
		"svc/go.sum",
		"Gemfile.lock",
		"php/composer.lock",
		"pnpm-lock.yaml",
		"dist/app.min.js",
		"a/b.snap",
	])("leaves %s unmatched", (name) => {
		expect(UNMATCHED_FILES.test(name)).toBe(true);
	});

	it.each([
		"a.json",
		"a.jsonl",
		"tsconfig.json5",
	])("treats %s as data", (name) => {
		expect(DATA_FILE.test(name)).toBe(true);
	});

	it("treats markdown as prose and source as neither", () => {
		expect(PROSE_FILE.test("README.md")).toBe(true);
		expect(PROSE_FILE.test("src/a.ts")).toBe(false);
		expect(DATA_FILE.test("src/a.ts")).toBe(false);
		expect(UNMATCHED_FILES.test("src/a.ts")).toBe(false);
	});
});
