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

const norm = (line: string, file: string) =>
	normalizeTokens(toks([line], file), file);

describe("false equivalences", () => {
	it("keeps the comma of a Python one-tuple", () => {
		expect(norm("x = (1,)", "x.py")).not.toEqual(norm("x = (1)", "x.py"));
	});

	it("drops a trailing comma after another comma in Python", () => {
		expect(norm("f(a, b,)", "x.py")).toEqual(norm("f(a, b)", "x.py"));
	});

	it("drops a trailing comma in TypeScript", () => {
		expect(norm("foo(a,)", "x.ts")).toEqual(norm("foo(a)", "x.ts"));
	});

	it("keeps holes in JavaScript arrays", () => {
		expect(norm("[,]", "x.js")).not.toEqual(norm("[]", "x.js"));
		expect(norm("[a,,]", "x.js")).not.toEqual(norm("[a,]", "x.js"));
	});

	it("keeps one-tuple and expansion commas in Rust and shell", () => {
		expect(norm("(1,)", "x.rs")).not.toEqual(norm("(1)", "x.rs"));
		const withComma = ["echo $", "{v,}"].join("");
		const without = ["echo $", "{v}"].join("");
		expect(norm(withComma, "x.sh")).not.toEqual(norm(without, "x.sh"));
	});

	it("does not join lines on braces in Go", () => {
		expect(toks(["return", "x"], "x.go")).not.toEqual(
			toks(["return x"], "x.go"),
		);
	});

	it("does not join lines on braces in shell", () => {
		expect(toks(["f(){ echo a", "rm x }"], "x.sh")).not.toEqual(
			toks(["f(){ echo a rm x }"], "x.sh"),
		);
	});

	it("keeps // as an operator in a Dockerfile", () => {
		expect(toks(["RUN curl http://a.com/x"], "Dockerfile")).not.toEqual(
			toks(["RUN curl http://b.com/y"], "Dockerfile"),
		);
	});

	it("keeps // as an operator in CSS", () => {
		expect(toks(["a{b:url(http://a/x)}"], "x.css")).not.toEqual(
			toks(["a{b:url(http://b/y)}"], "x.css"),
		);
	});

	it("keeps Python floor division", () => {
		expect(toks(["a // b"], "x.py")).toEqual(["a", "//", "b"]);
		expect(toks(["a // b"], "x.py")).not.toEqual(toks(["a // c"], "x.py"));
	});

	it("does not treat $# in shell as a comment", () => {
		expect(toks(["[ $# -eq 0 ]"], "x.sh")).not.toEqual(
			toks(["[ $# -eq 1 ]"], "x.sh"),
		);
	});

	it("does not treat a # inside a URL in YAML as a comment", () => {
		expect(toks(["url: http://x/#a"], "x.yaml")).not.toEqual(
			toks(["url: http://x/#b"], "x.yaml"),
		);
	});

	it("still drops a trailing hash comment after whitespace", () => {
		expect(toks(["a = 1 # note"], "x.py")).toEqual(toks(["a = 1"], "x.py"));
	});

	it("does not strip a glob as a block comment in shell", () => {
		expect(toks(["cp src/* /dst"], "x.sh")).not.toEqual(
			toks(["cp src/* /tmp"], "x.sh"),
		);
	});

	it("tells send from less-than-negative in Go", () => {
		expect(toks(["ch <- v"], "x.go")).not.toEqual(toks(["ch < -v"], "x.go"));
	});

	it("tells =~ from = ~ in Ruby", () => {
		expect(toks(["b =~ c"], "x.rb")).not.toEqual(toks(["b = ~c"], "x.rb"));
	});

	it("keeps the line break after a C preprocessor line", () => {
		expect(toks(["#define A 1", "int b;"], "x.c")).not.toEqual(
			toks(["#define A 1 int b;"], "x.c"),
		);
	});

	it("keeps the semicolon of an empty if body", () => {
		expect(norm("if (x);", "x.ts")).not.toEqual(norm("if (x)", "x.ts"));
		expect(norm("while (f(x));", "x.js")).not.toEqual(
			norm("while (f(x))", "x.js"),
		);
	});

	it("still drops a semicolon before a closing brace", () => {
		expect(norm("{ foo(); }", "x.ts")).toEqual(norm("{ foo() }", "x.ts"));
	});
});

describe("trailing commas outside tuple languages", () => {
	it("keeps the trailing comma of a shell brace expansion", () => {
		const withComma = "echo {a,b,}";
		expect(norm(withComma, "x.sh")).not.toEqual(norm("echo {a,b}", "x.sh"));
	});

	it("keeps the trailing comma of a shell glob class", () => {
		expect(norm("ls [a,b,]*", "x.sh")).not.toEqual(norm("ls [a,b]*", "x.sh"));
	});

	it("keeps the trailing comma of a Ruby word list", () => {
		expect(norm("w = %w[a,b,]", "x.rb")).not.toEqual(
			norm("w = %w[a,b]", "x.rb"),
		);
	});

	it("still drops a trailing comma in a Go call", () => {
		expect(norm("f(a, b,)", "x.go")).toEqual(norm("f(a, b)", "x.go"));
	});

	it("still drops a trailing comma in a Python call", () => {
		expect(norm("f(a, b,)", "x.py")).toEqual(norm("f(a, b)", "x.py"));
	});
});
