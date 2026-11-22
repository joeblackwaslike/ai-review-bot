import { describe, expect, it } from "vitest";
import { normalizeTokens, tokenize } from "./tokens.js";

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

	it("swaps quote style in TypeScript", () => {
		expect(normalizeTokens(["'a'"], "x.ts")).toEqual(['"a"']);
		expect(normalizeTokens(["'it\"s'"], "x.ts")).toEqual(["'it\"s'"]);
		const interpolated = `'$${"{"}x}'`;
		expect(normalizeTokens([interpolated], "x.ts")).toEqual([interpolated]);
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

	it("does not join lines in Go", () => {
		expect(toks(["a := f(1)", "b := 2"], "x.go")).toContain("\n");
		expect(toks(["a := f(1)", "b := 2"], "x.go")).not.toEqual(
			toks(["a := f(1) b := 2"], "x.go"),
		);
	});

	it("keeps Python floor division", () => {
		expect(toks(["a // b"], "x.py")).toEqual(["a", "//", "b"]);
		expect(toks(["a // b"], "x.py")).not.toEqual(toks(["a // c"], "x.py"));
	});

	it("does not treat a # inside a URL in YAML as a comment", () => {
		expect(toks(["url: http://x/#a"], "x.yaml")).not.toEqual(
			toks(["url: http://x/#b"], "x.yaml"),
		);
	});

	it("still drops a trailing hash comment after whitespace", () => {
		expect(toks(["a = 1 # note"], "x.py")).toEqual(toks(["a = 1"], "x.py"));
	});

	it("tells send from less-than-negative in Go", () => {
		expect(toks(["ch <- v"], "x.go")).not.toEqual(toks(["ch < -v"], "x.go"));
	});

	it.each(
		"if for while switch".split(" "),
	)("keeps the semicolon of an empty %s body before a closing brace", (word) => {
		expect(norm(`{ ${word} (x); }`, "x.ts")).toContain(";");
		expect(norm(`{ ${word} (f(x)); }`, "x.js")).toContain(";");
	});

	it("drops the semicolon after an ordinary call before a closing brace", () => {
		expect(norm("{ run(x); }", "x.ts")).not.toContain(";");
	});

	it("still drops a semicolon before a closing brace", () => {
		expect(norm("{ foo(); }", "x.ts")).toEqual(norm("{ foo() }", "x.ts"));
	});
});

describe("trailing commas outside tuple languages", () => {
	it("still drops a trailing comma in a Go call", () => {
		expect(norm("f(a, b,)", "x.go")).toEqual(norm("f(a, b)", "x.go"));
	});

	it("still drops a trailing comma in a Python call", () => {
		expect(norm("f(a, b,)", "x.py")).toEqual(norm("f(a, b)", "x.py"));
	});
});

describe("JS family automatic semicolon insertion", () => {
	it("tells count++ then limit from count then ++limit", () => {
		expect(toks(["count++", "limit"], "x.ts")).not.toEqual(
			toks(["count", "++limit"], "x.ts"),
		);
	});

	it("keeps a line break before a line starting with a parenthesis after an identifier", () => {
		expect(toks(["run()", "(a || b).go()"], "x.js")).toContain("\n");
	});

	it("joins a wrapped argument list whose line starts with a parenthesis after an opener or comma", () => {
		const wrapped = toks(["foo(", "(a + b),", "(c),", "d", ")"], "x.ts");
		expect(wrapped).toEqual(toks(["foo((a + b), (c), d)"], "x.ts"));
	});

	it("keeps a semicolon that ends the stream", () => {
		expect(normalizeTokens(toks(["a = 1;"], "x.ts"), "x.ts")).toContain(";");
	});
});

describe("quote normalization by language", () => {
	const jsx = ["<p className=\"note\">Don't forget we won't be there today"];
	const jsxDouble = [
		'<p className="note">Don"t forget we won"t be there today',
	];

	it.each([
		"jsx",
		"tsx",
	])("keeps single and double quotes apart in %s", (ext) => {
		const a = normalizeTokens(toks(jsx, `x.${ext}`), `x.${ext}`);
		const b = normalizeTokens(toks(jsxDouble, `x.${ext}`), `x.${ext}`);
		expect(a).not.toEqual(b);
	});

	it.each([
		"ts",
		"js",
		"mjs",
		"cjs",
		"py",
	])("still swaps quotes in %s", (ext) => {
		const a = normalizeTokens(toks(["f('a')"], `x.${ext}`), `x.${ext}`);
		const b = normalizeTokens(toks(['f("a")'], `x.${ext}`), `x.${ext}`);
		expect(a).toEqual(b);
	});
});

describe("long lines", () => {
	it("tokenizes a line over the cap as one token", () => {
		expect(toks(["a + ".repeat(1000)], "x.ts")).toHaveLength(1);
	});
});

describe("string escapes", () => {
	it("reads an escaped quote and a slash pair inside a string as one token", () => {
		expect(toks(['x = "a\\" // b";'], "x.ts")).toEqual([
			"x",
			"=",
			'"a\\" // b"',
			";",
		]);
	});
});
