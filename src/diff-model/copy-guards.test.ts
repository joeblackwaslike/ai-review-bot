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
import type { Operation } from "./types.js";

const file = (filename: string, patch: string): PushFile => ({
	filename,
	status: "modified",
	patch,
	additions: 0,
	deletions: 0,
});
const hunk = (old: number, head: number, rows: string[]) =>
	`@@ -${old},${rows.filter((r) => !r.startsWith("+")).length} +${head},${rows.filter((r) => !r.startsWith("-")).length} @@\n${rows.join("\n")}`;
const rows = (sign: string, lines: string[]) => lines.map((l) => sign + l);
const added = (name: string, at: number, lines: string[]) =>
	file(name, hunk(0, at, rows("+", lines)));
const deleted = (name: string, at: number, lines: string[]) =>
	file(name, hunk(at, 0, rows("-", lines)));
const ctx = (name: string, at: number, lines: string[], adds = ["  done();"]) =>
	file(name, hunk(at, at, [...rows(" ", lines), ...rows("+", adds)]));
const body = (n: number, tag = "v") =>
	Array.from(
		{ length: n },
		(_, i) => `  const ${tag}${i} = compute(${i}) + offset;`,
	);
const at = (lines: string[], i: number, text: string) =>
	lines.map((l, k) => (k === i ? text : l));
const forge = (
	a: string,
	a1: number,
	a2: number,
	b: string,
	b1: number,
	b2: number,
) =>
	({
		id: "copy-1",
		type: "copy",
		from: [
			{ filename: a, side: "head", startLine: a1, endLine: a2, shown: "full" },
		],
		to: [
			{ filename: b, side: "head", startLine: b1, endLine: b2, shown: "full" },
		],
		exact: true,
		divergences: [],
		reviewWeight: 0,
	}) satisfies Operation;

const nonCopies = (files: PushFile[]) =>
	findRelocations(files).filter((op) => op.type !== "copy");
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
const classes = (op?: Operation) => op?.divergences.map((d) => d.class);

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
	const evil = at(
		wrapped,
		6,
		"  const value5 = process.env.SECRET + exfiltrate(input);",
	);
	const laundered = [
		deleted("src/a.ts", 10, wrapped),
		added("src/b.ts", 3, evil),
		added("src/c.ts", 3, evil),
	];

	it("marks a copy of a relocation's changed line as new", () => {
		const [op] = copiesOf(laundered);
		expect(op?.shape?.sourceNew).toBe(true);
		expect(op?.reviewWeight).toBeGreaterThanOrEqual(1);
		expect(accepts(op as Operation, laundered)).toBe(true);
		const forged = { ...op, shape: undefined, reviewWeight: 0 } as Operation;
		expect(accepts(forged, laundered)).toBe(false);
		expect(modelCopies(laundered)[0]?.shape?.sourceNew).toBe(true);
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
		const files = ["a", "b", "c"].map((n) => added(`src/${n}.ts`, 3, fn));
		expect(copiesOf(files).length).toBeGreaterThan(0);
		for (const op of copiesOf(files)) {
			expect(op.shape?.sourceNew).toBe(true);
			expect(accepts(op, files)).toBe(true);
		}
	});
});

describe("copies and multi-line constructs", () => {
	const wrappers: [string, string, string, string][] = [
		["a block comment", "a.ts", "/*", "*/"],
		["a template literal", "a.ts", "const t = `", "`;"],
		["a python docstring", "a.py", '"""', '"""'],
		["a heredoc", "a.sh", "cat <<EOF", "EOF"],
	];

	it.each(
		wrappers,
	)("rejects a source inside %s, keeps a clean one beside it", (_, name, open, close) => {
		const [a, b] = [`src/${name}`, `src/${name.replace("a.", "b.")}`];
		expect(copiesOf([ctx(a, 10, fn), added(b, 3, fn)])).toHaveLength(1);
		const files = [ctx(a, 10, [open, ...fn, close]), added(b, 3, fn)];
		expect(copiesOf(files)).toEqual([]);
		expect(modelCopies(files)).toEqual([]);
		expect(accepts(forge(a, 11, 19, b, 3, 11), files)).toBe(false);
		const clean = body(8, "w");
		const beside = [
			file(
				a,
				`${hunk(1, 1, [...rows(" ", [open, ...fn, close]), "+  done();"])}\n${hunk(40, 40, rows(" ", clean))}`,
			),
			added(b, 3, clean),
		];
		const [op] = copiesOf(beside);
		expect(op?.from[0]?.startLine).toBeGreaterThanOrEqual(40);
		expect(accepts(op as Operation, beside)).toBe(true);
	});

	it("rejects a target inside a block comment", () => {
		const files = [
			ctx("src/a.ts", 10, fn),
			added("src/b.ts", 3, ["/*", ...fn, "*/"]),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(accepts(forge("src/a.ts", 10, 18, "src/b.ts", 4, 12), files)).toBe(
			false,
		);
	});

	it.each([
		["a block comment opener", "/* header"],
		["an odd backtick", "const s = `"],
		["an odd triple quote", 'x = """'],
		["a heredoc opener", "cat <<EOF"],
	])("treats a file with %s left open as risky", (_, opener) => {
		const files = [
			ctx("src/a.ts", 10, [opener, ...fn]),
			added("src/b.ts", 3, fn),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(accepts(forge("src/a.ts", 11, 19, "src/b.ts", 3, 11), files)).toBe(
			false,
		);
	});

	it("rejects whole comment blocks, keeps one comment among code", () => {
		const license = Array.from(
			{ length: 7 },
			(_, i) => `// Copyright line ${i} of the license header`,
		);
		for (const lines of [
			license,
			["/**", ...license.map((l) => ` * ${l}`), " */"],
		]) {
			const files = [ctx("src/a.ts", 10, lines), added("src/b.ts", 3, lines)];
			expect(copiesOf(files)).toEqual([]);
			expect(accepts(forge("src/a.ts", 10, 16, "src/b.ts", 3, 9), files)).toBe(
				false,
			);
		}
		const mixed = at(body(7), 3, "  // keep this note");
		const files = [ctx("src/a.ts", 10, mixed), added("src/b.ts", 3, mixed)];
		expect(accepts(copiesOf(files)[0] as Operation, files)).toBe(true);
	});

	it("scans the same regions in the matcher and the checker", () => {
		const text = [
			" const a = 1;",
			" /* open",
			" inside",
			" */",
			" const t = `x",
			" y`;",
			" # hash",
			' s = """doc',
			' more"""',
		];
		const patch = `@@ -1,9 +1,9 @@\n${text.join("\n")}`;
		const numbered = text.map((row, i): [number, string] => [
			i + 1,
			row.slice(1),
		]);
		for (const name of ["a.ts", "a.py"]) {
			const [mine, theirs] = [
				scanRegions(name, patch),
				regionsOfRows(name, numbered),
			];
			expect([...mine.unsafe].sort()).toEqual([...theirs.unsafe].sort());
			expect(mine.risky).toBe(theirs.risky);
		}
	});
});

describe("copies where whitespace carries meaning", () => {
	const indented = (pad: string) => body(7).map((l) => `${pad}${l.trim()}`);
	const literal = ["const k = `x`;"];

	it.each([
		"a.coffee",
		"a.hs",
		"a.unknownext",
	])("requires raw equality in %s", (name) => {
		const [a, b] = [`src/${name}`, `src/${name.replace("a.", "b.")}`];
		const files = [ctx(a, 10, indented("  ")), added(b, 3, indented("    "))];
		expect(copiesOf(files)).toEqual([]);
		expect(modelCopies(files)).toEqual([]);
		expect(accepts(forge(a, 10, 16, b, 3, 9), files)).toBe(false);
	});

	it("pairs a re-indented brace block until a literal opener shows", () => {
		const files = [
			ctx("src/a.ts", 10, indented("  ")),
			added("src/b.ts", 3, indented("    ")),
		];
		expect(accepts(copiesOf(files)[0] as Operation, files)).toBe(true);
		const inTarget = [
			files[0] as PushFile,
			added("src/b.ts", 3, [...indented("    "), ...literal]),
		];
		expect(copiesOf(inTarget)).toEqual([]);
		expect(accepts(forge("src/a.ts", 10, 16, "src/b.ts", 3, 9), inTarget)).toBe(
			false,
		);
		const inSource = [
			ctx("src/a.ts", 10, indented("  "), literal),
			files[1] as PushFile,
		];
		expect(copiesOf(inSource)).toEqual([]);
	});

	it("does not claim a copy whose regex literal differs in spacing", () => {
		const a = at(body(8), 3, "  const r = /a b/.test(s);");
		const files = [
			ctx("src/a.ts", 10, a),
			added("src/b.ts", 3, at(a, 3, "  const r = /a  b/.test(s);")),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(model(files).droppedClaims).toBe(0);
		expect(accepts(forge("src/a.ts", 10, 17, "src/b.ts", 3, 10), files)).toBe(
			false,
		);
	});
});

describe("copy floor cost", () => {
	const run = (kind: "ctx" | "add", lines: string[]) =>
		(kind === "ctx"
			? extractContextRuns("src/a.ts", hunk(1, 1, rows(" ", lines)))[0]
			: extractRuns("src/b.ts", hunk(0, 1, rows("+", lines))).added[0]) as Run;

	it("answers a flood of long-line blocks quickly", () => {
		const block = Array.from(
			{ length: 5 },
			(_, i) => `x${i} = '${"\\'".repeat(900)}'`,
		);
		const files = [
			ctx("src/ctx.ts", 10, block),
			...Array.from({ length: 50 }, (_, i) => added(`src/f${i}.ts`, 3, block)),
		];
		const started = performance.now();
		expect(copiesOf(files)).toEqual([]);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("keeps a 2000 line benign body fast", () => {
		const big = body(2000);
		const started = performance.now();
		const found = copiesOf([
			ctx("src/a.ts", 10, big),
			added("src/b.ts", 3, big),
		]);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(found).toHaveLength(1);
	});

	it("draws the budget before the floor, once per range", () => {
		const seed = {
			from: run("ctx", fn),
			to: run("add", fn),
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
		const files = [ctx("src/a.ts", 10, fn), added("src/b.ts", 3, fn)];
		expect(copiesOf(files)).toHaveLength(1);
		expect(copyQualifyCalls.count).toBe(before + 2);
	});

	it("scores a 2000 character line without a quadratic scan", () => {
		const line = `x = '${"\\'".repeat(995)}`;
		const started = performance.now();
		for (let i = 0; i < 300; i++) lineInformation(line);
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("agrees between the two floors", () => {
		const long = at(body(5), 1, `  const w = "${"y".repeat(520)}";`);
		const blocks: [string, string[]][] = [
			["a.ts", body(6)],
			["a.ts", body(3)],
			["a.ts", ["function f(a) {", "  return g(a) + h(a);", "}"]],
			["a.ts", ["const x = {", "  a: 1,", "  b: 2,", "  c: 3,", "};"]],
			["a.ts", Array.from({ length: 6 }, (_, i) => `// note number ${i}`)],
			["a.py", Array.from({ length: 6 }, (_, i) => `# note number ${i}`)],
			["a.ts", long],
		];
		for (const [name, lines] of blocks) {
			const hash = name.endsWith(".py");
			const source = extractContextRuns(
				`src/${name}`,
				hunk(1, 1, rows(" ", lines)),
			)[0];
			const matcher = copyBlockQualifies(source as Run, 0, lines.length);
			expect(floorHolds(lines, hash, hash)).toBe(matcher);
		}
		expect(floorHolds(long, false)).toBe(false);
	});
});

describe("regex literals and comment starts", () => {
	const lineAt = (text: string) => at(body(13), 6, text);
	const moved = (a: string, b: string, name = "b.ts") => [
		deleted("src/a.ts", 10, lineAt(a)),
		added(`src/${name}`, 3, lineAt(b)),
	];
	const relabeled = (op: Operation) => ({
		...op,
		exact: false,
		reviewWeight: 0,
		divergences: op.divergences.map((d) => ({
			...d,
			class: "comment-only" as const,
		})),
	});
	const pyLines = (text: string) =>
		Array.from({ length: 13 }, (_, i) =>
			i === 6 ? text : `    v${i} = compute(${i}) + offset`,
		);

	it.each([
		[
			"  const r = /'/.test(s) + ' // x', t = ok;",
			"  const r = /'/.test(s) + ' // x', t = evil;",
		],
		["  const r = /[ //a]/.test(input);", "  const r = /[ //b]/.test(input);"],
	])("classes a regex line edit as code, drops a relabel: %s", (a, b) => {
		const files = moved(a, b);
		const [op] = nonCopies(files);
		expect(classes(op)).toEqual(["code"]);
		expect(op?.reviewWeight).toBe(1);
		expect(verifyRelocation(relabeled(op as Operation), files)).toBe(false);
		const inCopy = [
			ctx("src/a.ts", 10, lineAt(a)),
			added("src/b.ts", 3, lineAt(b)),
		];
		const [copy] = copiesOf(inCopy);
		expect(classes(copy)).toEqual(["code"]);
		expect(accepts(relabeled(copy as Operation), inCopy)).toBe(false);
	});

	it.each([
		[
			"plain division before a comment",
			moved("  q = a / b; // note", "  q = a / b; // changed"),
			"comment-only",
			0,
			true,
		],
		[
			"a glued double slash",
			moved("  q = 1;//a", "  q = 1;//b"),
			"code",
			1,
			true,
		],
		[
			"a python trailing hash comment",
			[
				deleted("src/a.py", 10, pyLines("    x = 1  # note")),
				added("src/b.py", 3, pyLines("    x = 1  # changed")),
			],
			"code",
			1,
			true,
		],
		[
			"python floor division",
			[
				deleted("src/a.py", 10, pyLines("    q = t // n + f(1)")),
				added("src/b.py", 3, pyLines("    q = t // n + f(2)")),
			],
			"code",
			1,
			true,
		],
	])("classes %s", (_, files, cls, weight, holds) => {
		const [op] = nonCopies(files as PushFile[]);
		expect(classes(op)).toEqual([cls]);
		expect(op?.reviewWeight).toBe(weight);
		expect(verifyRelocation(op as Operation, files as PushFile[])).toBe(holds);
	});

	it("starts comments at the same index in both", () => {
		for (const line of [
			"x = 1; // note",
			"x = 1;// note",
			'const s = "a // b"; // tail',
			"const r = s.replace(/\\//g, '-');",
			"// whole line",
			"a = b / c;",
			"u = `http://x`; // note",
		])
			expect(matcherCommentStart(line)).toBe(checkerCommentStart(line));
	});
});

describe("copy matcher limits and policy", () => {
	it("cannot emit two copies over one target", () => {
		const files = [
			ctx("src/a.ts", 10, fn),
			ctx("src/c.ts", 20, fn),
			added("src/b.ts", 3, fn),
		];
		const targets = copiesOf(files).map(
			(op) => `${op.to[0]?.filename}:${op.to[0]?.startLine}`,
		);
		expect(targets).toHaveLength(1);
	});

	it("stops resolving chains once the budget runs dry", () => {
		const sources = (i: number) => body(14, `s${i}x`);
		const files = [
			...Array.from({ length: 8 }, (_, i) =>
				ctx(`src/s${i}.ts`, 10, sources(i)),
			),
			...Array.from({ length: 8 }, (_, i) =>
				added(`src/t${i}.ts`, 3, at(sources(i), 7, `  other(${i});`)),
			),
		];
		expect(copiesOf(files)).toHaveLength(8);
		const limited = copiesOf(files, { cells: 10 }).length;
		expect(limited).toBeGreaterThan(0);
		expect(limited).toBeLessThan(8);
	});

	it("reports a copy of a test file source with sourceNew false", () => {
		const files = [ctx("src/a.test.ts", 10, fn), added("src/b.ts", 3, fn)];
		const [op] = copiesOf(files);
		expect(op?.shape?.sourceNew).toBeUndefined();
		expect(accepts(op as Operation, files)).toBe(true);
	});
});
