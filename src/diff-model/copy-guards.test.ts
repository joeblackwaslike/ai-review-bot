import { describe, expect, it } from "vitest";
import {
	extractContextRuns,
	extractRuns,
	type PushFile,
	type Run,
} from "../moved-blocks.js";
import {
	acceptCopySeed,
	copyBlockQualifies,
	copyQualifyCalls,
	lineInformation,
} from "./acceptance.js";
import { commentStart as matcherCommentStart } from "./block-build.js";
import { WorkBudget } from "./budget.js";
import { floorHolds, regionsOfRows, verifyCopy } from "./copy-check.js";
import { scanRegions } from "./copy-regions.js";
import { buildDiffModel } from "./index.js";
import { findRelocations } from "./relocation.js";
import {
	commentStart as checkerCommentStart,
	verifyRelocation,
} from "./relocation-check.js";
import type { Operation, Span } from "./types.js";

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

const added = (filename: string, start: number, lines: string[]) =>
	pushFile(
		filename,
		hunk(
			0,
			start,
			lines.map((l) => `+${l}`),
		),
	);

const deleted = (filename: string, start: number, lines: string[]) =>
	pushFile(
		filename,
		hunk(
			start,
			0,
			lines.map((l) => `-${l}`),
		),
	);

const withContext = (
	filename: string,
	start: number,
	context: string[],
	adds: string[] = ["  done();"],
) =>
	pushFile(
		filename,
		hunk(start, start, [
			...context.map((l) => ` ${l}`),
			...adds.map((l) => `+${l}`),
		]),
	);

const body = (count: number, tag = "v") =>
	Array.from(
		{ length: count },
		(_, i) => `  const ${tag}${i} = compute(${i}) + offset;`,
	);

const head = (filename: string, startLine: number, endLine: number): Span => ({
	filename,
	side: "head",
	startLine,
	endLine,
	shown: "full",
});

const claim = (from: Span, to: Span, extra: Partial<Operation> = {}) =>
	({
		id: "copy-1",
		type: "copy",
		from: [from],
		to: [to],
		exact: true,
		divergences: [],
		reviewWeight: 0,
		...extra,
	}) satisfies Operation;

const nonCopies = (files: PushFile[], limits = {}) =>
	findRelocations(files, limits).filter((op) => op.type !== "copy");
const copiesOf = (files: PushFile[], limits = {}) =>
	findRelocations(files, limits).filter((op) => op.type === "copy");
const accepts = (op: Operation, files: PushFile[]) =>
	verifyCopy(op, files, nonCopies(files));
const model = (files: PushFile[]) =>
	buildDiffModel({
		scopeFiles: files,
		prFiles: files,
		prFilesComplete: true,
		title: "t",
		body: null,
	});
const modelCopies = (files: PushFile[]) =>
	model(files).operations.filter((op) => op.type === "copy");

const fn = body(9);

describe("sourceNew through a relocation", () => {
	const wrapped = [
		"function check(input, options) {",
		...Array.from(
			{ length: 12 },
			(_, i) =>
				`  const value${i} = compute(input.field${i}, options.limit${i});`,
		),
		"  return validate(input);",
		"}",
	];
	const evil = wrapped.map((l, i) =>
		i === 6 ? "  const value5 = process.env.SECRET + exfiltrate(input);" : l,
	);
	const laundered = [
		deleted("src/a.ts", 10, wrapped),
		added("src/b.ts", 3, evil),
		added("src/c.ts", 3, evil),
	];

	it("marks a copy of a relocation's changed line as new code with weight", () => {
		const [op] = copiesOf(laundered);
		expect(op?.shape?.sourceNew).toBe(true);
		expect(op?.reviewWeight).toBeGreaterThanOrEqual(1);
		expect(accepts(op as Operation, laundered)).toBe(true);
	});

	it("drops a forged copy that claims the changed line is not new", () => {
		const [op] = copiesOf(laundered);
		const forged = { ...op, shape: undefined, reviewWeight: 0 } as Operation;
		expect(accepts(forged, laundered)).toBe(false);
	});

	it("keeps the end to end copy marked new", () => {
		const copies = modelCopies(laundered);
		expect(copies).toHaveLength(1);
		expect(copies[0]?.shape?.sourceNew).toBe(true);
		expect(model(laundered).droppedClaims).toBe(0);
	});

	it("still treats an exact relocation target as reviewed", () => {
		const files = [
			deleted("src/a.ts", 10, wrapped),
			added("src/b.ts", 3, wrapped),
			added("src/c.ts", 3, wrapped),
		];
		const [op] = copiesOf(files);
		expect(op?.shape?.sourceNew).toBeUndefined();
		expect(op?.reviewWeight).toBe(0);
		expect(accepts(op as Operation, files)).toBe(true);
	});

	it("marks every copy in a chain of new duplicates as sourceNew", () => {
		const files = [
			added("src/a.ts", 3, fn),
			added("src/b.ts", 3, fn),
			added("src/c.ts", 3, fn),
		];
		const copies = copiesOf(files);
		expect(copies.length).toBeGreaterThan(0);
		for (const op of copies) {
			expect(op.shape?.sourceNew).toBe(true);
			expect(accepts(op, files)).toBe(true);
		}
	});
});

describe("copies and multi-line constructs", () => {
	const wrappers: [string, string, string[], string[]][] = [
		["a block comment", "src/a.ts", ["/*", "*/"], []],
		["a template literal", "src/a.ts", ["const t = `", "`;"], []],
		["a python docstring", "src/a.py", ['"""', '"""'], []],
		["a heredoc", "src/a.sh", ["cat <<EOF", "EOF"], []],
	];

	it.each(wrappers)("rejects a source inside %s", (_, file, [open, close]) => {
		const plain = [
			withContext(file, 10, fn),
			added(file.replace("a.", "b."), 3, fn),
		];
		expect(copiesOf(plain)).toHaveLength(1);
		const wrapped = [
			withContext(file, 10, [open as string, ...fn, close as string]),
			added(file.replace("a.", "b."), 3, fn),
		];
		expect(copiesOf(wrapped)).toEqual([]);
		expect(modelCopies(wrapped)).toEqual([]);
		const forged = claim(
			head(file, 11, 10 + fn.length),
			head(file.replace("a.", "b."), 3, 2 + fn.length),
		);
		expect(accepts(forged, wrapped)).toBe(false);
	});

	it.each(wrappers)("keeps a clean copy beside %s in one file", (_, file, [
		open,
		close,
	]) => {
		const clean = body(8, "w");
		const patch = [
			hunk(1, 1, [
				...[open as string, ...fn, close as string].map((l) => ` ${l}`),
				"+  done();",
			]),
			hunk(
				40,
				40,
				clean.map((l) => ` ${l}`),
			),
		].join("\n");
		const files = [
			pushFile(file, patch),
			added(file.replace("a.", "b."), 3, clean),
		];
		const [op] = copiesOf(files);
		expect(op).toBeDefined();
		expect(op?.from[0]?.startLine).toBeGreaterThanOrEqual(40);
		expect(accepts(op as Operation, files)).toBe(true);
	});

	it("still copies a block that holds one comment line among code", () => {
		const mixed = body(7).map((l, i) => (i === 3 ? "  // keep this note" : l));
		const files = [
			withContext("src/a.ts", 10, mixed),
			added("src/b.ts", 3, mixed),
		];
		const [op] = copiesOf(files);
		expect(op).toBeDefined();
		expect(accepts(op as Operation, files)).toBe(true);
	});

	it("rejects a target inside a block comment", () => {
		const files = [
			withContext("src/a.ts", 10, fn),
			added("src/b.ts", 3, ["/*", ...fn, "*/"]),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(
			accepts(claim(head("src/a.ts", 10, 18), head("src/b.ts", 4, 12)), files),
		).toBe(false);
	});

	const unclosed: [string, string[]][] = [
		["a block comment opener", ["/* header", ...fn]],
		["an odd backtick", ["const s = `", ...fn]],
		["an odd triple quote", ['x = """', ...fn]],
		["a heredoc opener", ["cat <<EOF", ...fn]],
	];

	it.each(unclosed)("treats a file with %s left open as risky", (_, lines) => {
		const files = [
			withContext("src/a.ts", 10, lines),
			added("src/b.ts", 3, fn),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(
			accepts(claim(head("src/a.ts", 11, 19), head("src/b.ts", 3, 11)), files),
		).toBe(false);
	});

	it("never reports a block of whole comment lines as a copy", () => {
		const license = Array.from(
			{ length: 7 },
			(_, i) => `// Copyright line ${i} of the license header text`,
		);
		const files = [
			withContext("src/a.ts", 10, license),
			added("src/b.ts", 3, license),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(
			accepts(claim(head("src/a.ts", 10, 16), head("src/b.ts", 3, 9)), files),
		).toBe(false);
		const jsdoc = ["/**", ...license.map((l) => ` * ${l}`), " */"];
		const doc = [
			withContext("src/a.ts", 10, jsdoc),
			added("src/b.ts", 3, jsdoc),
		];
		expect(copiesOf(doc)).toEqual([]);
	});

	it("scans the same regions in the matcher and the checker", () => {
		const patch = [
			"@@ -1,9 +1,9 @@",
			" const a = 1;",
			" /* open",
			" inside",
			" */",
			" const t = `x",
			" y`;",
			" # hash",
			' s = """doc',
			' more"""',
		].join("\n");
		const rows: [number, string][] = patch
			.split("\n")
			.slice(1)
			.map((row, i) => [i + 1, row.slice(1)]);
		for (const file of ["a.ts", "a.py"]) {
			const mine = scanRegions(file, patch);
			const theirs = regionsOfRows(file, rows);
			expect([...mine.unsafe].sort()).toEqual([...theirs.unsafe].sort());
			expect(mine.risky).toBe(theirs.risky);
		}
	});
});

describe("copies where whitespace carries meaning", () => {
	const indented = (pad: string) => body(7).map((l) => `${pad}${l.trim()}`);

	it.each([
		"src/a.coffee",
		"src/a.hs",
		"src/a.unknownext",
	])("requires raw equality in %s", (file) => {
		const target = file.replace("a.", "b.");
		const files = [
			withContext(file, 10, indented("  ")),
			added(target, 3, indented("    ")),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(modelCopies(files)).toEqual([]);
		expect(accepts(claim(head(file, 10, 16), head(target, 3, 9)), files)).toBe(
			false,
		);
	});

	it("still pairs a re-indented block in a brace language", () => {
		const files = [
			withContext("src/a.ts", 10, indented("  ")),
			added("src/b.ts", 3, indented("    ")),
		];
		const [op] = copiesOf(files);
		expect(op).toBeDefined();
		expect(accepts(op as Operation, files)).toBe(true);
	});

	it("requires raw equality when only the source patch holds a literal opener", () => {
		const files = [
			withContext("src/a.ts", 10, indented("  "), ["const k = `x`;"]),
			added("src/b.ts", 3, indented("    ")),
		];
		expect(copiesOf(files)).toEqual([]);
	});

	it("requires raw equality once the patch holds a literal opener", () => {
		const files = [
			withContext("src/a.ts", 10, indented("  ")),
			added("src/b.ts", 3, [...indented("    "), "const k = `x`;"]),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(
			accepts(claim(head("src/a.ts", 10, 16), head("src/b.ts", 3, 9)), files),
		).toBe(false);
	});
});

describe("copy floor cost", () => {
	const nasty = (i: number) => `x${i} = '${"\\'".repeat(900)}'`;

	it("answers a flood of identical long-line blocks in under a second", () => {
		const block = Array.from({ length: 5 }, (_, i) => nasty(i));
		const files = [
			withContext("src/ctx.ts", 10, block),
			...Array.from({ length: 50 }, (_, i) => added(`src/f${i}.ts`, 3, block)),
		];
		const started = performance.now();
		const ops = findRelocations(files);
		const elapsed = performance.now() - started;
		expect(ops.filter((op) => op.type === "copy")).toEqual([]);
		expect(elapsed).toBeLessThan(5000);
		expect(elapsed).toBeLessThan(1000);
	});

	it("keeps a 2000 line benign body fast", () => {
		const big = body(2000);
		const files = [withContext("src/a.ts", 10, big), added("src/b.ts", 3, big)];
		const started = performance.now();
		const ops = findRelocations(files);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(ops.some((op) => op.type === "copy")).toBe(true);
	});

	it("draws from the budget before it evaluates the floor", () => {
		const source = extractContextRuns(
			"src/a.ts",
			hunk(
				1,
				1,
				fn.map((l) => ` ${l}`),
			),
		)[0] as Run;
		const target = extractRuns(
			"src/b.ts",
			hunk(
				0,
				1,
				fn.map((l) => `+${l}`),
			),
		).added[0] as Run;
		const seed = {
			from: source,
			to: target,
			fromStart: 0,
			toStart: 0,
			length: fn.length,
			counted: fn.length,
		};
		const before = copyQualifyCalls.count;
		expect(acceptCopySeed(seed, new WorkBudget({ tokens: 10 }))).toBe(false);
		expect(copyQualifyCalls.count).toBe(before);
		expect(acceptCopySeed(seed, new WorkBudget())).toBe(true);
		expect(copyQualifyCalls.count).toBe(before + 1);
	});

	it("evaluates the floor once per range", () => {
		const files = [withContext("src/a.ts", 10, fn), added("src/b.ts", 3, fn)];
		const before = copyQualifyCalls.count;
		expect(copiesOf(files)).toHaveLength(1);
		expect(copyQualifyCalls.count - before).toBe(1);
	});

	it("scores a 2000 character line without a quadratic scan", () => {
		const line = `x = '${"\\'".repeat(995)}`;
		const started = performance.now();
		for (let i = 0; i < 300; i++) lineInformation(line);
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("never qualifies a line over 500 characters", () => {
		const long = body(6).map((l, i) =>
			i === 2 ? `${l}//${"x".repeat(600)}` : l,
		);
		const run = extractContextRuns(
			"src/a.ts",
			hunk(
				1,
				1,
				long.map((l) => ` ${l}`),
			),
		)[0];
		expect(copyBlockQualifies(run as never, 0, 6)).toBe(false);
		expect(floorHolds(long, false)).toBe(false);
	});

	it("agrees between the matcher floor and the checker floor", () => {
		const blocks: [string, string[]][] = [
			["src/a.ts", body(6)],
			["src/a.ts", body(3)],
			["src/a.ts", ["function f(a) {", "  return g(a) + h(a);", "}"]],
			["src/a.ts", ["const x = {", "  a: 1,", "  b: 2,", "  c: 3,", "};"]],
			["src/a.ts", ["import { a } from 'a';", "import { b } from 'b';"]],
			["src/a.ts", Array.from({ length: 6 }, (_, i) => `// note number ${i}`)],
			["src/a.py", Array.from({ length: 6 }, (_, i) => `# note number ${i}`)],
			["src/a.py", ["def f(a):", "    return g(a) + h(a)", "    # tail"]],
			[
				"src/a.ts",
				body(5).map((l, i) => (i === 1 ? `${l} + "${"y".repeat(520)}"` : l)),
			],
		];
		for (const [file, lines] of blocks) {
			const run = extractContextRuns(
				file,
				hunk(
					1,
					1,
					lines.map((l) => ` ${l}`),
				),
			)[0];
			const hash = /\.py$/.test(file);
			expect(floorHolds(lines, hash, hash)).toBe(
				copyBlockQualifies(run as never, 0, lines.length),
			);
		}
	});
});

describe("regex literals and comment starts", () => {
	const lineAt = (text: string, at = 6) =>
		body(13).map((l, i) => (i === at ? text : l));
	const relocationFiles = (a: string, b: string, file = "src/b.ts") => [
		deleted("src/a.ts", 10, lineAt(a)),
		added(file, 3, lineAt(b)),
	];
	const relabeled = (op: Operation, cls: "comment-only") => ({
		...op,
		exact: false,
		reviewWeight: 0,
		divergences: op.divergences.map((d) => ({ ...d, class: cls })),
	});

	const repros: [string, string][] = [
		[
			"  const r = /'/.test(s) + ' // x', t = ok;",
			"  const r = /'/.test(s) + ' // x', t = evil;",
		],
		["  const r = /[ //a]/.test(input);", "  const r = /[ //b]/.test(input);"],
	];

	it.each(repros)("classes %s as code in the matcher", (a, b) => {
		const [op] = nonCopies(relocationFiles(a, b));
		expect(op?.divergences.map((d) => d.class)).toEqual(["code"]);
		expect(op?.reviewWeight).toBe(1);
	});

	it.each(
		repros,
	)("drops a relocation of %s relabelled comment-only", (a, b) => {
		const files = relocationFiles(a, b);
		const [op] = nonCopies(files);
		expect(
			verifyRelocation(relabeled(op as Operation, "comment-only"), files),
		).toBe(false);
	});

	it.each(repros)("drops a copy of %s relabelled comment-only", (a, b) => {
		const files = [
			withContext("src/a.ts", 10, lineAt(a)),
			added("src/b.ts", 3, lineAt(b)),
		];
		const [op] = copiesOf(files);
		expect(op?.divergences.map((d) => d.class)).toEqual(["code"]);
		expect(accepts(relabeled(op as Operation, "comment-only"), files)).toBe(
			false,
		);
	});

	it("keeps a trailing comment edit after plain division comment-only", () => {
		const files = relocationFiles(
			"  const q = a / b; // note",
			"  const q = a / b; // changed",
		);
		const [op] = nonCopies(files);
		expect(op?.divergences.map((d) => d.class)).toEqual(["comment-only"]);
		expect(op?.reviewWeight).toBe(0);
		expect(verifyRelocation(op as Operation, files)).toBe(true);
	});

	it("weighs a glued double slash edit as code in a relocation", () => {
		const files = relocationFiles("  const q = 1;//a", "  const q = 1;//b");
		const [op] = nonCopies(files);
		expect(op?.divergences.map((d) => d.class)).toEqual(["code"]);
		expect(op?.reviewWeight).toBe(1);
		expect(verifyRelocation(op as Operation, files)).toBe(true);
	});

	const pyLines = (text: string) =>
		Array.from({ length: 13 }, (_, i) =>
			i === 6 ? text : `    v${i} = compute(${i}) + offset`,
		);

	it("keeps a python trailing hash comment edit as code", () => {
		const files = [
			deleted("src/a.py", 10, pyLines("    x = 1  # note")),
			added("src/b.py", 3, pyLines("    x = 1  # changed")),
		];
		const [op] = nonCopies(files);
		expect(op?.divergences.map((d) => d.class)).toEqual(["code"]);
	});

	it("never reads python floor division as a comment", () => {
		const files = [
			deleted("src/a.py", 10, pyLines("    q = total // count + f(1)")),
			added("src/b.py", 3, pyLines("    q = total // count + f(2)")),
		];
		const [op] = nonCopies(files);
		expect(op?.divergences.map((d) => d.class)).toEqual(["code"]);
	});

	it("starts a comment at the same index in the matcher and the checker", () => {
		const lines = [
			"x = 1; // note",
			"x = 1;// note",
			'const s = "a // b"; // tail',
			"const r = s.replace(/\\//g, '-');",
			"// whole line",
			"a = b / c;",
			"u = `http://x`; // note",
			"p = 'it''s' // note",
		];
		for (const line of lines)
			expect(matcherCommentStart(line)).toBe(checkerCommentStart(line));
	});
});

describe("whitespace inside literals", () => {
	it("does not claim a copy whose regex literal differs in spacing", () => {
		const a = body(8).map((l, i) =>
			i === 3 ? "  const r = /a b/.test(s);" : l,
		);
		const b = a.map((l, i) => (i === 3 ? "  const r = /a  b/.test(s);" : l));
		const files = [withContext("src/a.ts", 10, a), added("src/b.ts", 3, b)];
		expect(copiesOf(files)).toEqual([]);
		expect(model(files).droppedClaims).toBe(0);
		const forged = claim(head("src/a.ts", 10, 17), head("src/b.ts", 3, 10));
		expect(accepts(forged, files)).toBe(false);
	});
});

describe("copy matcher limits and policy", () => {
	it("cannot emit two copies over one target", () => {
		const files = [
			withContext("src/a.ts", 10, fn),
			withContext("src/c.ts", 20, fn),
			added("src/b.ts", 3, fn),
		];
		const copies = copiesOf(files);
		expect(copies).toHaveLength(1);
		const spans = copies.map(
			(op) => `${op.to[0]?.filename}:${op.to[0]?.startLine}`,
		);
		expect(new Set(spans).size).toBe(spans.length);
	});

	it("stops resolving chains once the budget runs dry", () => {
		const sources = (i: number) => body(14, `s${i}x`);
		const files = [
			...Array.from({ length: 8 }, (_, i) =>
				withContext(`src/s${i}.ts`, 10, sources(i)),
			),
			...Array.from({ length: 8 }, (_, i) =>
				added(
					`src/t${i}.ts`,
					3,
					sources(i).map((l, k) => (k === 7 ? `  other(${i}, ${k});` : l)),
				),
			),
		];
		expect(copiesOf(files)).toHaveLength(8);
		const limited = copiesOf(files, { cells: 10 }).length;
		expect(limited).toBeGreaterThan(0);
		expect(limited).toBeLessThan(8);
	});

	it("reports a copy of a test file source with sourceNew false", () => {
		const files = [
			withContext("src/a.test.ts", 10, fn),
			added("src/b.ts", 3, fn),
		];
		const [op] = copiesOf(files);
		expect(op).toBeDefined();
		expect(op?.shape?.sourceNew).toBeUndefined();
		expect(accepts(op as Operation, files)).toBe(true);
	});
});
