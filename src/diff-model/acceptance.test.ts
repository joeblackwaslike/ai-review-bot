import { describe, expect, it } from "vitest";
import {
	type Candidate,
	collectRuns,
	type PushFile,
	type Run,
} from "../moved-blocks.js";
import { acceptSeed, isUnique, lineInformation } from "./acceptance.js";
import { WorkBudget } from "./budget.js";

function patchFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function deletedLines(filename: string, lines: string[]): PushFile {
	return patchFile(
		filename,
		[`@@ -1,${lines.length} +0,0 @@`, ...lines.map((l) => `-${l}`)].join("\n"),
	);
}

function addedLines(filename: string, lines: string[]): PushFile {
	return patchFile(
		filename,
		[`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n"),
	);
}

function seedFor(deletedFiles: string[][], addedFiles: string[][]) {
	const files = [
		...deletedFiles.map((l, i) => deletedLines(`d${i}.ts`, l)),
		...addedFiles.map((l, i) => addedLines(`a${i}.ts`, l)),
	];
	const { deleted, added } = collectRuns(files);
	const from = deleted[0];
	const to = added[0];
	if (!from || !to) throw new Error("fixture needs both sides");
	const length = from.lines.length;
	const counted = from.lines.filter((l) => l.trimStart().length >= 3).length;
	const c: Candidate = { from, to, fromStart: 0, toStart: 0, length, counted };
	return { c, deleted, added };
}

describe("lineInformation", () => {
	it("counts non-space characters of a line with an identifier", () => {
		expect(lineInformation("  const total = price * qty;")).toBe(
			"const total = price * qty;".replace(/\s/g, "").length,
		);
	});

	it("counts a line with a literal that is not the whole line", () => {
		expect(lineInformation("  return 0;")).toBe(8);
	});

	it("is zero for closers and bare keywords", () => {
		for (const line of ["}", "  });", "end", "} else {", "  else", "return;"])
			expect(lineInformation(line)).toBe(0);
	});

	it("is zero for import, require, use and re-export lines", () => {
		for (const line of [
			'import { readFile } from "node:fs/promises";',
			'const fs = require("node:fs");',
			"use std::collections::HashMap;",
			"from os import path",
			'export * from "./util";',
			'export { a, b } from "./util";',
		])
			expect(lineInformation(line)).toBe(0);
	});

	it("is zero for lines of only Python and Go keywords", () => {
		for (const line of ["  return None", "  pass", "  return True", "  defer"])
			expect(lineInformation(line)).toBe(0);
	});

	it("is zero for a bare string, number or array literal", () => {
		for (const line of ['  "fast", "slow",', "  42,", "[1, 2, 3]"])
			expect(lineInformation(line)).toBe(0);
	});
});

describe("isUnique", () => {
	const block = [
		"  const subtotal = computeSubtotal(items);",
		"  const tax = subtotal * rate;",
	];

	it("is true when the text occurs once on each side", () => {
		const { c, deleted, added } = seedFor([block], [block]);
		expect(isUnique(c, deleted, added)).toBe(true);
	});

	it("is false when the text occurs twice among the deleted runs", () => {
		const { c, deleted, added } = seedFor([block, block], [block]);
		expect(isUnique(c, deleted, added)).toBe(false);
	});

	it("is false when the text occurs twice among the added runs", () => {
		const { c, deleted, added } = seedFor([block], [block, block]);
		expect(isUnique(c, deleted, added)).toBe(false);
	});
});

describe("acceptSeed", () => {
	it("keeps accepting five counted lines whatever their text", () => {
		const block = Array.from({ length: 5 }, () => "  next();");
		const { c, deleted, added } = seedFor([block], [block]);
		expect(acceptSeed(c, { deleted, added })).toBe(true);
	});

	it("accepts a distinctive two-line block", () => {
		const block = [
			"  const subtotal = computeSubtotal(items);",
			"  const tax = subtotal * rate;",
		];
		const { c, deleted, added } = seedFor([block], [block]);
		expect(acceptSeed(c, { deleted, added })).toBe(true);
	});

	it("rejects a short block with too little information", () => {
		const block = ["  const a = f(x);"];
		const { c, deleted, added } = seedFor([block], [block]);
		expect(acceptSeed(c, { deleted, added })).toBe(false);
	});

	it("accepts a unique definition of 30 to 39 characters", () => {
		const def = ["function areaOf(a, b) {", "  return a * b;", "}"];
		const chars = def.join("").replace(/\s/g, "").length;
		expect(chars).toBeGreaterThanOrEqual(30);
		expect(chars).toBeLessThan(40);
		const seed = seedFor([def], [def]);
		expect(acceptSeed(seed.c, seed)).toBe(true);
	});

	it("rejects two identical short definitions by uniqueness", () => {
		const def = ["function areaOf(a, b) {", "  return a * b;", "}"];
		const { c, deleted, added } = seedFor([def, def], [def]);
		expect(acceptSeed(c, { deleted, added })).toBe(false);
	});

	it("rejects a one-line seed with more openers than closers", () => {
		const block = ["export async function fetchEverythingFromTheServer("];
		const { c, deleted, added } = seedFor([block], [block]);
		expect(acceptSeed(c, { deleted, added })).toBe(false);
	});

	it("rejects a lone Python def line ending in a colon", () => {
		const block = ["def compute_the_total_with_offset(value, offset):"];
		const files = [deletedLines("d.py", block), addedLines("a.py", block)];
		const { deleted, added } = collectRuns(files);
		const from = deleted[0] as Run;
		const to = added[0] as Run;
		const c: Candidate = {
			from,
			to,
			fromStart: 0,
			toStart: 0,
			length: 1,
			counted: 1,
		};
		expect(acceptSeed(c, { deleted, added })).toBe(false);
	});

	it("draws the budget for a seed of five or more counted lines", () => {
		const block = Array.from({ length: 5 }, () => "  next();");
		const { c, deleted, added } = seedFor([block], [block]);
		const budget = new WorkBudget({ candidates: 0 });
		expect(acceptSeed(c, { deleted, added, budget })).toBe(false);
	});

	it("rejects everything once the budget is exhausted", () => {
		const block = [
			"  const subtotal = computeSubtotal(items);",
			"  const tax = subtotal * rate;",
		];
		const { c, deleted, added } = seedFor([block], [block]);
		const budget = new WorkBudget({ candidates: 0 });
		expect(acceptSeed(c, { deleted, added, budget })).toBe(false);
		expect(budget.exhausted).toBe(true);
	});
});
