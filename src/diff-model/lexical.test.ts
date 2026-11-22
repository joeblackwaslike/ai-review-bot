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
				["const a = b / 2; // half", "const d = xs[0] / n;", "/* c */ x = 1;"],
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

describe("literalSafe in the Ruby, Perl and awk family", () => {
	it("rejects any slash outside a string", () => {
		expect(literalSafe(["x.split(//).grep(/a  b/)"], "a.rb")).toBe(false);
		expect(literalSafe(["$a // 1; $x =~ /a  b/"], "a.pl")).toBe(false);
		expect(literalSafe(["puts /a  b/"], "a.rb")).toBe(false);
		expect(literalSafe(["when /a  b/"], "a.rb")).toBe(false);
		expect(literalSafe(["if /a  b/ =~ s"], "a.rb")).toBe(false);
		expect(literalSafe(["s.split /a  b/"], "a.rb")).toBe(false);
		expect(literalSafe(["split /a  b/, $s"], "a.pl")).toBe(false);
		expect(literalSafe(["$x and /a  b/"], "a.pl")).toBe(false);
		expect(literalSafe(["$1 / 2"], "a.rb")).toBe(false);
	});

	it("still ignores a slash inside a Ruby string", () => {
		expect(literalSafe(["u = 'a/b'"], "a.rb")).toBe(true);
	});

	it("rejects percent literals and Perl quote-like operators", () => {
		expect(literalSafe(["%r{a  b}"], "a.rb")).toBe(false);
		expect(literalSafe(["x = %w[a  b]"], "a.rb")).toBe(false);
		expect(literalSafe(["m{a  b}"], "a.pl")).toBe(false);
		expect(literalSafe(["$x =~ qr(a  b)"], "a.pl")).toBe(false);
	});

	it("accepts an ordinary Ruby line", () => {
		expect(literalSafe(["total = a + b % 3"], "a.rb")).toBe(true);
	});
});

describe("literalSafe slash after a control-flow paren", () => {
	it("rejects a slash after any closing parenthesis", () => {
		expect(literalSafe(["if (a) /x  y/.test(s)"], "a.ts")).toBe(false);
		expect(literalSafe(["f(a) / b"], "a.ts")).toBe(false);
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

	it("returns null for non-ASCII leading whitespace", () => {
		expect(relativeIndent(["\u00a0a"])).toBeNull();
		expect(relativeIndent(["\fa"])).toBeNull();
		expect(relativeIndent(["\u000ba"])).toBeNull();
	});

	it("keeps a deeper continuation line relative", () => {
		expect(relativeIndent(["    f(a,", "          b)"])?.shape).toEqual([
			"f(a,",
			"      b)",
		]);
	});

	it("turns a whitespace-only line into an empty string", () => {
		expect(relativeIndent(["  a", "     ", "  b"])?.shape).toEqual([
			"a",
			"",
			"b",
		]);
	});

	it("differs when the relative structure differs", () => {
		const four = relativeIndent(["    a", "        b"]);
		const eight = relativeIndent(["        a", "            b"]);
		const flat = relativeIndent(["        a", "        b"]);
		expect(four?.shape).toEqual(eight?.shape);
		expect(four?.shape).not.toEqual(flat?.shape);
	});
});
