import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation } from "./relocation-check.js";
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
		expect(model.operations.length).toBeGreaterThanOrEqual(0);
	});
});
