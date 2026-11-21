import { describe, expect, it } from "vitest";
import { newlineClass, normalizeTokens, tokenize } from "./tokens.js";

const toks = (lines: string[], file: string) => tokenize(lines, file).tokens;

describe("tokenize", () => {
	it("tells a + ++b from a++ + b", () => {
		expect(toks(["a + ++b"], "x.ts")).toEqual(["a", "+", "++", "b"]);
		expect(toks(["a++ + b"], "x.ts")).toEqual(["a", "++", "+", "b"]);
	});

	it("drops line breaks in a free-newline file", () => {
		expect(toks(["foo(", "  1,", ")"], "x.ts")).toEqual([
			"foo",
			"(",
			"1",
			",",
			")",
		]);
	});

	it("keeps the line break after return", () => {
		expect(toks(["return", "x;"], "x.ts")).toEqual(["return", "\n", "x", ";"]);
	});

	it("keeps line breaks outside brackets in Python", () => {
		expect(toks(["a = 1", "b = 2"], "x.py")).toEqual([
			"a",
			"=",
			"1",
			"\n",
			"b",
			"=",
			"2",
		]);
	});

	it("joins a Black-wrapped call into one logical line", () => {
		const wrapped = toks(
			["x = foo(", "    a,", "    b,", ")", "y = 1"],
			"x.py",
		);
		const flat = toks(["x = foo(a, b,)", "y = 1"], "x.py");
		expect(wrapped).toEqual(flat);
		expect(wrapped.filter((t) => t === "\n")).toHaveLength(1);
	});

	it("treats an unknown extension as line-significant", () => {
		expect(newlineClass("Makefile")).toBe("significant");
		expect(newlineClass("a.weird")).toBe("significant");
		expect(newlineClass("a.TSX")).toBe("free");
		expect(toks(["a", "b"], "a.weird")).toEqual(["a", "\n", "b"]);
	});

	it("maps tokens back to source lines", () => {
		const r = tokenize(["a(", "b", ")", "c"], "x.py");
		expect(r.tokens).toEqual(["a", "(", "b", ")", "\n", "c"]);
		expect(r.lineOf).toEqual([0, 0, 1, 2, 2, 3]);
	});

	it("does not tokenize a // inside a string as a comment", () => {
		expect(toks(['const u = "http://x"; // note'], "x.ts")).toEqual([
			"const",
			"u",
			"=",
			'"http://x"',
			";",
		]);
	});

	it("drops hash comments in Python but not inside strings", () => {
		expect(toks(['a = "#x"  # c'], "x.py")).toEqual(["a", "=", '"#x"']);
	});
});

describe("normalizeTokens", () => {
	it("ignores a trailing comma before a closing bracket", () => {
		const a = normalizeTokens(toks(["f(a, b,)"], "x.ts"), "x.ts");
		const b = normalizeTokens(toks(["f(a, b)"], "x.ts"), "x.ts");
		expect(a).toEqual(b);
	});

	it("drops a trailing semicolon only in the JS family", () => {
		expect(normalizeTokens(toks(["a = 1;"], "x.ts"), "x.ts")).toEqual([
			"a",
			"=",
			"1",
		]);
		expect(normalizeTokens(toks(["a = 1;"], "x.java"), "x.java")).toContain(
			";",
		);
	});

	it("swaps quote style in TypeScript", () => {
		expect(normalizeTokens(["'a'"], "x.ts")).toEqual(['"a"']);
		expect(normalizeTokens(["'it\"s'"], "x.ts")).toEqual(["'it\"s'"]);
		const interpolated = `'$${"{"}x}'`;
		expect(normalizeTokens([interpolated], "x.ts")).toEqual([interpolated]);
	});

	it("keeps quote style in Ruby", () => {
		expect(normalizeTokens(["'a'"], "x.rb")).toEqual(["'a'"]);
	});

	it("never touches a Python string with a letter prefix", () => {
		const t = toks(["x = f'a'"], "x.py");
		expect(normalizeTokens(t, "x.py")).toEqual(t);
	});
});
