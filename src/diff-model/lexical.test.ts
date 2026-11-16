import { describe, expect, it } from "vitest";
import { lexicallySafe, normalizeSafe } from "./lexical.js";

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
