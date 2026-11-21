import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { partialStatements } from "./partial-statements.fixture.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation } from "./relocation-check.js";
import type { Operation } from "./types.js";

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

	it("extends a moved block over the unchanged lines after a changed line near its end", () => {
		const base = withLine(
			fn(body(12)),
			10,
			"  const rate = Math.floor(price * pct);",
		);
		const head = withLine(base, 10, "  const rate = Math.round(price * pct);");
		const ops = move(base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			from: [{ startLine: 10, endLine: 23 }],
			to: [{ startLine: 3, endLine: 16 }],
		});
		expect(ops[0]?.divergences).toHaveLength(1);
	});

	it("extends a moved block backwards across a lone closing bracket before a changed line", () => {
		const guard = [
			"export function applyDiscount(input) {",
			"  if (input.free) {",
			"    return 0;",
			"  }",
			"  const base = input.price * input.qty;",
			"  const rate = Math.floor(base * input.pct);",
			...body(14),
			"}",
		];
		const head = withLine(
			guard,
			5,
			"  const rate = Math.round(base * input.pct);",
		);
		const ops = move(guard, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			from: [{ startLine: 10, endLine: 30 }],
			to: [{ startLine: 3, endLine: 23 }],
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

	describe("a guard at the edge of the moved block", () => {
		const guard = '  if (!input) throw new Error("missing input");';

		it("reports a deleted first-statement guard and spans the signature", () => {
			const head = fn(body(30));
			const base = [head[0] as string, guard, ...head.slice(1)];
			const ops = move(base, head);
			expect(ops).toHaveLength(1);
			expect(ops[0]).toMatchObject({
				exact: false,
				from: [{ startLine: 10, endLine: 10 + base.length - 1 }],
				to: [{ startLine: 3, endLine: 3 + head.length - 1 }],
			});
			expect(ops[0]?.divergences).toHaveLength(1);
			expect(ops[0]?.divergences[0]).toMatchObject({
				kind: "removed",
				class: "code",
				original: guard.trim(),
			});
		});

		it("reports a deleted last-statement guard and spans the closing brace", () => {
			const head = fn(body(30));
			const base = [...head.slice(0, -1), guard, "}"];
			const ops = move(base, head);
			expect(ops).toHaveLength(1);
			expect(ops[0]).toMatchObject({
				exact: false,
				from: [{ startLine: 10, endLine: 10 + base.length - 1 }],
				to: [{ startLine: 3, endLine: 3 + head.length - 1 }],
			});
			expect(ops[0]?.divergences).toHaveLength(1);
			expect(ops[0]?.divergences[0]).toMatchObject({
				kind: "removed",
				class: "code",
			});
		});

		it("reports an added first-statement guard as inserted", () => {
			const base = fn(body(30));
			const head = [base[0] as string, guard, ...base.slice(1)];
			const ops = move(base, head);
			expect(ops).toHaveLength(1);
			expect(ops[0]?.exact).toBe(false);
			expect(ops[0]?.divergences).toHaveLength(1);
			expect(ops[0]?.divergences[0]).toMatchObject({
				kind: "inserted",
				class: "code",
			});
		});
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

	it("ignores a run under 5 lines that carries too little information", () => {
		const block = ["  a++;", "  b++;", "  c++;", "  d++;"];
		expect(move(block, block)).toEqual([]);
	});

	it("accepts a run of 4 distinct lines that carries enough information", () => {
		const block = body(4);
		expect(move(block, block)).toHaveLength(1);
	});

	it("ignores 3 lines of import boilerplate and a short literal", () => {
		const imports = [
			'import { readFile } from "node:fs/promises";',
			'import { join } from "node:path";',
			'import { z } from "zod";',
		];
		const literal = ["const modes = [", '  "fast", "slow", "balanced",', "];"];
		expect(move(imports, imports)).toEqual([]);
		expect(move(literal, literal)).toEqual([]);
	});

	it("finds a 4-line function moved between files", () => {
		const block = fn(body(2));
		const ops = move(block, block);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ exact: true, divergences: [] });
	});

	it("reports a distinctive function signature that moved without its body", () => {
		const signature = [
			"export function reasoningProviderOptions(",
			"  selection: ModelSelection,",
			"): Record<string, Record<string, string>> | undefined {",
		];
		expect(move(signature, signature)).toHaveLength(1);
	});

	it("ignores a 3-line function too short to be distinctive", () => {
		const block = ["function id(x) {", "  return x;", "}"];
		expect(move(block, block)).toEqual([]);
	});

	it("finds a short Python def and a Ruby method", () => {
		const py = [
			"def wait(attempt, base=0.25):",
			"    delay = min(base * (2 ** attempt), MAX_DELAY)",
			"    return delay",
		];
		const ops = findRelocations([
			deletedFrom("a/util.py", 6, py),
			addedTo("a/client.py", 10, py),
		]);
		expect(ops).toHaveLength(1);
		const rb = [
			"def self.money(cents)",
			'  format("$%d.%02d", cents / 100, cents % 100)',
			"end",
		];
		expect(
			findRelocations([
				deletedFrom("a/fmt.rb", 7, rb),
				addedTo("a/cur.rb", 3, rb),
			]),
		).toHaveLength(1);
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

describe("findRelocations comment allowlist", () => {
	it.each([
		[
			"src/a.css",
			"src/b.css",
			"  background: url(http://a/x.png);",
			"  background: url(http://b/x.png);",
		],
		["docs/a.md", "docs/b.md", "  [docs](http://a)", "  [docs](http://b)"],
		[
			"web/a.html",
			"web/b.html",
			'  <a href="http://a/x">go</a>',
			'  <a href="http://b/x">go</a>',
		],
		[
			"notes/a.txt",
			"notes/b.txt",
			"  see http://a/x now",
			"  see http://b/x now",
		],
		["lib/a.zzz", "lib/b.zzz", "  see http://a/x now", "  see http://b/x now"],
		["db/a.sql", "db/b.sql", "  select 1 // a", "  select 1 // b"],
	])("keeps a changed // line in %s as code", (from, to, before, after) => {
		const [base, head] = pair([before], [after], [15]);
		const ops = moveNamed(base, head, from, to);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences.map((d) => d.class)).toEqual(["code"]);
	});

	it.each([
		["ts"],
		["go"],
		["java"],
	])("still classes a changed // comment in a .%s file as comment-only", (ext) => {
		const [base, head] = pair(["  // old note"], ["  // new note"], [15]);
		const ops = moveNamed(base, head, `src/a.${ext}`, `src/b.${ext}`);
		expect(ops[0]?.divergences.map((d) => d.class)).toEqual(["comment-only"]);
	});

	it("still classes a changed /* */ comment in a .css file as comment-only", () => {
		const [base, head] = pair(["  /* old */"], ["  /* new */"], [15]);
		const ops = moveNamed(base, head, "src/a.css", "src/b.css");
		expect(ops[0]?.divergences.map((d) => d.class)).toEqual(["comment-only"]);
	});
});

describe("findRelocations block comment allowlist", () => {
	it("keeps a changed /* */ line in a .md file as code", () => {
		const [base, head] = pair(["  /* old */"], ["  /* new */"], [15]);
		const ops = moveNamed(base, head, "docs/a.md", "docs/b.md");
		expect(ops[0]?.divergences.map((d) => d.class)).toEqual(["code"]);
	});
});

describe("findRelocations one-line declarations", () => {
	describe("one-line declarations", () => {
		function moveDeclaration(base: string, head: string) {
			const files = [
				deletedFrom("src/config.ts", 4, [base]),
				addedTo("src/limits.ts", 9, [head]),
			];
			return { ops: findRelocations(files), files };
		}

		it("finds a constant moved unchanged to another file", () => {
			const { ops, files } = moveDeclaration(
				"export const MAX_RETRIES = 3;",
				"export const MAX_RETRIES = 3;",
			);
			expect(ops).toHaveLength(1);
			expect(ops[0]).toMatchObject({
				type: "relocation",
				exact: true,
				divergences: [],
				from: [{ filename: "src/config.ts", startLine: 4, endLine: 4 }],
				to: [{ filename: "src/limits.ts", startLine: 9, endLine: 9 }],
			});
			expect(verifyRelocation(ops[0] as never, files)).toBe(true);
		});

		it("reports a moved constant whose value changed, with the original line", () => {
			const { ops, files } = moveDeclaration(
				"export const MAX_RETRIES = { count: 3, delay: 100 };",
				"export const MAX_RETRIES = { count: 30, delay: 100 };",
			);
			expect(ops).toHaveLength(1);
			expect(ops[0]?.exact).toBe(false);
			expect(ops[0]?.divergences).toHaveLength(1);
			expect(ops[0]?.divergences[0]).toMatchObject({
				kind: "changed",
				class: "code",
				original: "export const MAX_RETRIES = { count: 3, delay: 100 };",
			});
			expect(verifyRelocation(ops[0] as never, files)).toBe(true);
		});

		it("finds a moved type alias and a Python constant", () => {
			expect(
				moveDeclaration(
					"export type Cents = number;",
					"export type Cents = number;",
				).ops,
			).toHaveLength(1);
			const py = findRelocations([
				deletedFrom("app/a.py", 2, ["MAX_DELAY = 30.0"]),
				addedTo("app/b.py", 5, ["MAX_DELAY = 30.0"]),
			]);
			expect(py).toHaveLength(1);
			expect(py[0]?.exact).toBe(true);
		});

		it("ignores indented locals and names declared more than once", () => {
			expect(
				moveDeclaration(
					"  const result = compute();",
					"  const result = compute();",
				).ops,
			).toEqual([]);
			const twice = findRelocations([
				deletedFrom("src/a.ts", 1, ["export const LIMIT = 1;"]),
				deletedFrom("src/b.ts", 1, ["export const LIMIT = 2;"]),
				addedTo("src/c.ts", 1, ["export const LIMIT = 1;"]),
			]);
			expect(twice).toEqual([]);
		});

		it("ignores a declaration inside a prose file and a line that continues", () => {
			const doc = findRelocations([
				deletedFrom("src/a.ts", 1, ["const MAP: Record<"]),
				addedTo("docs/plan.md", 1, ["const MAP: Record<"]),
				deletedFrom("src/b.ts", 1, ["export const NOTE = 1;"]),
				addedTo("docs/plan.md", 5, ["export const NOTE = 1;"]),
			]);
			expect(doc).toEqual([]);
		});

		it("ignores a constant re-declared in the same file and a multi-line start", () => {
			expect(
				findRelocations([
					pushFile(
						"src/a.ts",
						"@@ -1,1 +1,1 @@\n-export const LIMIT = 1;\n+export const LIMIT = 2;",
					),
				]),
			).toEqual([]);
			expect(
				moveDeclaration("export const TABLE = {", "export const TABLE = {").ops,
			).toEqual([]);
		});
	});
});

describe("distinctiveness acceptance and same-file moves", () => {
	const statement =
		"  const subtotal = computeSubtotal(items, taxRate, shippingZone);";

	it("accepts a distinctive one-line statement moved between files", () => {
		const ops = move([statement], [statement]);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ exact: true, divergences: [] });
	});

	it("rejects a repeated line", () => {
		const files = [
			deletedFrom("src/a.ts", 10, [statement]),
			deletedFrom("src/c.ts", 10, [statement]),
			addedTo("src/b.ts", 3, [statement]),
		];
		expect(findRelocations(files)).toEqual([]);
	});

	it("rejects two identical short definitions", () => {
		const wide = [
			"function formatCurrency(amount, currency) {",
			"  return amount.toFixed(2) + currency;",
			"}",
		];
		const files = [
			deletedFrom("src/a.ts", 1, wide),
			deletedFrom("src/c.ts", 1, wide),
			addedTo("src/b.ts", 1, wide),
		];
		expect(findRelocations(files)).toEqual([]);
	});

	it("accepts a short unique definition of 30 to 39 characters", () => {
		const def = ["function areaOf(a, b) {", "  return a * b;", "}"];
		expect(move(def, def)).toHaveLength(1);
	});

	it("rejects a definition duplicated only on the added side", () => {
		const def = [
			"function formatCurrency(amount, currency) {",
			"  return amount.toFixed(2) + currency;",
			"}",
		];
		const files = [
			deletedFrom("src/a.ts", 1, def),
			addedTo("src/b.ts", 1, def),
			addedTo("src/c.ts", 1, def),
		];
		expect(findRelocations(files)).toEqual([]);
	});

	it("rejects a lone signature line and a lone Python def line", () => {
		const ts = ["export async function fetchEverythingFromTheServer("];
		expect(move(ts, ts)).toEqual([]);
		const py = ["def compute_the_total_with_offset(value, offset):"];
		expect(
			findRelocations([
				deletedFrom("a/util.py", 1, py),
				addedTo("a/client.py", 1, py),
			]),
		).toEqual([]);
	});

	it("accepts a one-line Python def with a body of at least 40 characters", () => {
		const py = [
			"def total_with_offset(value, offset): return value * 2 + offset + 1",
		];
		expect(
			findRelocations([
				deletedFrom("a/util.py", 1, py),
				addedTo("a/client.py", 1, py),
			]),
		).toHaveLength(1);
	});

	it("rejects a line of only Python keywords", () => {
		const lines = ["    return None", "    return None"];
		const long = ["  return None"];
		expect(move(long, long)).toEqual([]);
		expect(move(lines, lines)).toEqual([]);
	});

	it("accepts four identical lines in one run as one block", () => {
		const block = Array.from({ length: 4 }, () => `${statement}`);
		expect(move(block, block)).toHaveLength(1);
	});

	it("keeps the relocations found before the budget ran out and repeats them exactly", () => {
		const files = [1, 2, 3].flatMap((i) => {
			const line = `  const result${i} = computeSomething${i}(first, second, third);`;
			return [
				deletedFrom(`src/a${i}.ts`, 1, [line]),
				addedTo(`src/b${i}.ts`, 1, [line]),
			];
		});
		const full = findRelocations(files);
		expect(full).toHaveLength(3);
		const limited = findRelocations(files, { candidates: 1 });
		expect(limited).toHaveLength(1);
		expect(
			full.some(
				(op) => JSON.stringify(op.from) === JSON.stringify(limited[0]?.from),
			),
		).toBe(true);
		expect(findRelocations(files, { candidates: 1 })).toEqual(limited);
		expect(findRelocations(files, { tokens: 0 })).toEqual([]);
	});

	it("keeps accepting large seeds once the token pool is empty", () => {
		const block = body(8);
		expect(
			findRelocations(
				[deletedFrom("src/a.ts", 1, block), addedTo("src/b.ts", 1, block)],
				{ tokens: 0 },
			),
		).toHaveLength(1);
	});

	it("rejects an import line", () => {
		const line =
			'import { computeSubtotal, computeTax } from "./pricing/subtotal.js";';
		expect(move([line], [line])).toEqual([]);
	});

	it("rejects a bare literal line", () => {
		const line = '  "alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota",';
		expect(move([line], [line])).toEqual([]);
	});

	it("accepts a two-line definition", () => {
		const block = [
			"export function applyDiscount(input, rate) {",
			"  return input.price * rate; }",
		];
		const ops = move(block, block);
		expect(ops).toHaveLength(1);
	});

	it("reports a block moved within one file", () => {
		const block = body(2);
		const patch = [
			"@@ -1,4 +1,2 @@",
			...block.map((l) => `-${l}`),
			" context one",
			" context two",
			"@@ -40,3 +38,5 @@",
			" context three",
			...block.map((l) => `+${l}`),
			" context four",
			" context five",
		].join("\n");
		const files = [pushFile("src/a.ts", patch)];
		const ops = findRelocations(files);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.from[0]?.filename).toBe("src/a.ts");
		expect(ops[0]?.to[0]?.filename).toBe("src/a.ts");
		expect(verifyRelocation(ops[0] as never, files)).toBe(true);
	});

	it("does not report an in-place edit as a same-file move", () => {
		const block = body(2);
		const patch = [
			"@@ -1,2 +1,2 @@",
			...block.map((l) => `-${l}`),
			...block.map((l) => `+${l}`),
		].join("\n");
		expect(findRelocations([pushFile("src/a.ts", patch)])).toEqual([]);
	});

	it("reports a one-line declaration moved within one file", () => {
		const patch = [
			"@@ -1,3 +1,2 @@",
			"-export const MAX_RETRIES = 3;",
			" context one",
			" context two",
			"@@ -40,2 +39,3 @@",
			" context three",
			"+export const MAX_RETRIES = 3;",
			" context four",
		].join("\n");
		const ops = findRelocations([pushFile("src/a.ts", patch)]);
		expect(ops).toHaveLength(1);
	});

	it("does not report a one-line declaration deleted and re-added within one hunk", () => {
		const patch = [
			"@@ -1,5 +1,5 @@",
			"-export const MAX_RETRIES = 3;",
			" context one",
			" context two",
			"+export const MAX_RETRIES = 3;",
		].join("\n");
		expect(findRelocations([pushFile("src/a.ts", patch)])).toEqual([]);
	});

	it("does not pair a short same-file seed whose runs share one hunk", () => {
		const line =
			"  const subtotal = computeSubtotal(items, taxRate, shippingZone);";
		const patch = [
			"@@ -1,9 +1,9 @@",
			` context zero`,
			`-${line}`,
			" context one",
			" context two",
			" context three",
			`+${line}`,
		].join("\n");
		expect(findRelocations([pushFile("src/a.ts", patch)])).toEqual([]);
	});

	it("pairs a short same-file seed across two hunks", () => {
		const line =
			"  const subtotal = computeSubtotal(items, taxRate, shippingZone);";
		const patch = [
			"@@ -10,4 +10,3 @@",
			" context zero",
			`-${line}`,
			" context one",
			" context two",
			"@@ -40,3 +39,4 @@",
			" context three",
			`+${line}`,
			" context four",
			" context five",
		].join("\n");
		expect(findRelocations([pushFile("src/a.ts", patch)])).toHaveLength(1);
	});

	it("rejects a short same-file seed under 50 characters of information", () => {
		const line = "  return { ready: missing.length === 0, missing };";
		const patch = [
			"@@ -10,4 +10,3 @@",
			" context zero",
			`-${line}`,
			" context one",
			" context two",
			"@@ -40,3 +39,4 @@",
			" context three",
			`+${line}`,
			" context four",
			" context five",
		].join("\n");
		expect(findRelocations([pushFile("src/a.ts", patch)])).toEqual([]);
	});

	it("rejects a short seed that starts mid-expression", () => {
		const lines = ['  .split("\\n")', "  .find((l) => l.trim())"];
		expect(move(lines, lines)).toEqual([]);
	});

	it.each([
		["  .map((item) => item.registeredHandlerCount)", "  .filter(Boolean)"],
		["  ?.registeredHandlerCount.toString()", "  ?.trim()"],
		["  ?? loadRegisteredHandlerCount(config)", "  ?? 0"],
		["  ? registeredHandlerCount : fallbackHandlerCount", "  : 0"],
		["  => registeredHandlerCount(config, options)", "  => 1"],
		["  + computeRegisteredOffset(config, options)", "  + 1"],
		["  , registeredHandlerCount(config, options)", "  , 1"],
		["  && registeredHandlerCount(config, options)", "  && 1"],
		["  || registeredHandlerCount(config, options)", "  || 1"],
	])("rejects a short seed that continues an expression: %s", (first, second) => {
		const lines = [first, second];
		expect(move(lines, lines)).toEqual([]);
	});

	it("rejects two identical short Python definitions on the deleted side", () => {
		const def = [
			"def is_retryable_status(status):",
			"    return status >= 500 and status != 501",
		];
		const files = [
			deletedFrom("a.py", 1, def),
			deletedFrom("c.py", 1, def),
			addedTo("b.py", 1, def),
		];
		expect(findRelocations(files)).toEqual([]);
	});

	it.each([
		"package-lock.json",
		"pnpm-lock.yaml",
		"yarn.lock",
		"bun.lock",
		"Cargo.lock",
		"poetry.lock",
		"Gemfile.lock",
		"dist/app.min.js",
		"dist/app.min.css",
		"src/__snapshots__/a.test.ts.snap",
	])("ignores %s in relocation matching", (name) => {
		const lines = body(12);
		const patch = [
			"@@ -1,13 +1,1 @@",
			...lines.map((l) => `-${l}`),
			" context one",
			" context two",
			" context three",
			" context four",
			" context five",
			" context six",
			" context seven",
			" context eight",
			"@@ -60,3 +50,15 @@",
			" context nine",
			...lines.map((l) => `+${l}`),
		].join("\n");
		expect(findRelocations([pushFile(name, patch)])).toEqual([]);
		expect(
			findRelocations([
				deletedFrom(name, 1, lines),
				addedTo("src/b.ts", 1, lines),
			]),
		).toEqual([]);
		expect(findRelocations([pushFile("src/a.ts", patch)])).toHaveLength(1);
	});
});

describe("findRelocations statement continuation", () => {
	const hunk = (filename: string, rows: string[]) =>
		pushFile(filename, ["@@ -10,9 +10,9 @@", ...rows].join("\n"));
	const pairOf = (baseRows: string[], headRows: string[]) => [
		hunk("src/a.ts", baseRows),
		hunk("src/b.ts", headRows),
	];
	const loaded = "const approvedUserList = loadUsers(config)";

	it.each([
		[
			"a declaration followed by a continuation line in the context",
			["-const total = compute(a, b)", "   .map(wrap);"],
			["+const total = compute(a, b);", " context"],
		],
		[
			"a short block that lacks a terminator when a line follows",
			[`-${loaded}.length`, " other();"],
			[`+${loaded}.length`, " other();"],
		],
		[
			"a short block that ends in an operator",
			["-const approvedUserList = loadUsers(config) &&"],
			["+const approvedUserList = loadUsers(config) &&"],
		],
		[
			"a short block that ends in a backslash",
			["-total_amount_for_user = compute_amount(account) + \\"],
			["+total_amount_for_user = compute_amount(account) + \\"],
		],
	])("does not claim %s", (_, baseRows, headRows) => {
		expect(findRelocations(pairOf(baseRows, headRows))).toEqual([]);
	});

	it.each(partialStatements)("does not claim %s", (_, base, head, __, ext) => {
		const files = [hunk(`src/a.${ext}`, base), hunk(`src/b.${ext}`, head)];
		expect(findRelocations(files)).toEqual([]);
	});

	it("does not seed an else-if line that opens with a closer", () => {
		const closer = "} else if (user.isAdmin && flags.betaAccess) {";
		expect(move([closer], [closer])).toEqual([]);
	});
});

describe("findRelocations same-file uniqueness", () => {
	it("does not pair a repeated paragraph re-indented in two regions of one file", () => {
		const paragraph = body(5);
		const region = (name: string) => [
			` context ${name}`,
			...paragraph.map((l) => `-${l}`),
			...paragraph.map((l) => `+    ${l}`),
			" context end",
		];
		const patch = [
			"@@ -1,7 +1,7 @@",
			...region("a"),
			"@@ -30,7 +30,7 @@",
			...region("c"),
		].join("\n");
		expect(findRelocations([pushFile("src/a.ts", patch)])).toEqual([]);
	});
});

describe("findRelocations declaration pairing", () => {
	const one = (filename: string, sign: "-" | "+", text: string) =>
		pushFile(filename, ["@@ -5,1 +5,1 @@", `${sign}${text}`].join("\n"));

	it.each([
		[
			"same-named type aliases with unrelated bodies",
			"src/Button.tsx|type Props = { label: string };",
			"src/Card.tsx|type Props = { children: ReactNode; elevated: boolean };",
		],
		[
			"declarations across extension families",
			"src/limits.ts|export const MAX_ITEMS = 5;",
			"src/limits.go|const MAX_ITEMS = 5",
		],
		["a one-letter name", "src/a.ts|const i = 0;", "src/b.ts|const i = 0;"],
		[
			"a changed value sharing too little",
			"src/a.ts|const MAX = 5;",
			"src/b.ts|const MAX = buildLimit(config, defaults);",
		],
	])("does not pair %s", (_, base, head) => {
		const [baseName, baseText] = base.split("|") as [string, string];
		const [headName, headText] = head.split("|") as [string, string];
		const files = [one(baseName, "-", baseText), one(headName, "+", headText)];
		expect(findRelocations(files)).toEqual([]);
	});

	it("still claims a related declaration with a small change", () => {
		const base = "export const DEFAULTS = { retries: 3, timeout: 1000 };";
		const ops = findRelocations([
			one("src/a.ts", "-", base),
			one("src/b.ts", "+", base.replace("3", "5")),
		]);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(false);
	});
});

describe("findRelocations literal-risk files and declaration names", () => {
	const inTemplate = (
		open: string,
		sign: string,
		line: string,
		close: string,
	) =>
		["@@ -1,3 +1,3 @@", ` ${open}`, `${sign}${line}`, ` ${close}`].join("\n");
	const seed = '    const userDisplayNameForAccount = "first";';

	it.each([
		["a template literal", "const a = `start", "end`;", true],
		["no literal opener", "const a = start;", "end;", false],
	])("handles a short seed in a file with %s", (_, open, close, risky) => {
		const files = [
			pushFile("src/a.ts", inTemplate(open, "-", seed, close)),
			pushFile("src/b.ts", inTemplate(open, "+", seed.trimStart(), close)),
		];
		expect(findRelocations(files)).toHaveLength(risky ? 0 : 1);
	});

	it("stops discovery when the extension pool is empty", () => {
		const block = body(8);
		const files = [
			deletedFrom("src/a.ts", 1, block),
			addedTo("src/b.ts", 1, block),
		];
		expect(findRelocations(files)).toHaveLength(1);
		expect(findRelocations(files, { extensions: 0 })).toEqual([]);
	});

	it("counts a multi-line declaration against a one-line declaration of the same name", () => {
		const files = [
			deletedFrom("src/a.ts", 1, ["const LIMIT = {", "  n: 1,", "};"]),
			deletedFrom("src/b.ts", 1, ["const LIMIT = { n: 1 };"]),
			addedTo("src/c.ts", 1, ["const LIMIT = { n: 2 };"]),
		];
		expect(findRelocations(files)).toEqual([]);
	});
});

describe("findRelocations budget order", () => {
	it("caps operations by drawing one candidate per large seed", () => {
		const files = Array.from({ length: 10 }, (_, i) => {
			const block = body(5).map((l) => l.replace("v", `blk${i}v`));
			return [
				deletedFrom(`src/a${i}.ts`, 1, block),
				addedTo(`src/b${i}.ts`, 1, block),
			];
		}).flat();
		expect(findRelocations(files)).toHaveLength(10);
		expect(findRelocations(files, { candidates: 3 })).toHaveLength(3);
	});

	it("lets a later block through after earlier junk", () => {
		const junk = Array.from(
			{ length: 5 },
			(_, i) => `  const padding${i} = "${"x".repeat(39_950)}";`,
		);
		const real = body(7);
		const ops = findRelocations([
			deletedFrom("src/a.ts", 1, junk),
			addedTo("src/b.ts", 1, junk),
			deletedFrom("src/c.ts", 1, real),
			addedTo("src/d.ts", 1, real),
		]);
		expect(ops.some((op) => op.from[0]?.filename === "src/c.ts")).toBe(true);
	});
});

describe("findRelocations oversized lines", () => {
	it("skips a 160KB quote-and-backslash line quickly", () => {
		const text = `x = "${'\\"'.repeat(80_000)}`;
		const started = performance.now();
		const ops = move([text], [text]);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(ops).toEqual([]);
	});
});

describe("findRelocations budget exhaustion paths", () => {
	const short = "  const result1 = computeSomething1(first, second, third);";
	const reached = (ops: Operation[]) =>
		new Set(ops.map((op) => op.from[0]?.filename));

	function blocks(count: number): PushFile[] {
		return Array.from({ length: count }, (_, n) => {
			const base = body(14).map((l) => l.replace("v", `blk${n}v`));
			const head = base.map((l, i) =>
				i === 6
					? (base[7] as string)
					: i === 7
						? (base[8] as string)
						: i === 8
							? `  const added${n} = other(${n});`
							: l,
			);
			return [
				deletedFrom(`src/a${n}.ts`, 1, base),
				addedTo(`src/b${n}.ts`, 1, head),
			];
		}).flat();
	}

	it("stops resolving chains once the cells pool runs dry after the seeds", () => {
		const files = blocks(3);
		const limited = findRelocations(files, { cells: 16 });
		expect(reached(findRelocations(files)).has("src/a2.ts")).toBe(true);
		expect(reached(limited).has("src/a0.ts")).toBe(true);
		expect(reached(limited).has("src/a2.ts")).toBe(false);
	});

	it("keeps resolving chains when the seeds themselves ran dry", () => {
		const files = [
			deletedFrom("src/s1.ts", 1, [short]),
			addedTo("src/s2.ts", 1, [short]),
			...blocks(3),
		];
		const limited = findRelocations(files, { tokens: 0, cells: 16 });
		expect(reached(limited).has("src/a2.ts")).toBe(true);
	});

	it("skips the declaration pass once a short seed has exhausted the budget", () => {
		const declaration = ["export const LIMIT_KEY = { id: 1 };"];
		const files = [
			deletedFrom("src/s1.ts", 1, [short]),
			addedTo("src/s2.ts", 1, [short]),
			deletedFrom("src/c1.ts", 1, declaration),
			addedTo("src/c2.ts", 1, declaration),
		];
		expect(findRelocations(files)).toHaveLength(2);
		expect(findRelocations(files, { tokens: 0 })).toEqual([]);
	});

	it("claims a whole definition with no per-line information", () => {
		const definition = [
			"export default async function () {",
			'  return await import("./heavy/module/path.js");',
			"}",
		];
		const ops = move(definition, definition);
		expect(ops).toHaveLength(1);
		const files = [
			deletedFrom("src/a.ts", 10, definition),
			addedTo("src/b.ts", 3, definition),
		];
		expect(verifyRelocation(ops[0] as Operation, files)).toBe(true);
	});
});

describe("token pass integration", () => {
	it("finds a reformatted block after the line matcher and keeps its exact neighbor separate", () => {
		const exact = body(6);
		const wrapped =
			'const settings = { name: "alpha", retries: 3, timeout: 5000, verbose: false, region: "us-east" };';
		const reflowed = [
			"const settings = {",
			'  name: "alpha",',
			"  retries: 3,",
			"  timeout: 5000,",
			"  verbose: false,",
			'  region: "us-east",',
			"};",
		];
		const ops = move(
			[...exact, "// gap", wrapped],
			[...exact, "// gap", ...reflowed],
		);
		expect(ops.map((op) => op.exact)).toEqual([true, true]);
		expect(ops[0]?.to[0]).toMatchObject({ startLine: 3, endLine: 9 });
		expect(ops[1]?.to[0]).toMatchObject({ startLine: 10, endLine: 16 });
	});
});
