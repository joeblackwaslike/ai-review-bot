import { describe, expect, it } from "vitest";
import {
	collectRightSideLines,
	numberPatchLines,
	rightSideText,
} from "./diff-lines.js";

const TWO_HUNKS = [
	"@@ -1,3 +1,3 @@",
	" a",
	"-b",
	"+B",
	" c",
	"@@ -20,2 +20,3 @@",
	" x",
	"+y",
	" z",
].join("\n");

describe("numberPatchLines", () => {
	it("numbers right-side lines across hunks and blanks deletions", () => {
		expect(numberPatchLines(TWO_HUNKS).split("\n")).toEqual([
			"@@ -1,3 +1,3 @@",
			"   1| a",
			"    |-b",
			"   2|+B",
			"   3| c",
			"@@ -20,2 +20,3 @@",
			"  20| x",
			"  21|+y",
			"  22| z",
		]);
	});

	it("leaves a no-newline line with no margin at all", () => {
		const out = numberPatchLines(
			["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n"),
		);
		expect(out.split("\n")).toEqual([
			"@@ -1 +1 @@",
			"    |-a",
			"\\ No newline at end of file",
			"   1|+b",
		]);
	});

	it("leaves the truncation marker with no margin and keeps prefix numbers", () => {
		const patch = [
			"@@ -1,2 +1,2 @@",
			...Array.from({ length: 40 }, (_, i) => `+line${i}`),
		].join("\n");
		const out = numberPatchLines(
			`${patch.slice(0, 100)}\n\n[patch truncated]`,
		).split("\n");
		expect(out.at(-1)).toBe("[patch truncated]");
		expect(out[1]).toBe("   1|+line0");
		expect(out[2]).toBe("   2|+line1");
	});
});

describe("rightSideText", () => {
	it("maps right-side numbers to line text without the diff prefix", () => {
		expect(Array.from(rightSideText(TWO_HUNKS))).toEqual([
			[1, "a"],
			[2, "B"],
			[3, "c"],
			[20, "x"],
			[21, "y"],
			[22, "z"],
		]);
	});
});

describe("collectRightSideLines", () => {
	it("returns the same numbers the numbering uses", () => {
		expect(Array.from(collectRightSideLines(TWO_HUNKS))).toEqual([
			1, 2, 3, 20, 21, 22,
		]);
	});
});
