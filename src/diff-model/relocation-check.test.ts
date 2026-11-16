import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation } from "./relocation-check.js";
import type { Operation } from "./types.js";

function pushFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function moveFiles(base: string[], head: string[]): PushFile[] {
	return [
		pushFile(
			"src/a.ts",
			[`@@ -10,${base.length} +9,0 @@`, ...base.map((line) => `-${line}`)].join(
				"\n",
			),
		),
		pushFile(
			"src/b.ts",
			[`@@ -0,0 +3,${head.length} @@`, ...head.map((line) => `+${line}`)].join(
				"\n",
			),
		),
	];
}

function relocation(base: string[], head: string[]) {
	const files = moveFiles(base, head);
	const ops = findRelocations(files);
	expect(ops).toHaveLength(1);
	return { files, op: ops[0] as Operation };
}

function body(count: number): string[] {
	return Array.from(
		{ length: count },
		(_, i) => `  const v${i} = compute(${i}) + offset;`,
	);
}

function fn(lines: string[]): string[] {
	return ["export function applyDiscount(input) {", ...lines, "}"];
}

function withLine(lines: string[], index: number, text: string): string[] {
	return lines.map((line, i) => (i === index ? text : line));
}

function claimedClean(op: Operation): Operation {
	return { ...op, exact: true, divergences: [] };
}

describe("verifyRelocation", () => {
	it("accepts a clean move", () => {
		const block = fn(body(20));
		const { files, op } = relocation(block, block);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("accepts a reformatted-only move", () => {
		const block = fn(body(20));
		const { files, op } = relocation(
			block,
			block.map((line) => `    ${line}`),
		);
		expect(op.divergences).toEqual([]);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("accepts a re-indented move containing a single-line template literal", () => {
		const block = withLine(fn(body(20)), 5, `  const label = \`x \${v}\`;`);
		const { files, op } = relocation(
			block,
			block.map((line) => `    ${line}`),
		);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("accepts a move whose divergences are all listed", () => {
		const base = withLine(fn(body(30)), 10, "  const rate = Math.floor(p);");
		const changed = withLine(base, 10, "  const rate = Math.round(p);");
		const head = [
			...changed.slice(0, 20),
			"  audit(rate);",
			...changed.slice(20),
		];
		const { files, op } = relocation(base, head);
		expect(op.divergences.length).toBeGreaterThanOrEqual(2);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("rejects a claim that omits a changed line", () => {
		const base = fn(body(30));
		const head = withLine(base, 10, "  const rate = Math.round(p);");
		const { files, op } = relocation(base, head);
		expect(op.divergences).toHaveLength(1);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("rejects a template literal whose inner whitespace changed when the claim says unchanged", () => {
		const base = fn([
			...body(8),
			"  const sql = `",
			"    select id",
			"    from t",
			"  `;",
			...body(8),
		]);
		const head = withLine(base, 10, "        select id");
		const { files, op } = relocation(base, head);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("rejects a claim that omits a deleted guard", () => {
		const base = fn(body(30));
		const head = [...base.slice(0, 12), ...base.slice(13)];
		const { files, op } = relocation(base, head);
		expect(op.divergences.map((d) => d.kind)).toContain("removed");
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("rejects a listed divergence the lines do not support", () => {
		const block = fn(body(20));
		const { files, op } = relocation(block, block);
		const from = op.from[0] as Operation["from"][0];
		const to = op.to[0] as Operation["to"][0];
		const bogus: Operation = {
			...op,
			exact: false,
			divergences: [
				{
					kind: "changed",
					class: "code",
					base: { ...from, startLine: 12, endLine: 12 },
					head: { ...to, startLine: 5, endLine: 5 },
				},
			],
		};
		expect(verifyRelocation(bogus, files)).toBe(false);
	});

	it("rejects a reordered block claimed clean", () => {
		const block = fn(body(20));
		const swapped = block.map((line, i) =>
			i === 5 ? (block[6] as string) : i === 6 ? (block[5] as string) : line,
		);
		const { files, op } = relocation(block, swapped);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("rejects a changed string-literal interior claimed clean", () => {
		const base = withLine(fn(body(20)), 5, '  const s = "a  b";');
		const head = withLine(base, 5, '  const s = "a b";');
		const { files, op } = relocation(base, head);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("accepts a re-indented line that contains a string", () => {
		const block = withLine(fn(body(20)), 5, '  const s = "a  b";');
		const { files, op } = relocation(
			block,
			block.map((line) => `    ${line}`),
		);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("rejects x + +y changed to x ++y claimed clean", () => {
		const base = withLine(fn(body(20)), 5, "  const z = x + +y;");
		const head = withLine(base, 5, "  const z = x ++y;");
		const { files, op } = relocation(base, head);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});
});
