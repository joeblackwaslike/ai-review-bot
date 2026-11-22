import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { continuesString } from "./block-build.js";
import { INDENT_COLLAPSIBLE_FILE } from "./file-kinds.js";
import { buildDiffModel } from "./index.js";
import { findMechanical } from "./operations.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation, WHITESPACE_FREE } from "./relocation-check.js";
import type { Divergence, Operation } from "./types.js";

function pushFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function moveFiles(
	base: string[],
	head: string[],
	names: [string, string] = ["src/a.ts", "src/b.ts"],
): PushFile[] {
	return [
		pushFile(
			names[0],
			[`@@ -10,${base.length} +9,0 @@`, ...base.map((l) => `-${l}`)].join("\n"),
		),
		pushFile(
			names[1],
			[`@@ -0,0 +3,${head.length} @@`, ...head.map((l) => `+${l}`)].join("\n"),
		),
	];
}

function body(count: number, indent = "  "): string[] {
	return Array.from(
		{ length: count },
		(_, i) => `${indent}const v${i} = compute(${i}) + offset;`,
	);
}

function classes(ops: Operation[]): string[] {
	return ops.flatMap((op) => op.divergences.map((d) => d.class));
}

function forged(
	op: Operation,
	cls: Divergence["class"],
	reviewWeight: number,
): Operation {
	return {
		...op,
		reviewWeight,
		divergences: op.divergences.map((d) => ({ ...d, class: cls })),
	};
}

describe("comment-only and rename never apply inside a literal", () => {
	const template = (word: string) => [
		"export function banner() {",
		...body(6),
		"  const text = `",
		`    // banner: ${word} world here`,
		"  `;",
		...body(6),
		"}",
	];
	const triple = (word: string) => [
		"def banner():",
		...body(6, "    "),
		"    query = '''",
		`    # ${word} from users`,
		"    '''",
		...body(6, "    "),
	];

	it("keeps a changed line that looks like a comment inside a template literal as code", () => {
		const files = moveFiles(template("hello"), template("goodbye"));
		const ops = findRelocations(files);
		expect(classes(ops)).toEqual(["code"]);
		expect(ops[0]?.reviewWeight).toBe(1);
	});

	it("keeps a changed line that looks like a comment inside a triple-quoted string as code", () => {
		const files = moveFiles(triple("select"), triple("drop"), [
			"src/a.py",
			"src/b.py",
		]);
		const ops = findRelocations(files);
		expect(classes(ops)).toEqual(["code"]);
	});

	it("still classes a real comment above the literal as comment-only", () => {
		const base = template("hello");
		base.splice(1, 0, "  // greet the user");
		const head = base.map((l) => l.replace("greet the", "welcome the"));
		const ops = findRelocations(moveFiles(base, head));
		expect(classes(ops)).toEqual(["comment-only"]);
	});

	it("does not call a rename inside a literal a rename", () => {
		const text = (name: string) => [
			"export function banner() {",
			...body(6),
			"  const text = `",
			`    ${name} ${name}`,
			"  `;",
			...body(6),
			"}",
		];
		const ops = findRelocations(moveFiles(text("alpha"), text("first")));
		expect(classes(ops)).toEqual(["code"]);
	});

	it("rejects a comment-only class forged on a line inside a template literal", () => {
		const files = moveFiles(template("hello"), template("goodbye"));
		const [op] = findRelocations(files) as [Operation];
		expect(verifyRelocation(op, files)).toBe(true);
		expect(verifyRelocation(forged(op, "comment-only", 0), files)).toBe(false);
	});

	it("rejects a comment-only class forged on a line inside a triple-quoted string", () => {
		const files = moveFiles(triple("select"), triple("drop"), [
			"src/a.py",
			"src/b.py",
		]);
		const [op] = findRelocations(files) as [Operation];
		expect(verifyRelocation(forged(op, "comment-only", 0), files)).toBe(false);
	});

	it("rejects a rename class forged on lines inside a template literal", () => {
		const text = (name: string) => [
			"export function banner() {",
			...body(6),
			"  const text = `",
			`    ${name} ${name}`,
			"  `;",
			...body(6),
			"}",
		];
		const files = moveFiles(text("alpha"), text("first"));
		const [op] = findRelocations(files) as [Operation];
		expect(verifyRelocation(forged(op, "rename", 1), files)).toBe(false);
	});
});

describe("leading indentation is compared in languages that may give it meaning", () => {
	const nested = [
		"  if cond:",
		"    publish(ctx, sources, options)",
		"    flush(ctx, sources, options)",
		"    close(ctx, sources, options)",
		"    finish(ctx, sources, options)",
		"    report(ctx, sources, options)",
	];
	const dedented = nested.map((l) => l.slice(2));

	it.each([
		"bzl",
		"scala",
		"fs",
		"coffee",
		"pyw",
		"sass",
		"rb",
		"sh",
	])("does not claim an exact move of a dedented .%s block", (ext) => {
		const files = moveFiles(nested, dedented, [`src/a.${ext}`, `src/b.${ext}`]);
		expect(findRelocations(files).filter((op) => op.exact)).toEqual([]);
	});

	it.each([
		"bzl",
		"scala",
		"rb",
		"sh",
	])("rejects an exact claim forged over a dedented .%s block", (ext) => {
		const files = moveFiles(nested, dedented, [`src/a.${ext}`, `src/b.${ext}`]);
		const claim: Operation = {
			id: "relocation-1",
			type: "relocation",
			from: [
				{
					filename: `src/a.${ext}`,
					side: "base",
					startLine: 10,
					endLine: 15,
					shown: "full",
				},
			],
			to: [
				{
					filename: `src/b.${ext}`,
					side: "head",
					startLine: 3,
					endLine: 8,
					shown: "full",
				},
			],
			exact: true,
			divergences: [],
			reviewWeight: 0,
		};
		expect(verifyRelocation(claim, files)).toBe(false);
	});

	it("lists a re-indented line inside a Ruby block as a divergence and not as identical", () => {
		const base = [
			"def publish(ctx)",
			...body(10),
			"  ship(ctx)",
			...body(10),
			"end",
		];
		const head = base.map((l) => (l === "  ship(ctx)" ? "    ship(ctx)" : l));
		const ops = findRelocations(
			moveFiles(base, head, ["src/a.rb", "src/b.rb"]),
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(false);
		expect(classes(ops)).toEqual(["code"]);
	});

	it("treats the same re-indented line inside a TypeScript block as identical", () => {
		const base = [
			"function publish(ctx) {",
			...body(10),
			"  ship(ctx);",
			...body(10),
			"}",
		];
		const head = base.map((l) => (l === "  ship(ctx);" ? "    ship(ctx);" : l));
		const ops = findRelocations(moveFiles(base, head));
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(true);
	});

	it.each([
		"ts",
		"java",
		"go",
		"c",
		"rs",
	])("still claims a dedented .%s block as exact", (ext) => {
		const files = moveFiles(nested, dedented, [`src/a.${ext}`, `src/b.${ext}`]);
		const ops = findRelocations(files);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(true);
		expect(verifyRelocation(ops[0] as Operation, files)).toBe(true);
	});
});

describe("verifyRelocation positional accounting", () => {
	const lines = [
		"const alpha = loadAlpha(config);",
		"const beta = loadBeta(config);",
		"const gamma = loadGamma(config);",
		"const delta = loadDelta(config);",
		"const epsilon = loadEpsilon(config);",
	];

	function claim(headLines: string[], baseAt: number, headAt: number) {
		const files = moveFiles(lines, headLines);
		const op: Operation = {
			id: "relocation-1",
			type: "relocation",
			from: [
				{
					filename: "src/a.ts",
					side: "base",
					startLine: 10,
					endLine: 14,
					shown: "full",
				},
			],
			to: [
				{
					filename: "src/b.ts",
					side: "head",
					startLine: 3,
					endLine: 7,
					shown: "full",
				},
			],
			exact: false,
			divergences: [
				{
					kind: "changed",
					class: "code",
					base: {
						filename: "src/a.ts",
						side: "base",
						startLine: 10 + baseAt,
						endLine: 10 + baseAt,
						shown: "full",
					},
					head: {
						filename: "src/b.ts",
						side: "head",
						startLine: 3 + headAt,
						endLine: 3 + headAt,
						shown: "full",
					},
					original: (lines[baseAt] as string).trim(),
				},
			],
			reviewWeight: 1,
		};
		return { files, op };
	}

	it("accepts a changed pair that stays in its place", () => {
		const head = lines.map((l, i) => (i === 3 ? "const delta = evil();" : l));
		const { files, op } = claim(head, 3, 3);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("rejects a changed pair that crosses the unchanged lines between its two positions", () => {
		const head = [
			lines[1] as string,
			lines[2] as string,
			lines[3] as string,
			"const alpha = evil();",
			lines[4] as string,
		];
		const { files, op } = claim(head, 0, 3);
		expect(verifyRelocation(op, files)).toBe(false);
	});
});

describe("verifyRelocation claim shape", () => {
	const block = ["export function applyDiscount(input) {", ...body(20), "}"];

	it("drops a divergence of an unknown kind", () => {
		const head = [...block];
		head.splice(10, 0, "  audit(input);");
		const files = moveFiles(block, head);
		const [op] = findRelocations(files) as [Operation];
		expect(op.divergences.map((d) => d.kind)).toEqual(["inserted"]);
		const odd = {
			...op,
			divergences: op.divergences.map((d) => ({ ...d, kind: "moved" })),
		} as unknown as Operation;
		expect(verifyRelocation(odd, files)).toBe(false);
	});

	it("drops a relocation whose source is on the head side", () => {
		const files = [
			pushFile(
				"src/a.ts",
				[`@@ -0,0 +3,${block.length} @@`, ...block.map((l) => `+${l}`)].join(
					"\n",
				),
			),
			pushFile(
				"src/b.ts",
				[`@@ -0,0 +3,${block.length} @@`, ...block.map((l) => `+${l}`)].join(
					"\n",
				),
			),
		];
		const claim: Operation = {
			id: "relocation-1",
			type: "relocation",
			from: [
				{
					filename: "src/a.ts",
					side: "head",
					startLine: 3,
					endLine: 3 + block.length - 1,
					shown: "full",
				},
			],
			to: [
				{
					filename: "src/b.ts",
					side: "head",
					startLine: 3,
					endLine: 3 + block.length - 1,
					shown: "full",
				},
			],
			exact: true,
			divergences: [],
			reviewWeight: 0,
		};
		expect(verifyRelocation(claim, files)).toBe(false);
	});
});

describe("the checker stays linear on repeated openers", () => {
	it("verifies 20,000 three-line blocks that share a first line", () => {
		const total = 20_000;
		const base: string[] = [];
		const head: string[] = [];
		for (let i = 0; i < total; i++) {
			base.push("if (ready) {", `  run${i}(payload, ${i});`, "}");
			head.push("if (ready) {", `  run${i}(payload, ${i});`, "}");
		}
		const files = [
			pushFile(
				"src/a.ts",
				[`@@ -1,${base.length} +0,0 @@`, ...base.map((l) => `-${l}`)].join(
					"\n",
				),
			),
			pushFile(
				"src/b.ts",
				[`@@ -0,0 +1,${head.length} @@`, ...head.map((l) => `+${l}`)].join(
					"\n",
				),
			),
		];
		const started = performance.now();
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "",
			body: null,
		});
		expect(performance.now() - started).toBeLessThan(5000);
		expect(model.droppedClaims).toBe(0);
		expect(model.operations.some((op) => op.type === "relocation")).toBe(true);
	});
});

describe("multi-line strings hide comment and rename lines", () => {
	const around = (
		inner: string[],
		before: string[] = [],
		after: string[] = [],
	) => [
		"export function banner() {",
		...body(6),
		...before,
		...inner,
		...after,
		...body(6),
		"}",
	];
	const cases: [string, (word: string) => string[]][] = [
		[
			"a quoted backtick before and after a template",
			(w) =>
				around(
					["  const t = `", `    // banner: ${w} world here`, "  `;"],
					['  const a = "`";'],
					['  const b = "`";'],
				),
		],
		[
			"a regex with a backtick",
			(w) =>
				around(
					["  const t = `", `    // banner: ${w} world here`, "  `;"],
					["  const r = /`/;"],
				),
		],
		[
			"a comment with a backtick",
			(w) =>
				around(
					["  const t = `", `    // banner: ${w} world here`, "  `;"],
					["  // use ` carefully"],
				),
		],
		[
			"an opener and a closer that hold quoted backticks",
			(w) =>
				around([
					'  const s = "`" + `',
					`    // banner: ${w} world here`,
					'  `; const q = "`";',
				]),
		],
		[
			"a double-quoted string continued by a backslash",
			(w) =>
				around([
					'  const text = "first line \\',
					`    // banner: ${w} world here \\`,
					'    end";',
				]),
		],
		[
			"a one-line template beside a quoted string",
			(w) => around(['  const t = `a` + "b";', `  // banner: ${w} world here`]),
		],
		[
			"two one-line templates",
			(w) =>
				around([
					"  const a = `x`;",
					"  const b = `y`;",
					`  // banner: ${w} world here`,
				]),
		],
		[
			"a line continued by a backslash",
			(w) =>
				around([
					"  const total = a + \\",
					"    b;",
					`  // banner: ${w} world here`,
				]),
		],
		[
			"a double-quoted string left open at the end of a line",
			(w) =>
				around([
					'  const text = "first line',
					`    // banner: ${w} world here`,
					'    end";',
				]),
		],
	];

	it.each(
		cases,
	)("keeps a changed comment-looking line as code with %s", (_name, make) => {
		const files = moveFiles(make("hello"), make("goodbye"));
		const ops = findRelocations(files);
		expect(classes(ops)).toEqual(["code"]);
		expect(verifyRelocation(ops[0] as Operation, files)).toBe(true);
	});

	it.each(
		cases,
	)("rejects a comment-only class forged over %s", (_name, make) => {
		const files = moveFiles(make("hello"), make("goodbye"));
		const [op] = findRelocations(files) as [Operation];
		expect(verifyRelocation(forged(op, "comment-only", 0), files)).toBe(false);
	});

	it("keeps a changed comment as comment-only when the block only has a lone apostrophe", () => {
		const make = (w: string) => around([`  // don't ${w} the cache`]);
		const ops = findRelocations(moveFiles(make("touch"), make("clear")));
		expect(classes(ops)).toEqual(["comment-only"]);
	});

	it("keeps a changed line as code in a block that starts inside a template literal", () => {
		const make = (w: string) => [
			`    // banner: ${w} world here`,
			"  `;",
			...body(8),
		];
		const files = moveFiles(make("hello"), make("goodbye"));
		const ops = findRelocations(files);
		expect(classes(ops)).toEqual(["code"]);
		expect(
			verifyRelocation(forged(ops[0] as Operation, "comment-only", 0), files),
		).toBe(false);
	});

	it.each([
		"rs",
		"cs",
		"ts",
	])("does not claim a dedented .%s block with a multi-line string as exact", (ext) => {
		const nested = [
			"  if cond {",
			'    let s = "first',
			'      second line here";',
			"    publish(ctx, sources, options);",
			"    flush(ctx, sources, options);",
			"    report(ctx, sources, options);",
		];
		const dedented = nested.map((l) => l.slice(2));
		const files = moveFiles(nested, dedented, [`src/a.${ext}`, `src/b.${ext}`]);
		const ops = findRelocations(files);
		expect(ops.filter((op) => op.exact)).toEqual([]);
		const claim: Operation = {
			id: "relocation-1",
			type: "relocation",
			from: [
				{
					filename: `src/a.${ext}`,
					side: "base",
					startLine: 10,
					endLine: 15,
					shown: "full",
				},
			],
			to: [
				{
					filename: `src/b.${ext}`,
					side: "head",
					startLine: 3,
					endLine: 8,
					shown: "full",
				},
			],
			exact: true,
			divergences: [],
			reviewWeight: 0,
		};
		expect(verifyRelocation(claim, files)).toBe(false);
	});
});

describe("a literal on one side of a divergence", () => {
	const lines = (note: string, extra: string) => [
		"export function applyDiscount(input) {",
		...body(8),
		`  // ${note}`,
		extra,
		...body(2),
		"}",
	];
	const risky = '  const q = "`";';
	const calm = "  const q = 1;";

	function claim(
		baseLines: string[],
		headLines: string[],
		baseAt: number,
		headAt: number,
		removed: boolean,
		extra = risky,
	): { files: PushFile[]; op: Operation } {
		const files = moveFiles(baseLines, headLines);
		const span = (filename: string, side: "base" | "head", line: number) => ({
			filename,
			side,
			startLine: line,
			endLine: line,
			shown: "full" as const,
		});
		const op: Operation = {
			id: "relocation-1",
			type: "relocation",
			from: [
				{ ...span("src/a.ts", "base", 10), endLine: 10 + baseLines.length - 1 },
			],
			to: [
				{ ...span("src/b.ts", "head", 3), endLine: 3 + headLines.length - 1 },
			],
			exact: false,
			divergences: [
				{
					kind: "changed",
					class: "comment-only",
					base: span("src/a.ts", "base", 10 + baseAt),
					head: span("src/b.ts", "head", 3 + headAt),
					original: (baseLines[baseAt] as string).trim(),
				},
				removed
					? {
							kind: "removed",
							class: "code",
							base: span("src/a.ts", "base", 10 + baseLines.length - 4),
							original: extra.trim(),
						}
					: {
							kind: "inserted",
							class: "code",
							head: span("src/b.ts", "head", 3 + headLines.length - 4),
						},
			],
			reviewWeight: 1,
		};
		return { files, op };
	}

	it("accepts the claim when neither side holds a risky line", () => {
		const base = lines("hello there", calm);
		const head = lines("goodbye there", calm);
		head.splice(head.length - 4, 1);
		const { files, op } = claim(base, head, 9, 9, true, calm);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("rejects comment-only when only the base side holds a risky line", () => {
		const base = lines("hello there", risky);
		const head = lines("goodbye there", risky);
		head.splice(head.length - 4, 1);
		const { files, op } = claim(base, head, 9, 9, true);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("rejects comment-only when only the head side holds a risky line", () => {
		const base = lines("hello there", calm);
		base.splice(base.length - 4, 1);
		const head = lines("goodbye there", risky);
		const { files, op } = claim(base, head, 9, 9, false);
		expect(verifyRelocation(op, files)).toBe(false);
	});
});

describe("re-indented edge of a block", () => {
	const make = (ext: string, edge: string) => {
		const block = body(10);
		return moveFiles(
			[...block, "  ship(ctx)"],
			[...block, edge],
			[`src/a.${ext}`, `src/b.${ext}`],
		);
	};

	it("lists a re-indented edge line of a Ruby block as a divergence", () => {
		const ops = findRelocations(make("rb", "    ship(ctx)"));
		expect(ops.every((op) => !op.exact)).toBe(true);
		expect(classes(ops)).toContain("code");
	});

	it("takes the same re-indented edge line of a TypeScript block as identical", () => {
		const ops = findRelocations(make("ts", "    ship(ctx)"));
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(true);
		expect(ops[0]?.to[0]?.endLine).toBe(3 + 10);
	});
});

describe("whitespace-only mechanical hunks", () => {
	const patch = ["@@ -1,1 +1,1 @@", "-    const a = 1;", "+const a = 1;"].join(
		"\n",
	);

	it("reports a dedent in a TypeScript file", () => {
		expect(findMechanical([pushFile("src/a.ts", patch)])).toHaveLength(1);
	});

	it.each([
		"rb",
		"sh",
		"coffee",
		"bzl",
		"pyw",
		"fs",
		"sass",
	])("does not report a dedent in a .%s file", (ext) => {
		expect(findMechanical([pushFile(`src/a.${ext}`, patch)])).toEqual([]);
	});
});

describe("the checker's whitespace-free list matches the matcher's", () => {
	const names = [
		"a.js",
		"a.jsx",
		"a.mjs",
		"a.cjs",
		"a.ts",
		"a.tsx",
		"a.java",
		"a.c",
		"a.h",
		"a.cpp",
		"a.hpp",
		"a.cs",
		"a.rs",
		"a.go",
		"a.kt",
		"a.kts",
		"a.dart",
		"a.php",
		"a.css",
		"a.scss",
		"a.less",
		"a.json",
		"a.py",
		"a.pyi",
		"a.rb",
		"a.sh",
		"a.scala",
		"a.bzl",
		"a.fs",
		"a.coffee",
		"a.yml",
		"a.yaml",
		"Makefile",
		"a.mk",
		"a.cc",
		"a.swift",
		"a.md",
		"a.TS",
		"a.RS",
		"a",
	];

	it.each(names)("agrees on %s", (name) => {
		expect(WHITESPACE_FREE.test(name)).toBe(INDENT_COLLAPSIBLE_FILE.test(name));
	});
});

describe("the trailing-backslash scan stays linear", () => {
	it("handles a long run of backslashes that does not end the line", () => {
		const hostile = `${"\\".repeat(200_000)}x`;
		const started = performance.now();
		expect(continuesString(hostile)).toBe(false);
		expect(continuesString(`${"\\".repeat(200_001)}`)).toBe(true);
		expect(performance.now() - started).toBeLessThan(500);
	});
});
