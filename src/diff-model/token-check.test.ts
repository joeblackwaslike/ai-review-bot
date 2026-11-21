import { describe, expect, it } from "vitest";
import { tokenEquivalent } from "./token-check.js";

function same(
	base: string[],
	head: string[],
	baseFile = "a.ts",
	headFile = "b.ts",
) {
	return tokenEquivalent(base, head, baseFile, headFile);
}

describe("tokenEquivalent", () => {
	it("verifies a reformatted TypeScript object literal", () => {
		const result = same(
			["const config = { name: 'alpha', retries: 3, verbose: false };"],
			[
				"const config = {",
				'  name: "alpha",',
				"  retries: 3,",
				"  verbose: false,",
				"};",
			],
		);
		expect(result.equivalent).toBe(true);
		expect(result.reindent).toBe(0);
	});

	it("verifies a Black-wrapped Python call", () => {
		const result = same(
			["result = process_order(customer_id, order_items, discount_code)"],
			[
				"result = process_order(",
				"    customer_id,",
				"    order_items,",
				"    discount_code,",
				")",
			],
			"a.py",
			"b.py",
		);
		expect(result).toEqual({ equivalent: true, reindent: 0 });
	});

	it("verifies a re-indented Python block and reports the shift", () => {
		const result = same(
			["def total(items):", "    if items:", "        return sum(items)"],
			[
				"        def total(items):",
				"            if items:",
				"                return sum(items)",
			],
			"a.py",
			"b.py",
		);
		expect(result).toEqual({ equivalent: true, reindent: 8 });
	});

	it("verifies a YAML block moved one level deeper", () => {
		const result = same(
			["server:", "  port: 8080", "  host: example"],
			["  server:", "    port: 8080", "    host: example"],
			"a.yml",
			"b.yaml",
		);
		expect(result).toEqual({ equivalent: true, reindent: 2 });
	});

	it("drops YAML lines that differ only by a space after the colon", () => {
		expect(
			same(
				["server:", "  port: 8080"],
				["server:", "  port:8080"],
				"a.yml",
				"b.yml",
			).equivalent,
		).toBe(false);
	});

	it("drops a claim where only operator order differs", () => {
		expect(same(["total = a + ++b;"], ["total = a++ + b;"]).equivalent).toBe(
			false,
		);
	});

	it("drops a claim over a template literal reformat", () => {
		expect(same(["const s = `a  b`;"], ["const s = `a b`;"]).equivalent).toBe(
			false,
		);
	});

	it("drops a tab-indented re-indent claim", () => {
		expect(
			same(
				["if x:", "\treturn 1"],
				["    if x:", "    \treturn 1"],
				"a.py",
				"b.py",
			).equivalent,
		).toBe(false);
	});

	it("drops a JavaScript increment moved across a line break", () => {
		expect(
			same(["count++", "limit"], ["count", "++limit"], "a.js", "b.js")
				.equivalent,
		).toBe(false);
	});

	it("drops a CSS claim", () => {
		expect(
			same([".a { color: red; }"], [".a { color:  red; }"], "a.css", "b.css")
				.equivalent,
		).toBe(false);
	});

	it("drops a Ruby claim", () => {
		expect(
			same(
				["total = compute(a, b)"],
				["total = compute(a,  b)"],
				"a.rb",
				"b.rb",
			).equivalent,
		).toBe(false);
	});

	it("drops a claim across language families", () => {
		expect(
			same(
				["val x = compute(a, b)"],
				["val x = compute(a,  b)"],
				"a.go",
				"b.kt",
			).equivalent,
		).toBe(false);
	});

	it("drops a claim with unbalanced brackets", () => {
		expect(same(["call(a,", "b"], ["call(a, b"]).equivalent).toBe(false);
	});

	it("drops a C macro that differs by a space before the parameter list", () => {
		expect(
			same(
				["#define SQUARE(x) ((x) * (x))"],
				["#define SQUARE (x) ((x) * (x))"],
				"a.c",
				"b.h",
			).equivalent,
		).toBe(false);
	});

	it("drops a claim when a line carries a comment", () => {
		expect(
			same(["run(a, b); // go"], ["run(a, b);  // go"], "A.java", "B.java")
				.equivalent,
		).toBe(false);
	});

	it("drops a division that may be a regex literal", () => {
		expect(same(["x = /a b/g;"], ["x = /a  b/g;"]).equivalent).toBe(false);
	});

	it("drops a trailing comma removal in Java where it is not allowed", () => {
		expect(
			same(["call(a, b,)"], ["call(a, b)"], "a.java", "b.java").equivalent,
		).toBe(false);
	});

	it("drops a quote swap for a string with an escape", () => {
		expect(same(["x = 'a\\'b';"], ['x = "a\\\'b";']).equivalent).toBe(false);
	});

	it("drops a semicolon removal after an empty loop header", () => {
		expect(same(["{ while (x); }"], ["{ while (x) }"]).equivalent).toBe(false);
	});
});
