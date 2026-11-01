import { describe, expect, it } from "vitest";
import { repairSuggestion } from "./suggestion.js";

const file = new Map<number, string>([
	[8, "function run() {"],
	[9, "  const total = items.length;"],
	[10, "  if (total > 0) {"],
	[11, "    return total;"],
	[12, "  }"],
	[13, "  return 0;"],
	[14, "}"],
]);

const repair = (
	suggestion: string,
	line: number,
	startLine: number | null = null,
) => repairSuggestion({ suggestion, line, startLine, fileLines: file });

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

	it("strips pipe and colon line-number prefixes", () => {
		expect(
			repair("  11 |     return total + 1;\n  12 |   }", 12, 11)?.suggestion,
		).toBe("    return total + 1;\n  }");
		expect(repair("11:     return total + 1;", 11)?.suggestion).toBe(
			"    return total + 1;",
		);
	});

	it("keeps code that merely looks like a number label", () => {
		const s = "    return total + 1;\n  42: 1";
		expect(repair(s, 11)?.suggestion).toBe(s);
	});

	it("re-indents a suggestion that lost its indentation", () => {
		expect(repair("return total + 1;", 11)?.suggestion).toBe(
			"    return total + 1;",
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

	it("narrows the range when the suggestion drops the leading lines", () => {
		const out = repair("    return total;\n  } // end", 12, 10);
		expect(out?.startLine).toBe(11);
		expect(out?.line).toBe(12);
	});

	it("returns null when nothing aligns with the file", () => {
		expect(repair("zzz = qqq()", 11)).toBeNull();
	});
});
