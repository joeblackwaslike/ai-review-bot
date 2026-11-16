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
		const lines = ["a", "b", "c", "d", "e"];
		const ops = findRenames([
			file("src/old.ts", hunk(lines, []), { status: "removed" }),
			file("src/new.ts", hunk([], [...lines.slice(0, 4), "x"]), {
				status: "added",
			}),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ type: "rename", exact: false });
	});

	it("does not pair files below the similarity threshold", () => {
		const ops = findRenames([
			file("src/old.ts", hunk(["a", "b", "c", "d", "e"], []), {
				status: "removed",
			}),
			file("src/new.ts", hunk([], ["a", "x", "y", "z", "w"]), {
				status: "added",
			}),
		]);
		expect(ops).toEqual([]);
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
		const ts = file("src/a.ts", hunk([], ['import { x } from "./x.js";']));
		const py = file("a.py", hunk(["import os"], ["from os import path"]));
		expect(findMechanical([ts])).toHaveLength(1);
		expect(findMechanical([py])).toHaveLength(1);
	});

	it("does not report a hunk that mixes an import with code", () => {
		const patch = hunk([], ['import { x } from "./x.js";', "run();"]);
		expect(findMechanical([file("src/a.ts", patch)])).toEqual([]);
	});
});
