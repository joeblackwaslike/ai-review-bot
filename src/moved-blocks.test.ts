import { describe, expect, it } from "vitest";
import { findMovedBlocks, type PushFile } from "./moved-blocks.js";

const LINES = [
	"const alpha = compute(1);",
	"const beta = compute(2);",
	"const gamma = compute(3);",
	"const delta = compute(4);",
	"const epsilon = compute(5);",
	"const zeta = compute(6);",
];

function file(
	filename: string,
	deleted: string[],
	added: string[],
	patch?: string,
): PushFile {
	return {
		filename,
		status: "modified",
		additions: added.length,
		deletions: deleted.length,
		patch:
			patch ??
			[
				"@@ -1,9 +1,9 @@",
				...deleted.map((l) => `-${l}`),
				...added.map((l) => `+${l}`),
			].join("\n"),
	};
}

describe("findMovedBlocks", () => {
	it("finds 6 lines deleted in one file and added in another", () => {
		const out = findMovedBlocks([
			file("a.ts", LINES, []),
			file("b.ts", [], LINES),
		]);
		expect(out).toEqual([{ from: "a.ts", to: "b.ts", lineCount: 6 }]);
	});

	it("matches through re-indentation and trailing whitespace", () => {
		const out = findMovedBlocks([
			file("a.ts", LINES, []),
			file(
				"b.ts",
				[],
				LINES.map((l) => `\t\t${l.replace(/ /g, "  ")}   `),
			),
		]);
		expect(out).toEqual([{ from: "a.ts", to: "b.ts", lineCount: 6 }]);
	});

	it("ignores blocks shorter than minLines", () => {
		expect(
			findMovedBlocks([
				file("a.ts", LINES.slice(0, 4), []),
				file("b.ts", [], LINES.slice(0, 4)),
			]),
		).toEqual([]);
	});

	it("ignores lines deleted and added in the same file", () => {
		expect(findMovedBlocks([file("a.ts", LINES, LINES)])).toEqual([]);
	});

	it("ignores blocks of blank or lone-bracket lines", () => {
		const junk = ["", "}", ")", "", "}", "  ", ")", "}"];
		expect(
			findMovedBlocks([file("a.ts", junk, []), file("b.ts", [], junk)]),
		).toEqual([]);
	});

	it("does not throw when files have no patch", () => {
		const bare = (filename: string): PushFile => ({
			filename,
			status: "modified",
			additions: 0,
			deletions: 0,
		});
		expect(findMovedBlocks([bare("a.bin"), bare("b.bin")])).toEqual([]);
	});

	it("keeps short lines inside a run without counting them", () => {
		const withBrace = [...LINES.slice(0, 3), "}", ...LINES.slice(3, 5)];
		expect(
			findMovedBlocks([
				file("a.ts", withBrace, []),
				file("b.ts", [], withBrace),
			]),
		).toEqual([{ from: "a.ts", to: "b.ts", lineCount: 5 }]);
	});

	it("splits a block interrupted by one changed line", () => {
		const added = [
			...LINES.slice(0, 2),
			"const changed = 0;",
			...LINES.slice(3),
		];
		expect(
			findMovedBlocks([file("a.ts", LINES, []), file("b.ts", [], added)]),
		).toEqual([]);
		const long = [
			...LINES,
			"const eta = compute(7);",
			"const theta = compute(8);",
		];
		const interrupted = [
			...long.slice(0, 5),
			"const changed = 0;",
			...long.slice(6),
		];
		expect(
			findMovedBlocks(
				[file("a.ts", long, []), file("b.ts", [], interrupted)],
				2,
			).map((b) => b.lineCount),
		).toEqual([5, 2]);
	});

	it("treats context lines as run breaks and skips no-newline markers", () => {
		const patch = [
			"@@ -1,9 +1,3 @@",
			...LINES.slice(0, 3).map((l) => `-${l}`),
			" unchanged context line",
			...LINES.slice(3).map((l) => `-${l}`),
			"\\ No newline at end of file",
		].join("\n");
		expect(
			findMovedBlocks(
				[file("a.ts", [], [], patch), file("b.ts", [], LINES)],
				3,
			),
		).toEqual([
			{ from: "a.ts", to: "b.ts", lineCount: 3 },
			{ from: "a.ts", to: "b.ts", lineCount: 3 },
		]);
		expect(
			findMovedBlocks([file("a.ts", [], [], patch), file("b.ts", [], LINES)]),
		).toEqual([]);
	});
});

describe("findMovedBlocks at scale", () => {
	it("finds 100 scattered moves among 3000 lines each way in under 500 ms", () => {
		const unique = (tag: string, n: number) =>
			Array.from({ length: n }, (_, i) => `const ${tag}${i} = call(${i});`);
		const deleted = unique("old", 3000);
		const added = unique("new", 3000);
		for (let m = 0; m < 100; m++) {
			const block = unique(`moved${m}x`, 5);
			deleted.splice(m * 29, 5, ...block);
			added.splice(m * 29 + 7, 5, ...block);
		}
		const files = [file("a.ts", deleted, []), file("b.ts", [], added)];
		const start = performance.now();
		const out = findMovedBlocks(files);
		const elapsed = performance.now() - start;
		expect(out).toHaveLength(100);
		expect(elapsed).toBeLessThan(500);
	});
});
