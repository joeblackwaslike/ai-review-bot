import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";
import { findRelocations } from "./relocation.js";

const count = 8000;

function side(filename: string, sign: "-" | "+", tag: string): PushFile {
	const rows = Array.from(
		{ length: count },
		(_, i) => `${sign}export const NAME_${i} = { id: ${i}, tag: "${tag}" };`,
	);
	const header =
		sign === "-" ? `@@ -1,${count} +0,0 @@` : `@@ -0,0 +1,${count} @@`;
	const patch = [header, ...rows].join("\n");
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

describe("buildDiffModel at scale", () => {
	it("verifies thousands of one-line declaration moves in linear time", () => {
		const files = [side("src/a.ts", "-", "a"), side("src/b.ts", "+", "b")];
		const started = performance.now();
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
		const elapsed = performance.now() - started;
		const relocations = model.operations.filter((o) => o.type === "relocation");
		expect(relocations.length).toBeGreaterThan(0);
		expect(relocations.length).toBeLessThanOrEqual(5000);
		expect(model.droppedClaims).toBe(0);
		expect(elapsed).toBeLessThan(3000);
	}, 5000);
});

describe("same-file matching at scale", () => {
	const side = (sign: string, lines: string[]) =>
		lines.map((l) => `${sign}${l}`);
	const scan = (patch: string) => {
		const files = [
			{
				filename: "src/a.ts",
				status: "modified",
				patch,
				additions: 0,
				deletions: 0,
			},
		];
		const started = performance.now();
		buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
		return performance.now() - started;
	};

	it("rejects a long run of one repeated line without a quadratic scan", () => {
		const shared = [...Array(20_000).fill("xxx"), "unique end line"];
		const tail = (tag: string) =>
			Array.from({ length: 20_000 }, (_, i) => `junk${tag} ${i}`);
		const patch = [
			"@@ -1,40001 +0,0 @@",
			...side("-", [...shared, ...tail("A")]),
			"@@ -300000,0 +1,40001 @@",
			...side("+", [...shared, ...tail("B")]),
		].join("\n");
		expect(scan(patch)).toBeLessThan(2000);
	});

	it("verifies thousands of five-line blocks that share a first line in bounded time", () => {
		const blocks = Array.from({ length: 6000 }, (_, i) => [
			"shared first line of every block",
			...[1, 2, 3, 4].map((k) => `  const part${k}_${i} = compute(${i});`),
		]);
		const hunks = (sign: string, list: string[][], at: number) =>
			list.flatMap((b, i) => [
				`@@ -${at + i * 9},${sign === "-" ? 5 : 0} +${at + i * 9},${sign === "+" ? 5 : 0} @@`,
				...side(sign, b),
			]);
		const patch = [
			...hunks("-", blocks, 1),
			...hunks("+", [...blocks].reverse(), 100000),
		].join("\n");
		expect(scan(patch)).toBeLessThan(5000);
	}, 20000);
});
