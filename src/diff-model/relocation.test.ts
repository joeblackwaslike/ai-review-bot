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
	it("a re-indented move containing a single-line template literal reports a relocation without a full divergence list", () => {
		const base = fn(body(13));
		base.splice(5, 0, "  const label = `x`.repeat(2);");
		const head = base.map((line) => `    ${line}`);
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences).toEqual([]);
		expect(ops[0]?.exact).toBe(true);
	});

	it("still surfaces a changed multi-line template literal inside a re-indented move", () => {
		const base = [
			"export function banner() {",
			"  const a = compute(1);",
			"  const b = compute(2);",
			"  const text = `",
			"    hello   world",
			"  `;",
			"  const c = compute(3);",
			"  const d = compute(4);",
			"  const e = compute(5);",
			"  const f = compute(6);",
			"  return text + a + b + c + d + e + f;",
			"}",
		];
		const head = base.map((line) => `    ${line}`);
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(false);
		expect(ops[0]?.divergences.some((d) => d.original?.includes("hello"))).toBe(
			true,
		);
		expect(ops[0]?.divergences.length).toBeLessThan(base.length);
	});

	it("classes a changed continuation line starting with an asterisk as code", () => {
		const base = fn(body(30));
		base.splice(15, 0, "  * qty;");
		const head = withLine(base, 15, "  * qty * 2;");
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences).toHaveLength(1);
		expect(ops[0]?.divergences[0]?.class).toBe("code");
	});

	it("classes a changed line inside a block comment opened in the block as comment-only", () => {
		const base = fn(body(30));
		base.splice(15, 0, "  /*", "   * apply the discount", "   */");
		const head = withLine(base, 16, "   * apply discount");
		const ops = move(base, head);
		expect(ops[0]?.divergences).toHaveLength(1);
		expect(ops[0]?.divergences[0]?.class).toBe("comment-only");
	});

	it("does not report a shell continuation broken by trailing whitespace as exact", () => {
		const base = withLine(body(10), 4, "  cmd --flag \\");
		const head = withLine(base, 4, "  cmd --flag \\ ");
		const ops = findRelocations([
			deletedFrom("src/a.sh", 10, base),
			addedTo("src/b.sh", 3, head),
		]);
		expect(ops.some((op) => op.exact)).toBe(false);
	});

	it("widens a block over a changed signature line as one changed divergence", () => {
		const base = fn(body(30));
		const head = withLine(
			base,
			0,
			"export function applyDiscount(input, opts) {",
		);
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.from[0]).toMatchObject({ startLine: 10 });
		expect(ops[0]?.to[0]).toMatchObject({ startLine: 3 });
		expect(ops[0]?.divergences).toHaveLength(1);
		expect(ops[0]?.divergences[0]).toMatchObject({
			kind: "changed",
			class: "code",
			base: { startLine: 10, endLine: 10 },
			head: { startLine: 3, endLine: 3 },
		});
		expect(ops[0]?.divergences[0]?.original).toContain("applyDiscount(input)");
	});

	it("falls back to exact runs when the differing middle is too large to align", () => {
		const edge = body(6);
		const baseMiddle = Array.from({ length: 4001 }, (_, i) => `  b_${i}();`);
		const headMiddle = Array.from(
			{ length: 4001 },
			(_, i) => `  let h${i} = ${i} * 2;`,
		);
		const start = performance.now();
		const ops = move(
			[...edge, ...baseMiddle, ...edge.map((l) => `${l} // end`)],
			[...edge, ...headMiddle, ...edge.map((l) => `${l} // end`)],
		);
		expect(performance.now() - start).toBeLessThan(10_000);
		expect(ops.length).toBeGreaterThanOrEqual(2);
		expect(ops.every((op) => op.exact && op.divergences.length === 0)).toBe(
			true,
		);
	});

	it("does not class a change hidden past the tokenizer cap as a rename", () => {
		const pad = "x".repeat(2100);
		const line = (a: string, b: string) =>
			`  r = ${a}(1) + ${a}(2) + "${pad}" + ${b}();`;
		const base = withLine(fn(body(30)), 15, line("foo", "safe"));
		const head = withLine(base, 15, line("bar", "evil"));
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences).toHaveLength(1);
		expect(ops[0]?.divergences[0]?.class).toBe("code");
	});

	it("does not class a rename when only the head line exceeds the cap", () => {
		const base = withLine(fn(body(30)), 15, "  r = foo(1) + foo(2);");
		const head = withLine(
			base,
			15,
			`  r = bar(1) + bar(2);${" ".repeat(2100)}evil();`,
		);
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences.every((d) => d.class !== "rename")).toBe(true);
	});

	it("does not class a rename whose name also occurs past the cap on an unchanged line", () => {
		const long = `  keep(${"x".repeat(2100)}, foo(3));`;
		const base = fn(body(30));
		base.splice(2, 0, "  const foo = compute(0);");
		base.splice(12, 0, "  log(foo, 1);");
		base.splice(20, 0, long);
		const head = base.map((l) => (l === long ? l : l.replaceAll("foo", "bar")));
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences.every((d) => d.class === "code")).toBe(true);
	});

	it("still classes a short-line rename as rename", () => {
		const base = fn(body(30));
		base.splice(2, 0, "  const total = compute(0);");
		base.splice(12, 0, "  log(total, 1);");
		const head = base.map((l) => l.replaceAll("total", "sum"));
		const ops = move(base, head);
		expect(ops[0]?.divergences.every((d) => d.class === "rename")).toBe(true);
	});
});

function moveNamed(base: string[], head: string[], from: string, to: string) {
	return findRelocations([deletedFrom(from, 10, base), addedTo(to, 3, head)]);
}

function pair(
	base: string[],
	head: string[],
	at: number[],
): [string[], string[]] {
	const b = fn(body(30));
	const h = fn(body(30));
	at.forEach((index, k) => {
		b.splice(index, 0, base[k] as string);
		h.splice(index, 0, head[k] as string);
	});
	return [b, h];
}

describe("findRelocations class guards", () => {
	it("keeps a changed python floor-division line as code", () => {
		const [base, head] = pair(["  x = a // b"], ["  x = a // c"], [15]);
		const ops = moveNamed(base, head, "src/a.py", "src/b.py");
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences.map((d) => d.class)).toEqual(["code"]);
		expect(ops[0]?.reviewWeight).toBe(1);
	});

	it("keeps a changed python continuation line starting with // as code", () => {
		const [base, head] = pair(["        // b)"], ["        // c)"], [15]);
		const ops = moveNamed(base, head, "src/a.py", "src/b.py");
		expect(ops[0]?.divergences.map((d) => d.class)).toEqual(["code"]);
	});

	it("keeps a changed shell URL as code", () => {
		const [base, head] = pair(
			["  curl http://good.example.com/x"],
			["  curl http://evil.example.com/x"],
			[15],
		);
		const ops = moveNamed(base, head, "src/a.sh", "src/b.sh");
		expect(ops[0]?.divergences.map((d) => d.class)).toEqual(["code"]);
	});

	it("keeps a changed Makefile // line as code", () => {
		const [base, head] = pair(["  echo a // b"], ["  echo a // c"], [15]);
		const ops = moveNamed(base, head, "build/Makefile", "other/Makefile");
		expect(ops[0]?.divergences.map((d) => d.class)).toEqual(["code"]);
	});

	it("does not class a swap of two names as a rename", () => {
		const [base, head] = pair(
			["  f(a, b);", "  g(a, b);"],
			["  f(b, a);", "  g(b, a);"],
			[10, 20],
		);
		const ops = move(base, head);
		expect(ops[0]?.divergences.every((d) => d.class === "code")).toBe(true);
	});

	it("does not class a merge into an existing name as a rename", () => {
		const [base, head] = pair(
			["  f(a, b);", "  g(a, b);"],
			["  f(b, b);", "  g(b, b);"],
			[10, 20],
		);
		const ops = move(base, head);
		expect(ops[0]?.divergences.every((d) => d.class === "code")).toBe(true);
	});

	it("does not class two old names collapsing into one new name as a rename", () => {
		const [base, head] = pair(
			["  f(a, b);", "  g(a, b);"],
			["  f(c, c);", "  g(c, c);"],
			[10, 20],
		);
		const ops = move(base, head);
		expect(ops[0]?.divergences.every((d) => d.class === "code")).toBe(true);
	});

	it("does not class a literal flip as a rename", () => {
		const [base, head] = pair(
			["  done = true;", "  flag(true);"],
			["  done = false;", "  flag(false);"],
			[10, 20],
		);
		const ops = move(base, head);
		expect(ops[0]?.divergences.every((d) => d.class === "code")).toBe(true);
	});

	it("does not class a rename when the old name survives in the head block", () => {
		const [base, head] = pair(
			["  f(a);", "  g(a);", "  h(a);"],
			["  f(z);", "  g(z);", "  h(a);"],
			[8, 14, 20],
		);
		const ops = move(base, head);
		expect(ops[0]?.divergences.every((d) => d.class === "code")).toBe(true);
	});

	it("weighs a rename as one point per distinct renamed identifier", () => {
		const [base, head] = pair(
			["  f(alpha, beta);", "  g(alpha, beta);", "  h(alpha);"],
			["  f(first, second);", "  g(first, second);", "  h(first);"],
			[8, 14, 20],
		);
		const ops = move(base, head);
		expect(ops[0]?.divergences.every((d) => d.class === "rename")).toBe(true);
		expect(ops[0]?.reviewWeight).toBe(2);
	});
});

describe("findRelocations rename head guard", () => {
	it("does not class a rename when an inserted head line still uses the old name", () => {
		const [base, head] = pair(
			["  f(a);", "  g(a);"],
			["  f(z);", "  g(z);"],
			[8, 20],
		);
		head.splice(14, 0, "  k(a);");
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences.some((d) => d.class === "rename")).toBe(false);
	});
});
