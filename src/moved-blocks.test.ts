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

	it("does not treat a changed string literal as a move", () => {
		const del = Array.from({ length: 5 }, (_, i) => `log${i}("a  b");`);
		const add = Array.from({ length: 5 }, (_, i) => `log${i}("a b");`);
		expect(
			findMovedBlocks([file("a.ts", del, []), file("b.ts", [], add)]),
		).toEqual([]);
	});

	it("still matches re-indented statements that contain literals", () => {
		const del = Array.from({ length: 5 }, (_, i) => `log${i}("a  b");`);
		const add = del.map((l) => `\t\t${l}  `);
		expect(
			findMovedBlocks([file("a.ts", del, []), file("b.ts", [], add)]),
		).toEqual([{ from: "a.ts", to: "b.ts", lineCount: 5 }]);
	});

	it("matches identical lines with an unmatched apostrophe after re-indenting", () => {
		const del = Array.from(
			{ length: 5 },
			(_, i) => `run${i}(); // don't  skip`,
		);
		const add = del.map((l) => `    ${l}`);
		expect(
			findMovedBlocks([file("a.ts", del, []), file("b.ts", [], add)]),
		).toEqual([{ from: "a.ts", to: "b.ts", lineCount: 5 }]);
	});

	describe("indentation-sensitive files", () => {
		const py = ["if ready:", "x = 1", "y = 2", "z = 3", "w = 4"];
		const deeper = py.map((l) => `    ${l}`);
		const yml = ["key:", "a: 1", "b: 2", "c: 3", "d: 4"];
		const yDeeper = yml.map((l) => `    ${l}`);
		const moved = (from: string, to: string, d: string[], a: string[]) =>
			findMovedBlocks([file(from, d, []), file(to, [], a)]);

		it("does not count a Python block whose indentation changed as a move", () => {
			expect(moved("a.py", "b.py", py, deeper)).toEqual([]);
		});
		it("counts a Python block moved with identical indentation", () => {
			expect(moved("a.py", "b.py", deeper, deeper)).toEqual([
				{ from: "a.py", to: "b.py", lineCount: 5 },
			]);
		});
		it("does not count a YAML block whose indentation changed as a move", () => {
			expect(moved("a.yml", "b.yml", yml, yDeeper)).toEqual([]);
		});
		it("counts a YAML block moved with identical indentation", () => {
			expect(moved("a.yml", "b.yml", yDeeper, yDeeper)).toEqual([
				{ from: "a.yml", to: "b.yml", lineCount: 5 },
			]);
		});
		it("never matches between an indentation-sensitive and a free-form file", () => {
			expect(moved("a.py", "b.ts", py, py)).toEqual([]);
		});
		it("still counts a re-indented TypeScript block as a move", () => {
			expect(moved("a.ts", "b.ts", py, deeper)).toEqual([
				{ from: "a.ts", to: "b.ts", lineCount: 5 },
			]);
		});
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

	it("handles 2000 identical lines moved as one block in under 500 ms", () => {
		const same = Array.from({ length: 2000 }, () => "const same = repeat();");
		const files = [file("a.ts", same, []), file("b.ts", [], same)];
		const start = performance.now();
		const out = findMovedBlocks(files);
		const elapsed = performance.now() - start;
		expect(out).toEqual([{ from: "a.ts", to: "b.ts", lineCount: 2000 }]);
		expect(elapsed).toBeLessThan(500);
	});

	it("keeps distinct moves visible among 3000 repeated lines per file", () => {
		const repeated = () =>
			Array.from({ length: 3000 }, () => "const same = repeat();");
		const deleted = repeated();
		const added = repeated();
		for (let m = 0; m < 100; m++) {
			const block = Array.from(
				{ length: 5 },
				(_, i) => `const moved${m}x${i} = call(${i});`,
			);
			deleted.splice(
				m * 29,
				0,
				`const del${m}a = 0;`,
				...block,
				`const del${m}b = 0;`,
			);
			added.splice(
				m * 31 + 7,
				0,
				`const add${m}a = 0;`,
				...block,
				`const add${m}b = 0;`,
			);
		}
		const files = [file("a.ts", deleted, []), file("b.ts", [], added)];
		const start = performance.now();
		const out = findMovedBlocks(files);
		const elapsed = performance.now() - start;
		expect(out.filter((b) => b.lineCount === 5)).toHaveLength(100);
		expect(elapsed).toBeLessThan(1000);
	});
});
