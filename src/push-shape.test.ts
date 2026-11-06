import { describe, expect, it } from "vitest";
import type { PushFile } from "./moved-blocks.js";
import {
	classifyFile,
	classifyPush,
	type FileKind,
	shapedBudget,
} from "./push-shape.js";

function file(over: Partial<PushFile> & { filename: string }): PushFile {
	return {
		status: "modified",
		additions: 0,
		deletions: 0,
		patch: "@@ -1 +1 @@\n-a\n+b",
		...over,
	};
}

function addPatch(lines: string[]): string {
	return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
}

function delPatch(lines: string[]): string {
	return `@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => `-${l}`).join("\n")}`;
}

describe("classifyFile", () => {
	const table: [string, FileKind][] = [
		["src/a.ts", "code"],
		["src/a.test.ts", "test"],
		["tests/x.ts", "test"],
		["README.md", "docs"],
		["docs/x.md", "docs"],
		["package.json", "config"],
		["tsconfig.json", "config"],
		[".github/dependabot.yml", "config"],
		["Dockerfile", "infra"],
		[".github/workflows/ci.yml", "infra"],
		["main.tf", "infra"],
		["scripts/run.sh", "shell"],
		["pnpm-lock.yaml", "lockfile"],
		["logo.png", "binary"],
		["dist/app.min.js", "generated"],
	];
	for (const [name, kind] of table) {
		it(`${name} is ${kind}`, () => {
			expect(classifyFile(name, true)).toBe(kind);
		});
	}
});

describe("classifyPush", () => {
	const lines = (n: number, p = "line") =>
		Array.from({ length: n }, (_, i) => `${p} number ${i}`);

	it("weighs docs, code and lockfile changes by kind", () => {
		const w = (filename: string) =>
			classifyPush([
				file({ filename, additions: 20, patch: addPatch(lines(20)) }),
			]).reviewableWeight;
		expect(w("README.md")).toBeCloseTo(6);
		expect(w("src/a.ts")).toBe(20);
		expect(w("pnpm-lock.yaml")).toBe(0);
	});

	it("flags whitespace-only changes at weight 0", () => {
		const shape = classifyPush([
			file({
				filename: "src/a.ts",
				additions: 1,
				deletions: 1,
				patch: "@@ -1 +1 @@\n-const  a = 1;\n+const a =   1;",
			}),
		]);
		expect(shape.files[0]?.whitespaceOnly).toBe(true);
		expect(shape.reviewableWeight).toBe(0);
	});

	it("weighs a pure rename at 0", () => {
		const shape = classifyPush([
			file({
				filename: "src/b.ts",
				status: "renamed",
				previous_filename: "src/a.ts",
				patch: undefined,
			}),
		]);
		expect(shape.files[0]?.renameOnly).toBe(true);
		expect(shape.reviewableWeight).toBe(0);
	});

	it("counts deletion-only files at kind weight times deleted lines", () => {
		const shape = classifyPush([
			file({ filename: "src/a.ts", deletions: 40, patch: delPatch(lines(40)) }),
		]);
		expect(shape.files[0]?.deletionOnly).toBe(true);
		expect(shape.reviewableWeight).toBe(40);
	});

	it("subtracts moved lines from the destination's additions", () => {
		const block = lines(10, "moved statement");
		const shape = classifyPush([
			file({
				filename: "src/old.ts",
				deletions: 10,
				patch: delPatch(block),
			}),
			file({
				filename: "src/new.ts",
				additions: 20,
				patch: addPatch([...block, ...lines(10, "fresh")]),
			}),
		]);
		expect(shape.moved).toHaveLength(1);
		expect(shape.reviewableWeight).toBe(20);
	});

	it("separates file count from weight", () => {
		const many = classifyPush(
			Array.from({ length: 20 }, (_, i) =>
				file({
					filename: `src/f${i}.ts`,
					additions: 2,
					patch: addPatch(lines(2, `f${i}`)),
				}),
			),
		);
		const one = classifyPush([
			file({ filename: "src/x.ts", additions: 40, patch: addPatch(lines(40)) }),
		]);
		expect(many.reviewableWeight).toBe(40);
		expect(one.reviewableWeight).toBe(40);
		expect(many.fileCount).toBe(20);
		expect(one.fileCount).toBe(1);
	});

	it("does not throw on a missing patch", () => {
		const shape = classifyPush([
			file({ filename: "src/big.ts", additions: 5000, patch: undefined }),
		]);
		expect(shape.reviewableWeight).toBe(0);
	});
});

describe("shapedBudget", () => {
	const budget = (weight: number, band: number) =>
		shapedBudget(
			{ files: [], reviewableWeight: weight, fileCount: 0, moved: [] },
			band,
		);
	it("clamps ceil(weight / 8) between 2 and the band", () => {
		expect(budget(0, 10)).toBe(2);
		expect(budget(40, 10)).toBe(5);
		expect(budget(400, 5)).toBe(5);
		expect(budget(3, 10)).toBe(2);
	});
});
