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
import { floorHolds, patchEligible, verifyCopy } from "./copy-check.js";
import { copyEligible } from "./file-kinds.js";
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

describe("copy file eligibility", () => {
	const none = (a: string, b: string, source: string[], target = fn) => {
		const files = [ctx(a, 10, source), added(b, 3, target)];
		expect(copiesOf(files)).toEqual([]);
		expect(modelCopies(files)).toEqual([]);
		expect(accepts(forge(a, 11, 19, b, 3, 11), files)).toBe(false);
	};

	it("still copies a clean ts and a clean python block", () => {
		const py = Array.from(
			{ length: 7 },
			(_, i) => `    v${i} = compute(${i}) + offset`,
		);
		for (const [a, b, lines] of [
			["src/a.ts", "src/b.ts", fn],
			["src/a.py", "src/b.py", py],
		] as const) {
			const files = [ctx(a, 10, [...lines]), added(b, 3, [...lines])];
			expect(modelCopies(files)).toHaveLength(1);
			expect(accepts(copiesOf(files)[0] as Operation, files)).toBe(true);
		}
	});

	it.each([
		["a backtick", "const t = `"],
		["a block comment opener", "/* header"],
		["a stray block comment closer", " */"],
		["a docstring", "x = DQ3"],
		["a triple single quote", "x = SQ3"],
		["a heredoc", "cat <<EOF"],
		["an html comment", "<!-- note"],
		["an html comment closer", "end -->"],
		["a trailing backslash", "x = a + \\"],
		["a ruby percent literal", "%q(abc"],
		["a ruby block comment", "=begin"],
		["a haskell comment", "{- note"],
		["a lua comment", "--[[ note"],
		["an ml comment", "(* note"],
		["a regex with a quote and a template", "const re = /'/; const t = `"],
		["a regex class and a block comment", "const re = /[ //]/; /*"],
		["an odd apostrophe", "if (s) /'/.test(s) + ' // x', t = ok;"],
		["an odd double quote", 'let s = "it;'],
	])("skips a file with %s", (_, marker) => {
		none("src/a.ts", "src/b.ts", [
			marker.replace("DQ3", '"' + '""').replace("SQ3", "'" + "''"),
			...fn,
		]);
	});

	it("skips a raw string opener", () => {
		none("src/a.ts", "src/b.ts", ['x = R"(', ...fn]);
	});

	it.each([
		"const t = `",
		"/* header",
		"x = 'a",
	])("skips a target holding %s", (marker) => {
		const files = [
			ctx("src/a.ts", 10, fn),
			added("src/b.ts", 3, [marker, ...fn]),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(accepts(forge("src/a.ts", 10, 18, "src/b.ts", 4, 12), files)).toBe(
			false,
		);
	});

	it("skips jsx text with an apostrophe before an opener", () => {
		none("src/a.tsx", "src/b.tsx", ["<p>don't</p>; const t = `", ...fn]);
	});

	it.each([
		"a.html",
		"a.lua",
		"a.hs",
		"a.ml",
		"a.rb",
		"a.rs",
		"a.sh",
		"a.sql",
		"a.cpp",
		"a.swift",
		"a.c",
	])("gives %s no copy claims", (name) => {
		none(`src/${name}`, `src/${name.replace("a.", "b.")}`, fn);
	});

	it("skips a file whose backticks cancel across three hunks", () => {
		const hunks = [10, 30, 50].map((start) =>
			hunk(start, start, rows(" ", ["const t = `x`;", ...fn])),
		);
		const files = [
			file("src/a.ts", hunks.join("\n")),
			added("src/b.ts", 3, fn),
		];
		expect(copiesOf(files)).toEqual([]);
		expect(accepts(forge("src/a.ts", 11, 19, "src/b.ts", 3, 11), files)).toBe(
			false,
		);
	});

	it("skips a file whose hunk starts inside a comment", () => {
		none("src/a.ts", "src/b.ts", [" */", ...fn]);
	});

	it("skips a file whose only apostrophes sit inside a trailing comment", () => {
		none("src/a.ts", "src/b.ts", [
			...fn.slice(0, 4),
			"  // don't change this",
			...fn.slice(4),
		]);
	});

	it("rejects whole comment blocks, keeps one comment among code", () => {
		const license = Array.from(
			{ length: 7 },
			(_, i) => `// Copyright line ${i} of the license header`,
		);
		const files = [ctx("src/a.ts", 10, license), added("src/b.ts", 3, license)];
		expect(copiesOf(files)).toEqual([]);
		expect(accepts(forge("src/a.ts", 10, 16, "src/b.ts", 3, 9), files)).toBe(
			false,
		);
		const mixed = at(body(7), 3, "  // keep this note");
		const kept = [ctx("src/a.ts", 10, mixed), added("src/b.ts", 3, mixed)];
		expect(accepts(copiesOf(kept)[0] as Operation, kept)).toBe(true);
	});

	it("applies the same file rule in the matcher and the checker", () => {
		const patches = [
			hunk(1, 1, rows(" ", fn)),
			hunk(1, 1, rows(" ", ["const t = `", ...fn])),
			hunk(1, 1, rows(" ", ["x = 'a", ...fn])),
			hunk(1, 1, rows(" ", ['x = "it\\"s"', ...fn])),
			hunk(1, 1, rows(" ", ["x = a \\", ...fn])),
			"@@ -1,1 +1,1 @@ it's a header\n x",
		];
		for (const name of ["a.ts", "a.py", "a.rs", "a.go"])
			for (const patch of patches)
				expect(patchEligible(name, patch)).toBe(copyEligible(name, patch));
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
		expect(performance.now() - started).toBeLessThan(3000);
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

	const variants: [string, string, string][] = [
		["if (s)", "ts", "  if (s) /'/.test(s) + ' // x', t = ok;"],
		["else", "ts", "  else /'/.test(s) + ' // x', t = ok;"],
		["yield", "ts", "  yield /'/.test(s) + ' // x', t = ok;"],
		["for", "ts", "  for (;;) /'/.test(s) + ' // x', t = ok;"],
		["while", "ts", "  while (s) /'/.test(s) + ' // x', t = ok;"],
		["assignment", "ts", "  const r = /'/.test(s) + ' // x', t = ok;"],
		["class", "ts", "  const r = /[ //a]/.test(input), t = ok;"],
		["rust", "rs", "  let r: &'a str = \"it's // y\"; let t = ok;"],
		["swift", "swift", '  let r = /\'/; let s = "a // b"; let t = ok;'],
	];

	it.each(
		variants,
	)("classes a %s line edit as code and drops a relabel", (_, ext, a) => {
		const b = a.replace("ok", "evil");
		const files = [
			deleted(`src/a.${ext}`, 10, lineAt(a)),
			added(`src/b.${ext}`, 3, lineAt(b)),
		];
		const [op] = nonCopies(files);
		expect(classes(op)).toEqual(["code"]);
		expect(op?.reviewWeight).toBe(1);
		expect(verifyRelocation(relabeled(op as Operation), files)).toBe(false);
		const inCopy = [
			ctx(`src/a.${ext}`, 10, lineAt(a)),
			added(`src/b.${ext}`, 3, lineAt(b)),
		];
		for (const copy of copiesOf(inCopy))
			expect(classes(copy)).toEqual(["code"]);
		const span = (name: string, n: number) => ({
			filename: name,
			side: "head" as const,
			startLine: n,
			endLine: n,
			shown: "full" as const,
		});
		const lie = {
			...forge(`src/a.${ext}`, 10, 22, `src/b.${ext}`, 3, 15),
			exact: false,
			divergences: [
				{
					kind: "changed" as const,
					class: "comment-only" as const,
					base: span(`src/a.${ext}`, 16),
					head: span(`src/b.${ext}`, 9),
				},
			],
		};
		expect(accepts(lie, inCopy)).toBe(false);
	});

	it.each([
		[
			"plain division before a comment",
			moved("  q = a / b; // note", "  q = a / b; // changed"),
			"code",
			1,
			true,
		],
		[
			"a call before a comment",
			moved("  foo(x); // note", "  foo(x); // changed"),
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
