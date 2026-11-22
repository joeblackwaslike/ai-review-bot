import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";
import { findRelocations } from "./relocation.js";

function pushFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function hunk(oldStart: number, newStart: number, rows: string[]): string {
	const oldCount = rows.filter((r) => !r.startsWith("+")).length;
	const newCount = rows.filter((r) => !r.startsWith("-")).length;
	return [
		`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
		...rows,
	].join("\n");
}

function added(filename: string, start: number, lines: string[]): PushFile {
	return pushFile(
		filename,
		hunk(
			0,
			start,
			lines.map((l) => `+${l}`),
		),
	);
}

function withContext(
	filename: string,
	start: number,
	context: string[],
	adds: string[],
	after: string[] = [],
): PushFile {
	return pushFile(
		filename,
		hunk(start, start, [
			...context.map((l) => ` ${l}`),
			...adds.map((l) => `+${l}`),
			...after.map((l) => ` ${l}`),
		]),
	);
}

function body(count: number, tag = "v"): string[] {
	return Array.from(
		{ length: count },
		(_, i) => `  const ${tag}${i} = compute(${i}) + offset;`,
	);
}

function copies(files: PushFile[], limits = {}) {
	return findRelocations(files, limits).filter((op) => op.type === "copy");
}

const definition = [
	"function clampValue(value) {",
	"  return Math.min(value, 9);",
	"}",
];

describe("findCopies", () => {
	it("reports a block that copies visible context lines", () => {
		const shared = body(6);
		const ops = copies([
			withContext("src/a.ts", 10, shared, [], ["  done();"]),
			added("src/b.ts", 3, shared),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			id: "copy-1",
			type: "copy",
			exact: true,
			divergences: [],
			reviewWeight: 0,
			from: [
				{ filename: "src/a.ts", side: "head", startLine: 10, endLine: 15 },
			],
			to: [{ filename: "src/b.ts", side: "head", startLine: 3, endLine: 8 }],
		});
		expect(ops[0]?.shape?.sourceNew).toBeUndefined();
	});

	it("reports a duplicated added block as sourceNew with full weight", () => {
		const shared = body(6);
		const ops = copies([
			added("src/a.ts", 10, shared),
			added("src/b.ts", 3, shared),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			type: "copy",
			exact: true,
			reviewWeight: 1,
			shape: { sourceNew: true },
			from: [{ filename: "src/a.ts", side: "head", startLine: 10 }],
			to: [{ filename: "src/b.ts", side: "head", startLine: 3 }],
		});
	});

	it("lists edits in a copied block as divergences", () => {
		const source = body(12);
		const edited = source.map((l, i) =>
			i === 5 ? "  const rate = Math.floor(price * pct);" : l,
		);
		const ops = copies([
			withContext("src/a.ts", 10, source, []),
			added("src/b.ts", 3, edited),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(false);
		expect(ops[0]?.divergences).toHaveLength(1);
		expect(ops[0]?.divergences[0]).toMatchObject({
			kind: "changed",
			class: "code",
			base: { side: "head", startLine: 15 },
			head: { side: "head", startLine: 8 },
			original: "const v5 = compute(5) + offset;",
		});
		expect(ops[0]?.reviewWeight).toBe(1);
	});

	it("falls back to the seed range when widening ends inside an unclosed call", () => {
		const shared = body(6);
		const ops = copies([
			withContext(
				"src/a.ts",
				10,
				[...shared, '  it("alpha case", async () => {'],
				[],
			),
			added("src/b.ts", 3, [...shared, '  it("beta case", async () => {']),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			exact: true,
			divergences: [],
			from: [{ startLine: 10, endLine: 15 }],
			to: [{ startLine: 3, endLine: 8 }],
		});
	});

	it("keeps a widening that stays valid with its divergence", () => {
		const shared = body(6);
		const ops = copies([
			withContext("src/a.ts", 10, [...shared, '  log("alpha");'], []),
			added("src/b.ts", 3, [...shared, '  log("beta");']),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			exact: false,
			from: [{ startLine: 10, endLine: 16 }],
			to: [{ startLine: 3, endLine: 9 }],
		});
		expect(ops[0]?.divergences).toHaveLength(1);
	});

	it("does not copy-match lines a relocation claimed", () => {
		const block = body(8);
		const files = [
			pushFile(
				"src/a.ts",
				hunk(
					10,
					9,
					block.map((l) => `-${l}`),
				),
			),
			added("src/b.ts", 3, block),
			withContext("src/c.ts", 20, block, []),
		];
		const all = findRelocations(files);
		expect(all.filter((op) => op.type === "relocation")).toHaveLength(1);
		expect(all.filter((op) => op.type === "copy")).toEqual([]);
	});

	it("ignores a 4-line duplicate that is not a definition", () => {
		const shared = body(4);
		expect(
			copies([
				withContext("src/a.ts", 10, shared, []),
				added("src/b.ts", 3, shared),
			]),
		).toEqual([]);
	});

	it("ignores a 3-line duplicated const call", () => {
		const call = [
			'const prompt = buildAgentSystemPrompt("reviewer.md", "", {',
			"  strictEvidenceRules,",
			"});",
		];
		expect(
			copies([
				withContext("src/a.ts", 10, call, []),
				added("src/b.ts", 3, call),
			]),
		).toEqual([]);
	});

	it("accepts a 3-line duplicated definition", () => {
		const ops = copies([
			withContext("src/a.ts", 10, definition, []),
			added("src/b.ts", 3, definition),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			to: [{ filename: "src/b.ts", startLine: 3, endLine: 5 }],
		});
	});

	it("does not copy against code outside the hunks", () => {
		const shared = body(6);
		expect(
			copies([
				pushFile("src/a.ts", hunk(100, 100, ["+  untouched();"])),
				added("src/b.ts", 3, shared),
			]),
		).toEqual([]);
	});

	it("yields two copies pointing at the first of three identical added blocks", () => {
		const shared = body(6);
		const ops = copies([
			added("src/a.ts", 10, shared),
			added("src/b.ts", 3, shared),
			added("src/c.ts", 7, shared),
		]);
		expect(ops).toHaveLength(2);
		for (const op of ops) {
			expect(op.from).toMatchObject([{ filename: "src/a.ts", startLine: 10 }]);
			expect(op.shape?.sourceNew).toBe(true);
		}
		expect(ops.map((op) => op.to[0]?.filename)).toEqual([
			"src/b.ts",
			"src/c.ts",
		]);
		expect(ops.map((op) => op.id)).toEqual(["copy-1", "copy-2"]);
	});

	it("prefers a context source over an added source", () => {
		const shared = body(6);
		const ops = copies([
			added("src/a.ts", 10, shared),
			withContext("src/b.ts", 30, shared, []),
			added("src/c.ts", 3, shared),
		]);
		const toC = ops.find((op) => op.to[0]?.filename === "src/c.ts");
		expect(toC?.from[0]?.filename).toBe("src/b.ts");
		expect(toC?.shape?.sourceNew).toBeUndefined();
	});

	it("copies within one file across different runs", () => {
		const shared = body(6);
		const ops = copies([
			pushFile(
				"src/a.ts",
				[
					hunk(1, 1, [" keep();", ...shared.map((l) => `+${l}`), " keep2();"]),
					hunk(40, 46, [" other();", ...shared.map((l) => `+${l}`), " end();"]),
				].join("\n"),
			),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			shape: { sourceNew: true },
			from: [{ filename: "src/a.ts", startLine: 2 }],
			to: [{ filename: "src/a.ts", startLine: 47 }],
		});
	});

	it("does not treat an in-place reflow as a copy of its own context", () => {
		const old = body(6);
		const reflowed = old.map((l) => `    ${l.trim()}`);
		expect(
			copies([
				pushFile(
					"src/a.ts",
					hunk(5, 5, [
						" before();",
						...old.map((l) => `-${l}`),
						...reflowed.map((l) => `+${l}`),
						" after();",
					]),
				),
			]),
		).toEqual([]);
	});

	it("rejects a duplicate made only of imports", () => {
		const imports = [
			'import { alpha } from "./alpha";',
			'import { beta } from "./beta";',
			'import { gamma } from "./gamma";',
			'import { delta } from "./delta";',
			'import { omega } from "./omega";',
		];
		expect(
			copies([added("src/a.ts", 1, imports), added("src/b.ts", 1, imports)]),
		).toEqual([]);
	});

	it("rejects a duplicated multi-line import block", () => {
		const imports = [
			"import {",
			"  alpha,",
			"  betaValue,",
			"  gammaValue,",
			"  deltaValue,",
			'} from "./shared.js";',
		];
		expect(
			copies([
				withContext("src/a.ts", 1, imports, []),
				added("src/b.ts", 1, imports),
			]),
		).toEqual([]);
	});

	it("skips a duplicated run of object properties", () => {
		const props = [
			'  severity: "P2",',
			'  category: "style",',
			'  title: "Something",',
			"  line: 12,",
			"  ...extra,",
		];
		expect(
			copies([
				withContext("src/a.test.ts", 10, props, []),
				added("src/b.test.ts", 3, props),
			]),
		).toEqual([]);
	});

	it("rejects a slice through the middle of a call", () => {
		const slice = [
			"  first: compute(1),",
			"  second: compute(2),",
			"  third: compute(3),",
			"  fourth: compute(4),",
			"  fifth: compute(5)));",
		];
		expect(
			copies([
				withContext("src/a.ts", 10, slice, []),
				added("src/b.ts", 3, slice),
			]),
		).toEqual([]);
	});

	it("skips repeated records in JSON data files", () => {
		const records = Array.from(
			{ length: 6 },
			(_, i) => `  "field${i}": { "kind": "text", "value": ${i} },`,
		);
		expect(
			copies([
				added("fixtures/one.json", 1, records),
				added("fixtures/two.json", 1, records),
			]),
		).toEqual([]);
	});

	it("respects the budget deterministically", () => {
		const files = Array.from({ length: 20 }, (_, i) =>
			added(`src/f${i}.ts`, 1, body(6)),
		);
		const run = () => copies(files, { candidates: 3 });
		const first = run();
		expect(first.length).toBeGreaterThan(0);
		expect(first.length).toBeLessThan(19);
		expect(run()).toEqual(first);
	});

	it("keeps lockfiles excluded", () => {
		const shared = body(6);
		expect(
			copies([
				added("pnpm-lock.yaml", 1, shared),
				added("src/b.ts", 1, shared),
			]),
		).toEqual([]);
	});

	it("keeps sourceNew for a copy of an edited copy of new code", () => {
		const a = body(12);
		const b = a.map((l, i) =>
			i === 6 ? "  const rate = Math.floor(price * pct);" : l,
		);
		const ops = copies([
			added("src/a.ts", 1, a),
			added("src/b.ts", 1, b),
			added("src/c.ts", 1, b),
		]);
		const toC = ops.find((op) => op.to[0]?.filename === "src/c.ts");
		expect(toC?.shape?.sourceNew).toBe(true);
		expect(toC?.reviewWeight).toBeGreaterThanOrEqual(1);
	});

	it("marks a copy new when only some of its source lines are new", () => {
		const eight = body(8);
		const deleted = pushFile(
			"src/old.ts",
			hunk(
				1,
				0,
				eight.slice(0, 5).map((l) => `-${l}`),
			),
		);
		const ops = findRelocations([
			deleted,
			added("src/b.ts", 1, eight),
			added("src/c.ts", 1, eight),
		]).filter((op) => op.type === "copy");
		expect(ops).toHaveLength(1);
		expect(ops[0]?.shape?.sourceNew).toBe(true);
		expect(ops[0]?.reviewWeight).toBeGreaterThanOrEqual(1);
	});

	it("leaves a copy of fully relocated code not new with no weight", () => {
		const eight = body(8);
		const deleted = pushFile(
			"src/old.ts",
			hunk(
				1,
				0,
				eight.map((l) => `-${l}`),
			),
		);
		const ops = findRelocations([
			deleted,
			added("src/b.ts", 1, eight),
			added("src/c.ts", 1, eight),
		]).filter((op) => op.type === "copy");
		expect(ops).toHaveLength(1);
		expect(ops[0]?.shape?.sourceNew).toBeUndefined();
		expect(ops[0]?.reviewWeight).toBe(0);
	});

	it("skips duplicated blocks in prose files", () => {
		const prose = [
			"The review bot reads the diff and posts findings.",
			"Each finding carries a severity and a suggested fix.",
			"Findings are grouped by file and ordered by line.",
			"A reviewer can reply to dismiss any single finding.",
			"Dismissed findings are not repeated on later pushes.",
		];
		expect(
			copies([added("docs/one.md", 1, prose), added("docs/two.md", 1, prose)]),
		).toEqual([]);
	});
});

describe("copies under the shared work limits", () => {
	it("never claims a block holding a line over the 2000-character cap", () => {
		const long = body(6).map((l, i) =>
			i === 2 ? `${l}//${"x".repeat(2100)}` : l,
		);
		expect(
			copies([
				withContext("src/a.ts", 10, long, ["done"]),
				added("src/b.ts", 3, long),
			]),
		).toEqual([]);
	});

	it("claims nothing once the extension pool is empty", () => {
		const files = [
			withContext("src/a.ts", 10, body(6), ["done"]),
			added("src/b.ts", 3, body(6)),
		];
		expect(copies(files)).toHaveLength(1);
		expect(copies(files, { extensions: 0 })).toEqual([]);
	});

	it("weighs a renamed identifier once, as relocations do", () => {
		const source = body(30);
		source.splice(2, 0, "  const total = compute(0);");
		source.splice(12, 0, "  log(total, 1);");
		source.splice(22, 0, "  return finalize(total);");
		const renamed = source.map((l) => l.replaceAll("total", "sum"));
		const [op] = copies([
			withContext("src/a.ts", 10, source, ["done"]),
			added("src/b.ts", 3, renamed),
		]);
		expect(op?.divergences.map((d) => d.class)).toEqual([
			"rename",
			"rename",
			"rename",
		]);
		expect(op?.reviewWeight).toBe(1);
	});
});

describe("adversarial copy budget", () => {
	const BACKSTOP_MS = 5_000;
	const FILES = 200;

	const block = [
		"  const subtotal = computeSubtotal(items) + computeTax(items, rate);",
		"  const rounded = Math.round(subtotal * 100) / 100;",
		"  const label = formatCurrency(rounded, currency);",
		"  audit.record(label, rounded, items.length);",
		"  cache.store(label, rounded);",
		"  return label;",
	];

	function repeated(): PushFile[] {
		return Array.from({ length: FILES }, (_, i) =>
			added(`src/dup/file${i}.ts`, 1, [
				...block,
				`  const marker${i} = ${i};`,
				...block,
			]),
		);
	}

	function modelOf(files: PushFile[]) {
		return buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "",
			body: null,
		});
	}

	it("builds the model for 400 identical blocks across 200 files, repeats exactly and stays fast", () => {
		const files = repeated();
		const started = performance.now();
		const first = modelOf(files);
		expect(performance.now() - started).toBeLessThan(BACKSTOP_MS);
		expect(modelOf(files)).toEqual(first);
		const found = first.operations.filter((op) => op.type === "copy");
		expect(found.length).toBeGreaterThan(0);
		expect(found.length).toBeLessThanOrEqual(FILES * 2);
		expect(first.droppedClaims).toBe(0);
		for (const op of found) {
			expect(op.shape?.sourceNew).toBe(true);
			expect(op.reviewWeight).toBeGreaterThanOrEqual(1);
		}
	});

	it("returns what it found when the budget runs out and repeats exactly", () => {
		const files = repeated();
		const full = findRelocations(files).filter((op) => op.type === "copy");
		const limits = { candidates: 40 };
		const limited = findRelocations(files, limits);
		expect(findRelocations(files, limits)).toEqual(limited);
		expect(limited.length).toBeGreaterThan(0);
		expect(limited.length).toBeLessThan(full.length);
		const fullTargets = new Set(full.map((op) => JSON.stringify(op.to)));
		for (const op of limited)
			expect(fullTargets.has(JSON.stringify(op.to))).toBe(true);
	});

	it("returns no copies at all once the candidate budget is empty", () => {
		expect(
			findRelocations(repeated(), { candidates: 0 }).filter(
				(op) => op.type === "copy",
			),
		).toEqual([]);
	});
});
