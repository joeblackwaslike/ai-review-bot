import { describe, expect, it } from "vitest";
import {
	lexicallySafe,
	literalSafe,
	normalizeSafe,
	relativeIndent,
} from "./lexical.js";

describe("lexicallySafe", () => {
	it("is unsafe for an indentation-sensitive file", () => {
		expect(lexicallySafe("a.py", ["x = 1"])).toBe(false);
		expect(lexicallySafe("Makefile", ["all:"])).toBe(false);
	});

	it("is unsafe when any line has a backtick", () => {
		expect(lexicallySafe("a.ts", ["const a = 1;", "const b = `x`;"])).toBe(
			false,
		);
	});

	it("is unsafe when any line opens a triple-quoted string or heredoc", () => {
		expect(lexicallySafe("a.ts", ['s = """'])).toBe(false);
		expect(lexicallySafe("a.ts", ["s = '''"])).toBe(false);
		expect(lexicallySafe("a.sh", ["cat <<EOF"])).toBe(false);
	});

	it("is unsafe when a line ends in a backslash followed by whitespace", () => {
		expect(lexicallySafe("a.sh", ["cmd \\ "])).toBe(false);
		expect(lexicallySafe("a.sh", ["cmd \\\t"])).toBe(false);
		expect(lexicallySafe("a.sh", ["cmd \\"])).toBe(true);
	});

	it("is safe for plain TypeScript statements", () => {
		expect(lexicallySafe("a.ts", ["const a = 1;", "return a;"])).toBe(true);
	});
});

describe("normalizeSafe", () => {
	it("collapses whitespace when safe", () => {
		expect(normalizeSafe("a.ts", ["  const   a = 1;"])).toEqual([
			"const a = 1;",
		]);
	});

	it("returns raw lines when unsafe", () => {
		const lines = ["  const   a = `x`;"];
		expect(normalizeSafe("a.ts", lines)).toEqual(lines);
	});
});

describe("literalSafe", () => {
	it("accepts a Python block", () => {
		expect(literalSafe(["def f(x):", "    return x + 1"], "a.py")).toBe(true);
	});

	it("accepts a TypeScript block with division and comments", () => {
		expect(
			literalSafe(
				[
					"const a = (b + c) / 2; // half",
					"const d = xs[0] / n;",
					"/* c */ x = 1;",
				],
				"a.ts",
			),
		).toBe(true);
	});

	it("rejects a TypeScript regex literal after = and after (", () => {
		expect(literalSafe(["const r = /a  b/;"], "a.ts")).toBe(false);
		expect(literalSafe(["s.replace(/a  b/g, '')"], "a.ts")).toBe(false);
		expect(literalSafe(["return /x/.test(s);"], "a.ts")).toBe(false);
		expect(literalSafe(["/x/.test(s);"], "a.ts")).toBe(false);
	});

	it("rejects a multi-line block comment opener in TypeScript", () => {
		expect(literalSafe(["/* open"], "a.ts")).toBe(false);
	});

	it("rejects a backtick template", () => {
		expect(literalSafe(["const b = `x`;"], "a.py")).toBe(false);
	});

	it("rejects a triple-quoted string", () => {
		expect(literalSafe(['s = """'], "a.py")).toBe(false);
		expect(literalSafe(["s = '''"], "a.py")).toBe(false);
	});

	it("rejects a heredoc", () => {
		expect(literalSafe(["cat <<EOF"], "a.sh")).toBe(false);
		expect(literalSafe(["cat <<-'EOF'"], "a.sh")).toBe(false);
		expect(literalSafe(["x = <<~HEREDOC"], "a.rb")).toBe(false);
	});

	it("ignores a slash inside a string", () => {
		expect(literalSafe(["const u = 'a/b' + \"c/d\";"], "a.ts")).toBe(true);
	});

	it("treats a slash in Go and C as safe", () => {
		expect(literalSafe(["x := a / b // c"], "a.go")).toBe(true);
		expect(literalSafe(["x = (a) / b; /* c */"], "a.c")).toBe(true);
	});
});

describe("relativeIndent", () => {
	it("is equal for a block shifted four columns", () => {
		const a = relativeIndent(["if x:", "    y", "    z"]);
		const b = relativeIndent(["    if x:", "        y", "        z"]);
		expect(a?.shape).toEqual(b?.shape);
		expect(a?.base).toBe(0);
		expect(b?.base).toBe(4);
	});

	it("keeps blank lines", () => {
		expect(relativeIndent(["  a", "", "    b"])?.shape).toEqual([
			"a",
			"",
			"  b",
		]);
	});

	it("returns null for tabs and for mixed indentation", () => {
		expect(relativeIndent(["\ta"])).toBeNull();
		expect(relativeIndent(["  \ta"])).toBeNull();
	});
});
