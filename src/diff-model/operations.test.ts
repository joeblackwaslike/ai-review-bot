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
			expect(performance.now() - start).toBeLessThan(2000);
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
		expect(performance.now() - start).toBeLessThan(1000);
	});
});
