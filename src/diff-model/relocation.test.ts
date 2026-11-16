import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { findRelocations } from "./relocation.js";

function pushFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function deletedFrom(filename: string, start: number, lines: string[]) {
	const patch = [
		`@@ -${start},${lines.length} +${start - 1},0 @@`,
		...lines.map((line) => `-${line}`),
	].join("\n");
	return pushFile(filename, patch);
}

function addedTo(filename: string, start: number, lines: string[]) {
	const patch = [
		`@@ -0,0 +${start},${lines.length} @@`,
		...lines.map((line) => `+${line}`),
	].join("\n");
	return pushFile(filename, patch);
}

function move(base: string[], head: string[]) {
	return findRelocations([
		deletedFrom("src/a.ts", 10, base),
		addedTo("src/b.ts", 3, head),
	]);
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

describe("findRelocations", () => {
	it("finds a 40-line function moved between files with no divergence", () => {
		const block = fn(body(40));
		const ops = move(block, block);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			type: "relocation",
			exact: true,
			divergences: [],
			from: [
				{ filename: "src/a.ts", side: "base", startLine: 10, endLine: 51 },
			],
			to: [{ filename: "src/b.ts", side: "head", startLine: 3, endLine: 44 }],
		});
	});

	it("reports one changed line inside a moved block as a changed divergence with the original text", () => {
		const base = withLine(
			fn(body(40)),
			21,
			"  const rate = Math.floor(price * pct);",
		);
		const head = withLine(base, 21, "  const rate = Math.round(price * pct);");
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(false);
		expect(ops[0]?.divergences).toHaveLength(1);
		const [divergence] = ops[0]?.divergences ?? [];
		expect(divergence).toMatchObject({ kind: "changed", class: "code" });
		expect(divergence?.original).toContain("Math.floor");
		expect(divergence?.base).toMatchObject({
			filename: "src/a.ts",
			side: "base",
			startLine: 31,
			endLine: 31,
		});
		expect(divergence?.head).toMatchObject({
			filename: "src/b.ts",
			side: "head",
			startLine: 24,
			endLine: 24,
		});
	});

	it("reports an inserted line and a removed line as divergences", () => {
		const base = fn(body(40));
		const head = [...base];
		head.splice(26, 0, "  audit(input);");
		head.splice(6, 1);
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		const kinds = ops[0]?.divergences.map((d) => d.kind).sort();
		expect(kinds).toEqual(["inserted", "removed"]);
		const inserted = ops[0]?.divergences.find((d) => d.kind === "inserted");
		expect(inserted?.head?.side).toBe("head");
		expect(inserted?.base).toBeUndefined();
		const removed = ops[0]?.divergences.find((d) => d.kind === "removed");
		expect(removed?.original).toContain("compute(5)");
		expect(removed?.base).toMatchObject({ side: "base", startLine: 16 });
		expect(removed?.head).toBeUndefined();
	});

	it("reports a deleted guard as a removed divergence", () => {
		const head = fn(body(30));
		const base = [...head];
		base.splice(10, 0, '  if (!input) throw new Error("missing input");');
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(false);
		expect(ops[0]?.divergences).toHaveLength(1);
		expect(ops[0]?.divergences[0]).toMatchObject({
			kind: "removed",
			class: "code",
		});
		expect(ops[0]?.divergences[0]?.original).toContain("missing input");
	});

	it("does not call a block unchanged when a template literal's inner whitespace changed", () => {
		const template = (gap: string) => [
			"export function banner() {",
			"  const a = compute(1);",
			"  const b = compute(2);",
			"  const text = `",
			`    hello${gap}world`,
			"    second line",
			"  `;",
			"  const c = compute(3);",
			"  const d = compute(4);",
			"  return text + a + b + c + d;",
			"}",
		];
		const ops = move(template("   "), template(" "));
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(false);
		expect(ops[0]?.divergences.some((d) => d.original?.includes("hello"))).toBe(
			true,
		);
	});

	it("reports a reformatted-only move as a relocation with no divergence", () => {
		const base = fn(body(20));
		const head = base.map((line) => `      ${line.replace(" = ", "  =   ")}`);
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ exact: true, divergences: [] });
	});

	it("ignores runs under 5 meaningful lines", () => {
		const block = fn(body(2));
		expect(move(block, block)).toEqual([]);
	});

	it("classes a consistent identifier substitution as a rename", () => {
		const base = fn(body(30));
		base.splice(2, 0, "  const total = compute(0);");
		base.splice(12, 0, "  log(total, 1);");
		base.splice(22, 0, "  return finalize(total);");
		const head = base.map((line) => line.replaceAll("total", "sum"));
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences).toHaveLength(3);
		expect(ops[0]?.divergences.every((d) => d.class === "rename")).toBe(true);
	});

	it("classes a changed comment as comment-only", () => {
		const base = fn(body(30));
		base.splice(15, 0, "  // apply the discount");
		const head = withLine(base, 15, "  // apply discount");
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences).toHaveLength(1);
		expect(ops[0]?.divergences[0]?.class).toBe("comment-only");
	});

	it("reports only the exact runs when too many lines differ", () => {
		const base = fn(body(40));
		let head = base;
		for (const index of [7, 14, 21, 28, 35]) {
			head = withLine(head, index, `  const edited${index} = other(${index});`);
		}
		const ops = move(base, head);
		expect(ops.length).toBeGreaterThan(1);
		expect(ops.every((op) => op.exact && op.divergences.length === 0)).toBe(
			true,
		);
	});
});
