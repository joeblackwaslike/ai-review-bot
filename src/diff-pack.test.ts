import { describe, expect, it } from "vitest";
import {
	collectRightSideLines,
	numberPatchLines,
	rightSideText,
} from "./diff-lines.js";
import {
	DEFAULT_DIFF_BUDGET_CHARS,
	formatPackedDiff,
	isDeletionOnlyPatch,
	packDiff,
} from "./diff-pack.js";

const added = (start: number, count: number, tag = "line") =>
	[
		`@@ -${start},0 +${start},${count} @@`,
		...Array.from({ length: count }, (_, i) => `+${tag}${start + i}`),
	].join("\n");

const file = (filename: string, patch?: string) => ({
	filename,
	status: "modified",
	patch,
});

const SEP = "\n\n---\n\n";
const TRUNCATED_LABEL =
	"PATCH (truncated at the diff budget, later hunks not shown):";
const block = (name: string, patch: string) =>
	`FILE: ${name}\nSTATUS: modified\nPATCH:\n${numberPatchLines(patch)}`;
const truncatedBlock = (name: string, kept: string) =>
	`FILE: ${name}\nSTATUS: modified\n${TRUNCATED_LABEL}\n${numberPatchLines(kept)}\n\n[patch truncated]`;
const serialized = (
	files: Parameters<typeof packDiff>[0],
	budgetChars: number,
) => formatPackedDiff(packDiff(files, { budgetChars }));

describe("packDiff ordering", () => {
	it("puts the main language first, larger patches first within a language, generated files last", () => {
		const { files } = packDiff(
			[
				file("pnpm-lock.yaml", added(1, 50)),
				file("a.ts", added(1, 2)),
				file("docs/d.md", added(1, 5)),
				file("b.ts", added(1, 10)),
				file("x.py", added(1, 20)),
			],
			{ budgetChars: DEFAULT_DIFF_BUDGET_CHARS },
		);
		expect(files.map((f) => f.filename)).toEqual([
			"x.py",
			"b.ts",
			"a.ts",
			"docs/d.md",
			"pnpm-lock.yaml",
		]);
	});

	it("serializes the same files identically whatever order they arrive in", () => {
		const files = [
			file("b.ts", added(1, 3, "b")),
			file("a.ts", added(1, 3, "a")),
			file("Z.ts", added(1, 3, "z")),
			file("logo.png"),
			file("c.py", added(1, 9, "c")),
			file("yarn.lock", added(1, 4, "y")),
		];
		const reference = serialized(files, 400);
		for (const order of [
			[...files].reverse(),
			[...files.slice(2), ...files.slice(0, 2)],
			[files[3], files[5], files[0], files[4], files[2], files[1]],
		])
			expect(serialized(order, 400)).toBe(reference);
	});
});

describe("packDiff budget", () => {
	const many = Array.from({ length: 12 }, (_, i) =>
		file(
			`f${i}.ts`,
			[added(1, 3 + i * 7, `a${i}`), added(200, 2 + i, `b${i}`)].join("\n"),
		),
	);

	it.each([
		200, 300, 1000, 4000, 20_000,
	])("keeps the whole serialized diff section within a budget of %i characters", (budgetChars) => {
		expect(serialized(many, budgetChars).length).toBeLessThanOrEqual(
			budgetChars,
		);
	});

	it.each([
		5000, 20_000, 100_000,
	])("keeps a PR of many patchless files within %i characters and names every file", (budgetChars) => {
		const files = [
			file("src/a.ts", added(1, 5)),
			...Array.from({ length: 300 }, (_, i) => file(`img/p${i}.png`)),
		];
		const packed = packDiff(files, { budgetChars });
		expect(formatPackedDiff(packed).length).toBeLessThanOrEqual(budgetChars);
		expect(
			[...packed.files.map((f) => f.filename), ...packed.omitted].sort(),
		).toEqual(files.map((f) => f.filename).sort());
	});

	it("names every file and shows none when the budget cannot hold the omitted list", () => {
		const packed = packDiff(many, { budgetChars: 1 });
		expect(packed.files).toEqual([]);
		expect(packed.omitted).toHaveLength(12);
		expect(formatPackedDiff(packed)).toMatch(
			/^Files not shown \(over the diff budget\): /,
		);
	});

	it("counts file framing and the omitted line: the cut file is truncated at a hunk boundary and the rest are named", () => {
		const big = added(1, 40, "big");
		const mid = [added(1, 4, "m"), added(50, 20, "n")].join("\n");
		const expected = [
			"Files not shown (over the diff budget): small.ts, tiny.ts\n\n",
			block("big.ts", big),
			SEP,
			truncatedBlock("mid.ts", added(1, 4, "m")),
		].join("");
		const packed = packDiff(
			[
				file("big.ts", big),
				file("mid.ts", mid),
				file("small.ts", added(1, 3, "s")),
				file("tiny.ts", added(1, 2, "t")),
			],
			{ budgetChars: expected.length },
		);
		expect(packed.omitted).toEqual(["small.ts", "tiny.ts"]);
		expect(packed.files.map((f) => [f.filename, f.truncated])).toEqual([
			["big.ts", false],
			["mid.ts", true],
		]);
		expect(formatPackedDiff(packed)).toBe(expected);
	});

	it("cuts mid-hunk with a marker when the first hunk alone is over the budget, keeping right-side numbers", () => {
		const full = [
			"@@ -10,3 +40,30 @@",
			" ctx",
			...Array.from({ length: 29 }, (_, i) => `+row${i}`),
		].join("\n");
		const packed = packDiff([file("a.ts", full)], { budgetChars: 300 });
		expect(packed.omitted).toEqual([]);
		const [cut] = packed.files;
		expect(cut.truncated).toBe(true);
		expect(cut.patch?.endsWith("[patch truncated]")).toBe(true);
		const fullText = rightSideText(full);
		const shown = rightSideText(cut.patch ?? "");
		expect(shown.size).toBeGreaterThan(0);
		expect(shown.size).toBeLessThan(fullText.size);
		for (const [line, text] of shown) expect(fullText.get(line)).toBe(text);
		expect(formatPackedDiff(packed).length).toBeLessThanOrEqual(300);
	});

	it("never cuts at a boundary whose prefix has no right-side line", () => {
		const patch = ["-stray preamble", added(1, 30, "r")].join("\n");
		const [cut] = packDiff([file("a.ts", patch)], { budgetChars: 220 }).files;
		expect(cut.truncated).toBe(true);
		expect(collectRightSideLines(cut.patch ?? "").size).toBeGreaterThan(0);
	});

	it("omits a file of which nothing fits, then truncates a later one and omits the rest", () => {
		const packed = packDiff(
			[
				file("huge.ts", `@@ -1 +1 @@\n+${"x".repeat(2000)}`),
				file("a.ts", added(1, 80, "a")),
				file("b.ts", added(1, 2, "b")),
			],
			{ budgetChars: 600 },
		);
		expect(packed.files.map((f) => [f.filename, f.truncated])).toEqual([
			["a.ts", true],
		]);
		expect(packed.omitted).toEqual(["huge.ts", "b.ts"]);
		expect(formatPackedDiff(packed).length).toBeLessThanOrEqual(600);
	});

	it("charges patchless files their framing and omits them after the cut", () => {
		const { files, omitted } = packDiff(
			[
				file("a.ts", added(1, 40)),
				file("b.ts", added(1, 40)),
				file("logo.png"),
			],
			{ budgetChars: 400 },
		);
		expect(files.map((f) => f.filename)).toEqual(["a.ts"]);
		expect(omitted).toEqual(["b.ts", "logo.png"]);
	});

	it("keeps a \\ No newline line with its hunk when cutting at the boundary after it", () => {
		const first =
			"@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file";
		const patch = [first, added(10, 40, "z")].join("\n");
		const budget = truncatedBlock("a.ts", first).length;
		const [cut] = packDiff([file("a.ts", patch)], {
			budgetChars: budget,
		}).files;
		expect(cut.patch).toBe(`${first}\n\n[patch truncated]`);
	});
});

describe("packDiff deletion-only hunks", () => {
	const deletion =
		"@@ -5,2 +4,0 @@\n-gone1\n-gone2\n\\ No newline at end of file";
	const keep = "@@ -20,1 +18,2 @@\n ctx\n+new";

	it("drops a hunk with no added lines, with its \\ No newline line, and keeps the other hunks' headers", () => {
		const [packed] = packDiff([file("a.ts", `${keep}\n${deletion}`)], {
			budgetChars: DEFAULT_DIFF_BUDGET_CHARS,
		}).files;
		expect(packed.patch).toBe(keep);
		expect(packed.droppedDeletionHunks).toBe(1);
		expect(rightSideText(packed.patch ?? "")).toEqual(rightSideText(keep));
	});

	it("notes dropped deletion-only hunks under the file header and counts the note in the budget", () => {
		const files = [file("a.ts", `${deletion}\n${keep}\n${deletion}`)];
		const full = serialized(files, DEFAULT_DIFF_BUDGET_CHARS);
		expect(full).toBe(
			`FILE: a.ts\nSTATUS: modified\n(2 deletion-only hunks not shown)\nPATCH:\n${numberPatchLines(keep)}`,
		);
		expect(
			packDiff(files, { budgetChars: full.length }).files[0].truncated,
		).toBe(false);
		const short = packDiff(files, { budgetChars: full.length - 1 });
		expect(short.files[0]?.truncated ?? true).toBe(true);
	});

	it("marks a file left with no hunks as deletions only instead of dropping it", () => {
		const packed = packDiff([file("a.ts", deletion)], {
			budgetChars: DEFAULT_DIFF_BUDGET_CHARS,
		});
		expect(packed.omitted).toEqual([]);
		expect(packed.files).toEqual([
			{
				filename: "a.ts",
				status: "modified",
				patch: undefined,
				truncated: false,
				deletionsOnly: true,
				droppedDeletionHunks: 1,
			},
		]);
		expect(formatPackedDiff(packed)).toBe(
			"FILE: a.ts\nSTATUS: modified\nPATCH: [deletions only]",
		);
	});

	it("isDeletionOnlyPatch is true only for a patch whose every hunk only deletes", () => {
		expect(isDeletionOnlyPatch(deletion)).toBe(true);
		expect(isDeletionOnlyPatch(`${deletion}\n${keep}`)).toBe(false);
		expect(isDeletionOnlyPatch(undefined)).toBe(false);
	});
});

describe("packDiff and anchor validation", () => {
	it("does not change the valid-line set computed from the full patch", () => {
		const full = [added(1, 30, "a"), added(100, 30, "b")].join("\n");
		const before = collectRightSideLines(full);
		const files = [file("a.ts", full)];
		const { files: packed } = packDiff(files, { budgetChars: 300 });
		expect(packed[0].truncated).toBe(true);
		expect(files[0].patch).toBe(full);
		expect(collectRightSideLines(files[0].patch ?? "")).toEqual(before);
	});
});
