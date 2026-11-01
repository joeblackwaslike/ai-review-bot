import { describe, expect, it } from "vitest";
import {
	collectRightSideLines,
	numberPatchLines,
	rightSideText,
} from "./diff-lines.js";
import {
	DEFAULT_DIFF_BUDGET_CHARS,
	packDiff,
	widenHunks,
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

const packedChars = (files: ReturnType<typeof packDiff>["files"]) =>
	files.reduce(
		(n, f) => n + (f.patch ? numberPatchLines(f.patch).length : 0),
		0,
	);

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
});

describe("packDiff budget", () => {
	const many = Array.from({ length: 12 }, (_, i) =>
		file(
			`f${i}.ts`,
			[added(1, 3 + i * 7, `a${i}`), added(200, 2 + i, `b${i}`)].join("\n"),
		),
	);

	it.each([
		1, 50, 300, 1000, 4000, 20_000,
	])("never exceeds a budget of %i numbered characters", (budgetChars) => {
		const { files } = packDiff(many, { budgetChars });
		expect(packedChars(files)).toBeLessThanOrEqual(budgetChars);
	});

	it("names every file that is neither packed in full nor truncated", () => {
		const first = numberPatchLines(added(1, 10, "big")).length;
		const midFirstHunk = numberPatchLines(added(1, 4, "m")).length;
		const { files, omitted } = packDiff(
			[
				file("big.ts", added(1, 10, "big")),
				file("mid.ts", [added(1, 4, "m"), added(50, 4, "n")].join("\n")),
				file("small.ts", added(1, 3, "s")),
				file("tiny.ts", added(1, 2, "t")),
			],
			{
				budgetChars: first + midFirstHunk + "\n\n[patch truncated]".length,
			},
		);
		const shown = files.map((f) => f.filename);
		expect([...shown, ...omitted].sort()).toEqual(
			["big.ts", "mid.ts", "small.ts", "tiny.ts"].sort(),
		);
		expect(shown).toEqual(["big.ts", "mid.ts"]);
		expect(omitted).toEqual(["small.ts", "tiny.ts"]);
		expect(files.find((f) => f.filename === "big.ts")?.truncated).toBe(false);
		const mid = files.find((f) => f.filename === "mid.ts");
		expect(mid?.truncated).toBe(true);
		expect(mid?.patch).toContain("@@ -1,0 +1,4 @@");
		expect(mid?.patch).not.toContain("@@ -50,0 +50,4 @@");
		expect(mid?.patch?.endsWith("[patch truncated]")).toBe(true);
	});

	it("cuts mid-hunk with a marker when the first hunk alone is over the budget, keeping right-side numbers", () => {
		const full = [
			"@@ -10,3 +40,30 @@",
			" ctx",
			...Array.from({ length: 29 }, (_, i) => `+row${i}`),
		].join("\n");
		const { files, omitted } = packDiff([file("a.ts", full)], {
			budgetChars: 200,
		});
		expect(omitted).toEqual([]);
		const [packed] = files;
		expect(packed.truncated).toBe(true);
		expect(packed.patch?.endsWith("[patch truncated]")).toBe(true);
		const fullText = rightSideText(full);
		const shown = rightSideText(packed.patch ?? "");
		expect(shown.size).toBeGreaterThan(0);
		expect(shown.size).toBeLessThan(fullText.size);
		for (const [line, text] of shown) expect(fullText.get(line)).toBe(text);
		expect(numberPatchLines(packed.patch ?? "").length).toBeLessThanOrEqual(
			200,
		);
	});

	it("lists a file whose first line does not fit as omitted, not as an empty truncation", () => {
		const { files, omitted } = packDiff(
			[
				file("a.ts", added(1, 1)),
				file("b.ts", `@@ -1 +1 @@\n+${"x".repeat(500)}`),
			],
			{ budgetChars: numberPatchLines(added(1, 1)).length + 30 },
		);
		expect(files.map((f) => f.filename)).toEqual(["a.ts"]);
		expect(omitted).toEqual(["b.ts"]);
	});

	it("keeps files with no patch, which cost nothing, even past the cut", () => {
		const { files, omitted } = packDiff(
			[
				file("a.ts", added(1, 40)),
				file("b.ts", added(1, 40)),
				file("logo.png"),
			],
			{ budgetChars: 300 },
		);
		expect(files.map((f) => f.filename)).toContain("logo.png");
		expect(omitted).toEqual(["b.ts"]);
	});
});

describe("packDiff deletion-only hunks", () => {
	const deletion = "@@ -5,2 +4,0 @@\n-gone1\n-gone2";

	it("drops a hunk with no added lines and keeps the other hunks' headers", () => {
		const keep = "@@ -20,1 +18,2 @@\n ctx\n+new";
		const full = `${deletion}\n${keep}`;
		const [packed] = packDiff([file("a.ts", full)], {
			budgetChars: DEFAULT_DIFF_BUDGET_CHARS,
		}).files;
		expect(packed.patch).toBe(keep);
		expect(packed.truncated).toBe(false);
		expect(rightSideText(packed.patch ?? "")).toEqual(rightSideText(keep));
	});

	it("marks a file left with no hunks as deletions only instead of dropping it", () => {
		const { files, omitted } = packDiff([file("a.ts", deletion)], {
			budgetChars: DEFAULT_DIFF_BUDGET_CHARS,
		});
		expect(omitted).toEqual([]);
		expect(files).toEqual([
			{
				filename: "a.ts",
				status: "modified",
				patch: undefined,
				truncated: false,
				deletionsOnly: true,
			},
		]);
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

describe("widenHunks", () => {
	const text = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);
	text[2] = "function outer() {";
	const fileText = text.join("\n");

	it("adds context to reach 5 lines before the first change and up to the enclosing function", () => {
		const patch = "@@ -11,2 +11,3 @@\n L11\n+new\n L12";
		const widened = widenHunks(patch, fileText);
		const lines = rightSideText(widened);
		expect(lines.get(3)).toBe("function outer() {");
		expect(lines.get(10)).toBe("L10");
		expect(widened.split("\n")[0]).toBe("@@ -3,10 +3,11 @@");
		expect(lines.get(12)).toBe("new");
	});

	it("stops at the previous hunk and adds one line after when the hunk has none", () => {
		const patch = "@@ -1,1 +1,2 @@\n L1\n+a\n@@ -7,0 +9,1 @@\n+b";
		const widened = widenHunks(patch, fileText);
		const headers = widened.split("\n").filter((l) => l.startsWith("@@"));
		expect(headers).toEqual(["@@ -1,2 +1,3 @@", "@@ -3,6 +4,7 @@"]);
		expect(rightSideText(widened).get(10)).toBe("L10");
	});

	it("packDiff widens only the files whose text is given", () => {
		const patch = "@@ -11,1 +11,1 @@\n+changed";
		const { files } = packDiff([file("a.ts", patch), file("b.ts", patch)], {
			budgetChars: DEFAULT_DIFF_BUDGET_CHARS,
			fileText: new Map([["a.ts", fileText]]),
		});
		const a = files.find((f) => f.filename === "a.ts");
		const b = files.find((f) => f.filename === "b.ts");
		expect(collectRightSideLines(a?.patch ?? "").has(3)).toBe(true);
		expect(b?.patch).toBe(patch);
	});
});
