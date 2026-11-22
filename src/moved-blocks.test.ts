import { describe, expect, it } from "vitest";
import {
	collectRuns,
	extractRuns,
	findMovedBlocks,
	normalizeCodeLine,
	type PushFile,
	selectMatches,
} from "./moved-blocks.js";
import { classifyPush } from "./push-shape.js";

describe("selectMatches discovery charge", () => {
	it("stops extending candidates once the charge refuses", () => {
		const block = Array.from(
			{ length: 6 },
			(_, i) => `  const value${i} = compute(${i});`,
		);
		const hunk = (sign: string, at: number) =>
			[
				`@@ -${at},${sign === "-" ? 6 : 0} +${at},${sign === "+" ? 6 : 0} @@`,
				...block.map((l) => `${sign}${l}`),
			].join("\n");
		const patch = [
			...Array.from({ length: 30 }, (_, i) => hunk("-", i * 20 + 1)),
			...Array.from({ length: 30 }, (_, i) => hunk("+", 1000 + i * 20)),
		].join("\n");
		const file: PushFile = {
			filename: "a.ts",
			status: "modified",
			patch,
			additions: 0,
			deletions: 0,
		};
		const { deleted, added } = collectRuns([file]);
		let calls = 0;
		selectMatches(deleted, added, 5, undefined, {
			allowSameFile: true,
			charge: () => ++calls <= 10,
		});
		expect(calls).toBe(11);
		calls = 0;
		selectMatches(deleted, added, 5, undefined, { allowSameFile: true });
		expect(calls).toBe(0);
	});
});

describe("normalizeCodeLine on long lines", () => {
	it("normalizes a 200KB line of spaced tokens in linear time", () => {
		const line = "1 ".repeat(100_000);
		const started = performance.now();
		expect(normalizeCodeLine(line)).toBe(line.trim());
		expect(performance.now() - started).toBeLessThan(3000);
	});
});

describe("extractRuns after lines", () => {
	it("gives a run closed by a later deletion the line that follows", () => {
		const { deleted, added } = extractRuns(
			"a.ts",
			["@@ -1,5 +1,3 @@", "-a", "+b", "-c", " ctx"].join("\n"),
		);
		expect(deleted.map((r) => r.after)).toEqual(["c", "ctx"]);
		expect(added.map((r) => r.after)).toEqual(["ctx"]);
	});
});

describe("normalizeCodeLine with strip", () => {
	const strip = (s: string) => normalizeCodeLine(s, { strip: true });

	it("keeps one space between two word characters", () => {
		expect(strip("hello world")).not.toBe(strip("helloworld"));
		expect(strip("/a b/")).not.toBe(strip("/ab/"));
		expect(strip("/foo bar/")).not.toBe(strip("/foobar/"));
	});

	it("keeps one space between two operator characters", () => {
		expect(strip("const x = a + ++b;")).not.toBe(strip("const x = a++ + b;"));
		expect(strip("x=-1;")).not.toBe(strip("x = -1;"));
	});

	it("still ignores spacing next to punctuation and at the edges", () => {
		expect(strip("const a=1;")).toBe(strip("const a = 1;"));
		expect(strip("  return  1;  ")).toBe(strip("return 1;"));
	});
});

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
		expect(out).toMatchObject([{ from: "a.ts", to: "b.ts", lineCount: 6 }]);
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
		expect(out).toMatchObject([{ from: "a.ts", to: "b.ts", lineCount: 6 }]);
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
		).toMatchObject([{ from: "a.ts", to: "b.ts", lineCount: 5 }]);
	});

	it("matches identical lines with an unmatched apostrophe after re-indenting", () => {
		const del = Array.from(
			{ length: 5 },
			(_, i) => `run${i}(); // don't  skip`,
		);
		const add = del.map((l) => `    ${l}`);
		expect(
			findMovedBlocks([file("a.ts", del, []), file("b.ts", [], add)]),
		).toMatchObject([{ from: "a.ts", to: "b.ts", lineCount: 5 }]);
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
			expect(moved("a.py", "b.py", deeper, deeper)).toMatchObject([
				{ from: "a.py", to: "b.py", lineCount: 5 },
			]);
		});
		it("does not count a YAML block whose indentation changed as a move", () => {
			expect(moved("a.yml", "b.yml", yml, yDeeper)).toEqual([]);
		});
		it("counts a YAML block moved with identical indentation", () => {
			expect(moved("a.yml", "b.yml", yDeeper, yDeeper)).toMatchObject([
				{ from: "a.yml", to: "b.yml", lineCount: 5 },
			]);
		});
		it("never matches between an indentation-sensitive and a free-form file", () => {
			expect(moved("a.py", "b.ts", py, py)).toEqual([]);
		});
		it("does not count an indented closing bracket toward the 3-character minimum", () => {
			const block = [
				"    a = call(",
				"    )",
				"    b = 2",
				"    c = 3",
				"    d = 4",
				"    e = 5",
			];
			expect(moved("a.py", "b.py", block, block)).toMatchObject([
				{ from: "a.py", to: "b.py", lineCount: 5 },
			]);
		});
		it("still counts a re-indented TypeScript block as a move", () => {
			expect(moved("a.ts", "b.ts", py, deeper)).toMatchObject([
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
		).toMatchObject([{ from: "a.ts", to: "b.ts", lineCount: 5 }]);
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
		).toMatchObject([
			{ from: "a.ts", to: "b.ts", lineCount: 3 },
			{ from: "a.ts", to: "b.ts", lineCount: 3 },
		]);
		expect(
			findMovedBlocks([file("a.ts", [], [], patch), file("b.ts", [], LINES)]),
		).toEqual([]);
	});
});

describe("findMovedBlocks span", () => {
	const mixed = Array.from({ length: 20 }, (_, i) => [
		`const value${i} = compute(${i});`,
		i % 2 === 0 ? "" : "}",
	]).flat();

	it("reports the full matched run as spanLines and the meaningful lines as lineCount", () => {
		expect(
			findMovedBlocks([file("a.ts", mixed, []), file("b.ts", [], mixed)]),
		).toEqual([{ from: "a.ts", to: "b.ts", lineCount: 20, spanLines: 40 }]);
	});

	it("does not extend the span beyond the lines that matched", () => {
		const block = LINES.slice(0, 5);
		const out = findMovedBlocks([
			file("a.ts", ["", ...block, ""], []),
			file("b.ts", [], ["", "", ...block, "", ""]),
		]);
		expect(out).toHaveLength(1);
		expect(out[0]?.lineCount).toBe(5);
		expect(out[0]?.spanLines).toBeLessThanOrEqual(7);
		expect(out[0]?.spanLines).toBeGreaterThanOrEqual(5);
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
		expect(out).toMatchObject([{ from: "a.ts", to: "b.ts", lineCount: 2000 }]);
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
		expect(elapsed).toBeLessThan(3000);
	});
});

describe("same-file pairing across change regions", () => {
	const SPLIT = [
		"@@ -1,20 +1,20 @@",
		...LINES.map((l) => `-${l}`),
		" context one",
		" context two",
		" context three",
		...LINES.map((l) => `+${l}`),
	].join("\n");
	const SAME_REGION = [
		"@@ -1,20 +1,20 @@",
		...LINES.map((l) => `-${l}`),
		...LINES.map((l) => `+${l}`),
	].join("\n");

	function pair(patch: string, allowSameFile: boolean) {
		const { deleted, added } = collectRuns([file("a.ts", [], [], patch)]);
		return selectMatches(deleted, added, 5, undefined, { allowSameFile });
	}

	it("pairs a deleted and an added block in different regions of one file when allowSameFile is set", () => {
		const matches = pair(SPLIT, true);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.counted).toBe(6);
		expect(pair(SPLIT, false)).toEqual([]);
	});

	it("does not pair runs of one change region", () => {
		expect(pair(SAME_REGION, true)).toEqual([]);
	});

	it("keeps findMovedBlocks cross-file only", () => {
		expect(findMovedBlocks([file("a.ts", [], [], SPLIT)])).toEqual([]);
	});
});

describe("hunk header as a region boundary", () => {
	it("separates a deleted run from an added run when a second hunk header has no context line before it", () => {
		const patch = [
			"@@ -1,5 +1,0 @@",
			...LINES.map((l) => `-${l}`),
			"@@ -40,0 +30,5 @@",
			...LINES.map((l) => `+${l}`),
		].join("\n");
		const { deleted, added } = collectRuns([file("a.ts", [], [], patch)]);
		const matches = selectMatches(deleted, added, 5, undefined, {
			allowSameFile: true,
		});
		expect(matches).toHaveLength(1);
		expect(deleted[0]?.region).not.toBe(added[0]?.region);
	});
});

describe("indentation outside the diff model's strict rule", () => {
	const nested = LINES.map((l) => `    ${l}`);

	it.each([
		"rb",
		"sh",
		"scala",
	])("still collapses leading indentation for .%s in findMovedBlocks", (ext) => {
		const out = findMovedBlocks([
			file(`a.${ext}`, nested, []),
			file(`b.${ext}`, [], LINES),
		]);
		expect(out).toMatchObject([{ from: `a.${ext}`, lineCount: 6 }]);
		expect(out).toHaveLength(1);
	});

	it.each([
		"rb",
		"sh",
		"scala",
	])("still counts a dedented .%s block as moved in the push shape", (ext) => {
		const shape = classifyPush([
			file(`a.${ext}`, nested, []),
			file(`b.${ext}`, [], LINES),
		]);
		expect(shape.moved).toHaveLength(1);
	});

	it("keeps Run.indentSensitive for the old rule when a caller widens what keeps indentation", () => {
		const patch = file("a.rb", nested, []).patch;
		const strict = collectRuns([file("a.rb", nested, [], patch)], () => true);
		expect(strict.deleted[0]?.indentSensitive).toBe(false);
		expect(strict.deleted[0]?.lines[0]).toBe(nested[0]);
		const shared = collectRuns([file("a.rb", nested, [], patch)]);
		expect(shared.deleted[0]?.lines[0]).toBe(LINES[0]);
	});
});
