import { describe, expect, it } from "vitest";
import { repairSuggestion } from "./suggestion.js";

const toMap = (lines: Record<number, string>) =>
	new Map<number, string>(
		Object.entries(lines).map(([n, text]) => [Number(n), text]),
	);

const file = toMap({
	8: "function run() {",
	9: "  const total = items.length;",
	10: "  if (total > 0) {",
	11: "    return total;",
	12: "  }",
	13: "  return 0;",
	14: "}",
});

const repair = (
	suggestion: string,
	line: number,
	startLine: number | null = null,
	fileLines = file,
) => repairSuggestion({ suggestion, line, startLine, fileLines });

describe("repairSuggestion", () => {
	it("leaves a suggestion that already fits untouched", () => {
		const s = "    return total + 1;";
		expect(repair(s, 11)).toEqual({
			suggestion: s,
			line: 11,
			startLine: null,
		});
	});

	it("strips a wrapping code fence", () => {
		expect(repair("```ts\n    return total + 1;\n```", 11)?.suggestion).toBe(
			"    return total + 1;",
		);
	});

	it("keeps fences when the replaced file lines are fences", () => {
		const md = toMap({ 5: "```ts", 6: "old();", 7: "```" });
		const s = "```ts\nnew();\n```";
		expect(repair(s, 7, 5, md)?.suggestion).toBe(s);
	});

	it("strips pipe and colon line-number prefixes", () => {
		expect(
			repair("  11 |     return total + 1;\n  12 |   }", 12, 11)?.suggestion,
		).toBe("    return total + 1;\n  }");
		expect(repair("11:     return total + 1;", 11)?.suggestion).toBe(
			"    return total + 1;",
		);
	});

	it("keeps a dict literal that looks like numbered lines", () => {
		const s = '1: "one",\n2: "two",';
		expect(repair(s, 11, 10)?.suggestion).toBe(`  ${s.replace("\n", "\n  ")}`);
	});

	it("keeps numeric mapping keys near the anchored lines when the file uses them", () => {
		const dict = toMap({
			1: "NUMBERS = {",
			2: '    1: "one",',
			3: '    2: "two",',
			4: "}",
		});
		const s = '    1: "uno",\n    2: "dos",';
		expect(repair(s, 3, 2, dict)?.suggestion).toBe(s);
	});

	it("still strips pipe prefixes in a file with numeric keys", () => {
		const dict = toMap({ 2: '    1: "one",' });
		expect(repair('2 |     1: "uno",', 2, null, dict)?.suggestion).toBe(
			'    1: "uno",',
		);
	});

	it("keeps numeric mapping keys introduced near the top of the file", () => {
		const top = toMap({ 1: "export const X = 5;" });
		const s = '1: "one",\n2: "two",';
		expect(repair(s, 1, null, top)?.suggestion).toBe(s);
	});

	it("still strips colon prefixes on numbered lines ending in , or {", () => {
		const sig = toMap({
			40: "function foo(",
			41: "  a,",
			42: ") {",
		});
		const s = "40: function foo(\n41:   a,\n42: ) {";
		expect(repair(s, 42, 40, sig)?.suggestion).toBe(
			"function foo(\n  a,\n) {",
		);
	});

	it("keeps a single numeric label far from the anchored line", () => {
		expect(repair("42: x", 10)?.suggestion).toBe("  42: x");
	});

	it("re-indents a suggestion that lost its indentation", () => {
		expect(repair("return total + 1;", 11)?.suggestion).toBe(
			"    return total + 1;",
		);
	});

	it("copies tab indentation verbatim", () => {
		const tabs = toMap({ 5: "\t\tfoo();" });
		expect(repair("bar();", 5, null, tabs)?.suggestion).toBe("\t\tbar();");
	});

	it("leaves a deliberate dedent alone", () => {
		expect(repair("  }", 11)?.suggestion).toBe("  }");
	});

	it("re-indents a multi-line block that lost its indentation", () => {
		const s = "if (total > 1) {\n  return total;\n}";
		expect(repair(s, 12, 10)?.suggestion).toBe(
			"  if (total > 1) {\n    return total;\n  }",
		);
	});

	it("leaves a column-0 line alone when the block keeps a replaced line verbatim", () => {
		const s = "export const MIN = 0;\n  if (total > MIN) {\n    return total;";
		expect(repair(s, 11, 10)?.suggestion).toBe(s);
	});

	it("leaves a dedent to column 0 that only changes indentation", () => {
		const py = toMap({ 4: "    retry = False" });
		expect(repair("retry = False", 4, null, py)?.suggestion).toBe(
			"retry = False",
		);
	});

	it("widens the range when the suggestion starts with the preceding line", () => {
		const s = "  if (total > 0) {\n    return total + 1;";
		expect(repair(s, 11)).toEqual({
			suggestion: s,
			line: 11,
			startLine: 10,
		});
	});

	it("does not widen when the intervening lines are not in the suggestion", () => {
		const s = "    return total;\n  return 1;";
		expect(repair(s, 13)).toEqual({ suggestion: s, line: 13, startLine: null });
	});

	it("keeps the range when the suggestion deletes its first line", () => {
		const del = toMap({
			10: "const obsolete = load();",
			11: "const retained = read();",
		});
		const s = "const retained = read();";
		expect(repair(s, 11, 10, del)).toEqual({
			suggestion: s,
			line: 11,
			startLine: 10,
		});
	});

	it("keeps the range when the suggestion deletes its last line", () => {
		const del = toMap({
			10: "const retained = read();",
			11: "logSensitiveData(retained);",
		});
		const s = "const retained = read();";
		expect(repair(s, 11, 10, del)).toEqual({
			suggestion: s,
			line: 11,
			startLine: 10,
		});
	});

	it("keeps the range when the suggestion deletes an edge line of three", () => {
		const del = toMap({
			10: "logSensitiveData();",
			11: "const result = compute();",
			12: "return result;",
		});
		const s = "const result = compute();\nreturn result;";
		expect(repair(s, 12, 10, del)).toEqual({
			suggestion: s,
			line: 12,
			startLine: 10,
		});
	});

	it("keeps the range when the suggestion hoists a line out of it", () => {
		const s = "    return total;\n  return 1;";
		expect(repair(s, 12, 10)).toEqual({
			suggestion: s,
			line: 12,
			startLine: 10,
		});
	});

	it("does not move the range on generic lines", () => {
		const generic = toMap({ 1: "foo();", 2: "break;", 3: "bar();" });
		const s = "break;\nbaz();";
		expect(repair(s, 3, null, generic)).toEqual({
			suggestion: s,
			line: 3,
			startLine: null,
		});
		const brace = toMap({ 1: "}", 2: "foo();", 3: "bar();" });
		const b = "}\nelse {";
		expect(repair(b, 2, null, brace)).toEqual({
			suggestion: b,
			line: 2,
			startLine: null,
		});
	});

	it("keeps a suggestion whose content differs from the file", () => {
		expect(repair("zzz = qqq()", 11)?.suggestion).toBe("    zzz = qqq()");
	});

	it("returns null when the anchored line is not in the file text", () => {
		expect(repair("x = 1;", 99)).toBeNull();
	});

	it("returns null when the range crosses lines missing from the file text", () => {
		const gap = toMap({ 3: "a();", 6: "b();" });
		expect(repair("c();", 6, 3, gap)).toBeNull();
	});

	it("returns null instead of widening across a hidden gap", () => {
		const hunks = toMap({
			1: "const first = one();",
			2: "const second = two();",
			3: "const third = applyConfiguration(second);",
			6: "const sixth = six();",
			7: "const seventh = seven();",
		});
		const s = "const third = applyConfiguration(second);\nconst sixth = fix();";
		expect(repair(s, 6, null, hunks)).toBeNull();
	});

	it("posts an empty fence as a deletion of the range", () => {
		expect(repair("```\n```", 12, 11)).toEqual({
			suggestion: "",
			line: 12,
			startLine: 11,
		});
	});

	it("posts a whitespace-only block as is, on the original range", () => {
		expect(repair("\n", 12, 11)).toEqual({
			suggestion: "\n",
			line: 12,
			startLine: 11,
		});
	});
});
