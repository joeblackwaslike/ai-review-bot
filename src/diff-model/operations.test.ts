import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { findMechanical, findRenames } from "./operations.js";

function file(
	filename: string,
	patch: string | undefined,
	extra: Partial<PushFile> = {},
): PushFile {
	return {
		filename,
		status: "modified",
		patch,
		additions: 0,
		deletions: 0,
		...extra,
	};
}

function hunk(deleted: string[], added: string[]): string {
	return [
		`@@ -1,${deleted.length} +1,${added.length} @@`,
		...deleted.map((l) => `-${l}`),
		...added.map((l) => `+${l}`),
	].join("\n");
}

describe("findRenames", () => {
	it("reports a status:renamed file with its previous name", () => {
		const ops = findRenames([
			file("src/new.ts", undefined, {
				status: "renamed",
				previous_filename: "src/old.ts",
			}),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			type: "rename",
			exact: true,
			from: [{ filename: "src/old.ts", side: "base" }],
			to: [{ filename: "src/new.ts", side: "head" }],
		});
	});

	it("reports a renamed file with no patch but changed content as inexact", () => {
		const ops = findRenames([
			file("src/new.ts", undefined, {
				status: "renamed",
				previous_filename: "src/old.ts",
				additions: 50,
			}),
		]);
		expect(ops[0]).toMatchObject({ type: "rename", exact: false });
		expect(ops[0]?.reviewWeight).toBeGreaterThan(0);
	});

	it("pairs a deleted and added file at similarity 0.6 or above", () => {
		const lines = ["alpha", "bravo", "charlie", "delta", "echo"];
		const ops = findRenames([
			file("src/old.ts", hunk(lines, []), { status: "removed" }),
			file("src/new.ts", hunk([], [...lines.slice(0, 4), "xray"]), {
				status: "added",
			}),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ type: "rename", exact: false });
	});

	it("does not call a re-indented unpaired rename identical", () => {
		const ops = findRenames([
			file(
				"billing/old.py",
				hunk(
					["gateway.charge(inv)", "gateway.refund(inv)", "gateway.void(inv)"],
					[],
				),
				{
					status: "removed",
				},
			),
			file(
				"billing/new.py",
				hunk(
					[],
					[
						"    gateway.charge(inv)",
						"gateway.refund(inv)",
						"gateway.void(inv)",
					],
				),
				{
					status: "added",
				},
			),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ type: "rename", exact: false });
	});

	it("calls an unpaired rename with identical ordered lines exact", () => {
		const lines = ["alpha", "  bravo", "charlie"];
		const ops = findRenames([
			file("src/old.ts", hunk(lines, []), { status: "removed" }),
			file("src/new.ts", hunk([], lines), { status: "added" }),
		]);
		expect(ops[0]).toMatchObject({ exact: true });
	});

	it("does not call a reordered unpaired rename identical", () => {
		const ops = findRenames([
			file("src/old.ts", hunk(["alpha", "bravo", "charlie"], []), {
				status: "removed",
			}),
			file("src/new.ts", hunk([], ["charlie", "bravo", "alpha"]), {
				status: "added",
			}),
		]);
		expect(ops[0]).toMatchObject({ exact: false });
	});

	it("does not pair files below the similarity threshold", () => {
		const ops = findRenames([
			file(
				"src/old.ts",
				hunk(["alpha", "bravo", "charlie", "delta", "echo"], []),
				{
					status: "removed",
				},
			),
			file(
				"src/new.ts",
				hunk([], ["alpha", "xray", "yankee", "zulu", "whiskey"]),
				{
					status: "added",
				},
			),
		]);
		expect(ops).toEqual([]);
	});
});

describe("findRenames exactness and pairing", () => {
	const body = [
		"const alpha = 1;",
		"const bravo = 2;",
		"const charlie = 3;",
		"const delta = 4;",
	];

	it("pairs identical content as an exact rename", () => {
		const ops = findRenames([
			file("src/old.ts", hunk(body, []), { status: "removed" }),
			file("src/new.ts", hunk([], body), { status: "added" }),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ exact: true, reviewWeight: 0 });
	});

	it("treats the deleted status like removed", () => {
		const ops = findRenames([
			file("src/old.ts", hunk(body, []), { status: "deleted" }),
			file("src/new.ts", hunk([], body), { status: "added" }),
		]);
		expect(ops).toHaveLength(1);
	});

	it("treats reversed lines as an inexact rename", () => {
		const ops = findRenames([
			file("src/old.ts", hunk(body, []), { status: "removed" }),
			file("src/new.ts", hunk([], [...body].reverse()), { status: "added" }),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(false);
		expect(ops[0]?.reviewWeight).toBeGreaterThanOrEqual(1);
	});

	it("treats a re-indented Python file as an inexact rename", () => {
		const py = ["def alpha():", "    return 1", "def bravo():", "    return 2"];
		const indented = py.map((l) =>
			l.startsWith(" ") ? `        ${l.trim()}` : l,
		);
		const ops = findRenames([
			file("old.py", hunk(py, []), { status: "removed" }),
			file("new.py", hunk([], indented), { status: "added" }),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(false);
		expect(ops[0]?.reviewWeight).toBeGreaterThanOrEqual(1);
	});

	it("does not pair tiny unrelated files", () => {
		const ops = findRenames([
			file("src/old.ts", hunk(["export {};"], []), { status: "removed" }),
			file("src/new.ts", hunk([], ["export {};"]), { status: "added" }),
		]);
		expect(ops).toEqual([]);
	});

	it("pairs at a similarity of exactly 0.6", () => {
		const five = [
			"alpha one",
			"bravo two",
			"charlie three",
			"delta four",
			"echo five",
		];
		const ops = findRenames([
			file("src/old.ts", hunk(five, []), { status: "removed" }),
			file(
				"src/new.ts",
				hunk([], [...five.slice(0, 3), "xray nine", "yankee ten"]),
				{
					status: "added",
				},
			),
		]);
		expect(ops).toHaveLength(1);
	});

	it("picks the best of two candidate deleted files", () => {
		const weak = [...body.slice(0, 3), "other one", "other two"];
		const ops = findRenames([
			file("src/weak.ts", hunk(weak, []), { status: "removed" }),
			file("src/strong.ts", hunk(body, []), { status: "removed" }),
			file("src/new.ts", hunk([], body), { status: "added" }),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.from[0]?.filename).toBe("src/strong.ts");
	});

	it("pairs one deleted file with only one of two added files", () => {
		const ops = findRenames([
			file("src/old.ts", hunk(body, []), { status: "removed" }),
			file("src/new-a.ts", hunk([], body), { status: "added" }),
			file("src/new-b.ts", hunk([], body), { status: "added" }),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.to[0]?.filename).toBe("src/new-a.ts");
	});

	it("pairs nothing beyond 200 deleted or added files", () => {
		const content = (i: number) =>
			Array.from({ length: 4 }, (_, k) => `const value${i}_${k} = ${k};`);
		const removed = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				file(`old${i}.ts`, hunk(content(i), []), { status: "removed" }),
			);
		const added = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				file(`new${i}.ts`, hunk([], content(i)), { status: "added" }),
			);
		expect(findRenames([...removed(201), ...added(1)])).toEqual([]);
		expect(findRenames([...removed(1), ...added(201)])).toEqual([]);
		expect(findRenames([...removed(200), ...added(1)])).toHaveLength(1);
	});

	it("finishes a many-file pairing quickly and deterministically", () => {
		const make = (prefix: string) =>
			Array.from({ length: 300 }, (_, i) => `const ${prefix}${i} = ${i};`);
		const build = (n: number) => [
			...Array.from({ length: n }, (_, i) =>
				file(`old${i}.ts`, hunk(make(`d${i}_`), []), { status: "removed" }),
			),
			...Array.from({ length: n }, (_, i) =>
				file(`new${i}.ts`, hunk([], make(`d${i}_`)), { status: "added" }),
			),
		];
		for (const n of [200, 300]) {
			const files = build(n);
			const start = performance.now();
			const first = findRenames(files);
			expect(performance.now() - start).toBeLessThan(3000);
			expect(findRenames(files)).toEqual(first);
		}
	});
});

describe("findMechanical", () => {
	it("reports a whitespace-only hunk only in a lexically safe file", () => {
		const patch = hunk(["    const a = 1;"], ["const a = 1;"]);
		expect(findMechanical([file("src/a.ts", patch)])).toHaveLength(1);
		expect(findMechanical([file("src/a.py", patch)])).toEqual([]);
	});

	it("does not report a whitespace change inside a template literal", () => {
		const patch = hunk(["const s = `a b`;"], ["const s = `a  b`;"]);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("reports an import-only hunk for TypeScript and Python", () => {
		const ts = file(
			"src/a.ts",
			hunk(
				['import { b } from "./b.js";', 'import { a } from "./a.js";'],
				["import {a} from './a.js'", "import { b } from './b.js'"],
			),
		);
		const py = file(
			"a.py",
			hunk(["import os", "import sys"], ["import sys", "import  os"]),
		);
		expect(findMechanical([ts])).toHaveLength(1);
		expect(findMechanical([py])).toHaveLength(1);
	});

	it("does not report a statement moved out of a block as whitespace-only", () => {
		const patch = "@@ -1,4 +1,4 @@\n if (x) {\n-  a();\n }\n+a();";
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report swapped statement order as whitespace-only", () => {
		const patch = "@@ -1,2 +1,2 @@\n-  first();\n second();\n+first();";
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report a whitespace change inside a regex literal", () => {
		const patch = hunk(["const r = /a  b/;"], ["const r = /a b/;"]);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("records whether a mechanical hunk is whitespace or imports", () => {
		const ws = findMechanical([
			file("src/a.ts", hunk(["    const a = 1;"], ["const a = 1;"])),
		]);
		const imp = findMechanical([
			file(
				"src/a.ts",
				hunk(
					['import { b } from "./b.js";', 'import { a } from "./a.js";'],
					['import { a } from "./a.js";', 'import { b } from "./b.js";'],
				),
			),
		]);
		expect(ws[0]?.reason).toBe("whitespace");
		expect(imp[0]?.reason).toBe("imports");
	});

	it("does not report a hunk that mixes an import with code", () => {
		const patch = hunk([], ['import { x } from "./x.js";', "run();"]);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report a reordered statement across a context line", () => {
		const patch = [
			"@@ -1,3 +1,3 @@",
			"-  guard();",
			" work();",
			"+guard();",
		].join("\n");
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report a value change or swapped statements", () => {
		expect(
			findMechanical([file("src/a.ts", hunk(["a = 1;"], ["a = 2;"]))]),
		).toEqual([]);
		expect(
			findMechanical([file("src/a.ts", hunk(["a();b();"], ["b();a();"]))]),
		).toEqual([]);
		expect(
			findMechanical([
				file("src/a.ts", hunk(["a();", "b();"], ["b();", "a();"])),
			]),
		).toEqual([]);
	});

	it("does not report whitespace in a file whose patch contains a backtick", () => {
		const patch = [
			"@@ -1,1 +1,1 @@",
			"-hello   world",
			"+hello world",
			"@@ -9,2 +9,2 @@",
			" const s = `",
			" more",
		].join("\n");
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report whitespace in a file whose patch contains a triple quote or heredoc", () => {
		for (const marker of ['"""', "cat <<EOF", "cat <<-'EOF'"]) {
			const patch = [
				"@@ -1,1 +1,1 @@",
				"-hello   world",
				"+hello world",
				"@@ -9,1 +9,1 @@",
				` ${marker}`,
			].join("\n");
			expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
		}
	});

	it("does not report a single changed line that gained an extra added line", () => {
		const patch = hunk(["  a();"], ["a();", "b();"]);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("treats an import line over 1000 characters as not an import", () => {
		const names = Array.from({ length: 200 }, (_, i) => `name${i}`);
		const long = (list: string[]) =>
			`import { ${list.join(", ")} } from "./x";`;
		const patch = hunk([long(names)], [long([...names].reverse())]);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report an import whose module was swapped", () => {
		const patch = hunk(
			['import { login } from "./auth";'],
			['import { login } from "./auth-stub";'],
		);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report an import whose imported names changed", () => {
		const patch = hunk(
			['import { login, logout } from "./auth";'],
			['import { login, session } from "./auth";'],
		);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report an added-only or removed-only import", () => {
		expect(
			findMechanical([
				file("src/a.ts", hunk([], ['import { x } from "./x";'])),
			]),
		).toEqual([]);
		expect(
			findMechanical([
				file("src/a.ts", hunk(['import { x } from "./x";'], [])),
			]),
		).toEqual([]);
	});

	it("reports a reordered and reformatted import specifier list", () => {
		const patch = hunk(
			['import { b, a } from "./x";'],
			["import {a,b} from './x'"],
		);
		expect(findMechanical([file("src/a.ts", patch)])).toHaveLength(1);
	});

	it("reports real export-from forms", () => {
		const patch = hunk(
			[
				'export * from "./a";',
				'export { b } from "./b";',
				'export type { T } from "./t";',
			],
			[
				"export type {T} from './t'",
				"export * from './a'",
				"export {b} from './b'",
			],
		);
		expect(findMechanical([file("src/a.ts", patch)])).toHaveLength(1);
	});

	it("does not treat a trailing from-comment as an import", () => {
		const patch = hunk(
			['export const q = run() // from "a"'],
			['export const q = run() // from "b"'],
		);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("matches an adversarial whitespace-padded import line in linear time", () => {
		const bad = `import "a"${" ".repeat(40_000)}x`;
		const start = performance.now();
		findMechanical([file("src/a.ts", hunk([bad], [`${bad}y`]))]);
		expect(performance.now() - start).toBeLessThan(3000);
	});

	it("does not report a space change inside a regex literal", () => {
		const patch = hunk(["x.split(/a  b/);"], ["x.split(/a b/);"]);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report whitespace changes in whitespace-significant prose files", () => {
		for (const name of ["a.md", "a.mdx", "a.txt", "a.rst", "a.adoc"]) {
			expect(findMechanical([file(name, hunk(["foo  "], ["foo"]))])).toEqual(
				[],
			);
		}
	});

	it("still reports a plain reindent and a trimmed-only line with a quote", () => {
		expect(
			findMechanical([
				file(
					"src/a.ts",
					hunk(["  run();", "  go();"], ["    run();", "    go();"]),
				),
			]),
		).toHaveLength(1);
		expect(
			findMechanical([
				file("src/a.ts", hunk(['  say("a  b");'], ['say("a  b");'])),
			]),
		).toHaveLength(1);
	});

	it("does not report whitespace on a line over 2000 characters, quickly", () => {
		const long = "a ".repeat(50_000);
		const start = performance.now();
		const ops = findMechanical([file("src/a.ts", hunk([` ${long}`], [long]))]);
		expect(performance.now() - start).toBeLessThan(3000);
		expect(ops).toEqual([]);
	});

	it("does not report reordered bare side-effect imports", () => {
		const patch = hunk(
			['import "./a";', 'import "./b";'],
			['import "./b";', 'import "./a";'],
		);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("does not report Python imports reordered across an unrelated statement", () => {
		const patch = [
			"@@ -1,3 +1,3 @@",
			"-import os",
			" setup()",
			"+import os",
		].join("\n");
		expect(findMechanical([file("a.py", patch)])).toEqual([]);
	});

	it("does not report a hunk that keeps one import and adds another", () => {
		const patch = hunk(["import a"], ["import a", "import b"]);
		expect(findMechanical([file("a.py", patch)])).toEqual([]);
	});

	it("does not report import type becoming a value import", () => {
		const patch = hunk(['import type {A} from "x";'], ['import {A} from "x";']);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});

	it("reports an import reorder with a blank line between, and not with a blank on one side only", () => {
		const a = 'import { a } from "./a";';
		const b = 'import { b } from "./b";';
		expect(
			findMechanical([file("src/a.ts", hunk([a, "", b], [b, a]))]),
		).toHaveLength(1);
		expect(
			findMechanical([file("src/a.ts", hunk([a, b], [b, "", a]))]),
		).toHaveLength(1);
		expect(
			findMechanical([file("src/a.ts", hunk([a, "", b], [b, "run();"]))]),
		).toEqual([]);
	});

	it("does not pair files whose lines are under 3 characters", () => {
		const tiny = ["a;", "b;", "c;", "d;", "e;"];
		const ops = findRenames([
			file("src/old.ts", hunk(tiny, []), { status: "removed" }),
			file("src/new.ts", hunk([], tiny), { status: "added" }),
		]);
		expect(ops).toEqual([]);
	});
});
