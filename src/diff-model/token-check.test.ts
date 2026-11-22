import { describe, expect, it } from "vitest";
import { receiverChangeClass, signatureRange } from "./reshape.js";
import {
	leadingSignature,
	receiverOnlyLine,
	reshapeEquivalent,
	tokenEquivalent,
} from "./token-check.js";

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

	it("drops a division that may be a regex literal", () => {
		expect(same(["x = /a b/g;"], ["x = /a  b/g;"]).equivalent).toBe(false);
	});

	it("drops a quote swap for a string with an escape", () => {
		expect(same(["x = 'a\\'b';"], ['x = "a\\\'b";']).equivalent).toBe(false);
	});

	it("drops a semicolon removal after an empty loop header", () => {
		expect(same(["{ while (x); }"], ["{ while (x) }"]).equivalent).toBe(false);
	});
	it.each(["jsx", "tsx"])("drops a quote swap in %s text", (ext) => {
		expect(
			same(
				["<p className=\"note\">Don't forget we won't be there today"],
				['<p className="note">Don"t forget we won"t be there today'],
				`a.${ext}`,
				`b.${ext}`,
			).equivalent,
		).toBe(false);
	});

	it.each([
		["ts", "ts"],
		["js", "js"],
		["py", "py"],
	])("still verifies a quote swap in %s", (ext) => {
		expect(
			same(["x = f('a', 'b')"], ['x = f("a", "b")'], `a.${ext}`, `b.${ext}`)
				.equivalent,
		).toBe(true);
	});

	it("drops a trailing comma that follows a kept line break", () => {
		expect(same(["foo(return", ", )"], ["foo(return", ")"]).equivalent).toBe(
			false,
		);
	});

	it("drops a trailing comma after an opener", () => {
		expect(same(["f(,)"], ["f()"]).equivalent).toBe(false);
	});

	it("drops a line holding an unterminated string", () => {
		expect(same(["x  =  'abc d"], ["x = 'abc d"]).equivalent).toBe(false);
	});

	it("drops a semicolon removal at the end of a block", () => {
		expect(
			same(["const x = compute(a, b);"], ["const x = compute(a, b)"])
				.equivalent,
		).toBe(false);
	});

	it("drops a Python one-tuple that loses its comma", () => {
		expect(
			same(["value = (1,)"], ["value = (1)"], "a.py", "b.py").equivalent,
		).toBe(false);
	});

	it("drops Go lines joined onto one line", () => {
		expect(
			same(["a := f(1)", "b := 2"], ["a := f(1) b := 2"], "a.go", "b.go")
				.equivalent,
		).toBe(false);
	});

	it("drops a Go return joined to its value", () => {
		expect(
			same(["return", "value"], ["return value"], "a.go", "b.go").equivalent,
		).toBe(false);
	});
});

describe("tokenEquivalent negatives for each structural rule", () => {
	it("drops a Python block whose inner depth changed", () => {
		expect(
			same(
				["if ready:", "    start()", "    finish()"],
				["if ready:", "    start()", "        finish()"],
				"a.py",
				"b.py",
			).equivalent,
		).toBe(false);
	});

	it("drops a YAML block whose inner depth changed", () => {
		expect(
			same(
				["root:", "  first: 1", "  second: 2"],
				["root:", "  first: 1", "    second: 2"],
				"a.yml",
				"b.yml",
			).equivalent,
		).toBe(false);
	});

	it.each([
		"return",
		"throw",
		"break",
		"continue",
		"yield",
	])("keeps the line break after %s", (word) => {
		expect(
			same([word, "alpha;"], [`${word} alpha;`], "a.js", "b.js").equivalent,
		).toBe(false);
	});

	it("keeps a regex literal after return unequal to its respaced twin", () => {
		expect(same(["return /a  b/;"], ["return /a b/;"]).equivalent).toBe(false);
	});

	it.each([
		"(",
		"[",
		"+",
		"-",
		"++",
		"--",
	])("keeps the line break before a line starting with %s", (opener) => {
		expect(
			same(
				["value", `${opener}other`],
				[`value ${opener}other`],
				"a.js",
				"b.js",
			).equivalent,
		).toBe(false);
	});

	it("keeps the line break between count-- and the next line", () => {
		expect(
			same(["count--", "limit"], ["count", "--limit"], "a.js", "b.js")
				.equivalent,
		).toBe(false);
	});

	it.each([
		"if",
		"for",
		"while",
		"switch",
	])("keeps the semicolon after an empty %s header", (word) => {
		expect(
			same([`{ ${word} (x); }`], [`{ ${word} (x) }`], "a.js", "b.js")
				.equivalent,
		).toBe(false);
	});

	it("still drops a semicolon after an ordinary call before a brace", () => {
		expect(
			same(["{ run(x); }"], ["{ run(x) }"], "a.js", "b.js").equivalent,
		).toBe(true);
	});

	it.each([
		["a backtick", "key: `x`"],
		["a triple double quote", 'key: """x"""'],
		["a triple single quote", "key: '''x'''"],
		["a heredoc opener", "key: <<EOF"],
	])("drops a YAML claim holding %s", (_, line) => {
		expect(
			same(["root:", `  ${line}`], ["  root:", `    ${line}`], "a.yml", "b.yml")
				.equivalent,
		).toBe(false);
	});

	it("reads an escaped quote inside a string without ending it", () => {
		expect(
			same(['x = "a\\" // b";'], ['x   =   "a\\" // b";']).equivalent,
		).toBe(true);
	});
});

describe("receiverOnlyLine", () => {
	it("accepts a gained or lost receiver prefix", () => {
		expect(
			receiverOnlyLine("total = f(x)", "total = self.f(x)", "a.py", "b.py"),
		).toBe(true);
		expect(receiverOnlyLine("this.f(x);", "f(x);", "a.ts", "b.ts")).toBe(true);
		expect(receiverOnlyLine("g(x)", "Self::g(x)", "a.rs", "b.rs")).toBe(false);
		expect(receiverOnlyLine("self.f(x)", "cls.f(x)", "a.py", "b.py")).toBe(
			true,
		);
	});

	it("rejects anything beyond a receiver token", () => {
		expect(receiverOnlyLine("this.f(x);", "that.f(x);", "a.ts", "b.ts")).toBe(
			false,
		);
		expect(receiverOnlyLine("self.a", "self.b", "a.py", "b.py")).toBe(false);
		expect(receiverOnlyLine("f(x, y)", "self.f(y, x)", "a.py", "b.py")).toBe(
			false,
		);
		expect(receiverOnlyLine("Self::g(x)", "Other::g(x)", "a.rs", "b.rs")).toBe(
			false,
		);
		expect(receiverOnlyLine("f(x)", "f(x)", "a.py", "b.py")).toBe(false);
	});

	it("never removes a receiver after a dot, at line end or inside a string", () => {
		expect(receiverOnlyLine("obj.x", "obj.self.x", "a.py", "b.py")).toBe(false);
		expect(receiverOnlyLine("x = self", "x = self.", "a.py", "b.py")).toBe(
			false,
		);
		expect(receiverOnlyLine("a = b", "self = b", "a.py", "b.py")).toBe(false);
		expect(receiverOnlyLine("s = 'x'", "s = 'self.x'", "a.py", "b.py")).toBe(
			false,
		);
	});

	it("rejects other families and languages", () => {
		expect(receiverOnlyLine("this.f(x);", "f(x);", "A.java", "b.ts")).toBe(
			false,
		);
		expect(receiverOnlyLine("this.f(x)", "f(x)", "a.go", "b.go")).toBe(false);
	});
});

describe("leadingSignature", () => {
	it("reads decorators and a multi-line opening line", () => {
		const found = leadingSignature(
			["@retry", "def f(", "    a,", "    b,", "):", "    return a"],
			"a.py",
		);
		expect(found).toMatchObject({ decorators: 1, end: 4, opensBrace: false });
	});

	it("reads a brace signature and flags the open brace", () => {
		expect(
			leadingSignature(
				["  process(items: Item[]): number {", "    return 1;", "  }"],
				"a.ts",
			),
		).toMatchObject({ decorators: 0, end: 0, opensBrace: true });
	});

	it("is null for a block that does not start with a definition", () => {
		expect(leadingSignature(["total = a + b", "    x = 1"], "a.py")).toBeNull();
		expect(leadingSignature(["if (ready(x)) {", "}"], "a.ts")).toBeNull();
		expect(leadingSignature(["const f = (a) => {", "}"], "a.ts")).toBeNull();
	});

	it("is null without the block terminator, with a comment, or outside the languages", () => {
		expect(
			leadingSignature(["def f(x) -> int", "    pass"], "a.py"),
		).toBeNull();
		expect(
			leadingSignature(["def f(x):  # note", "    pass"], "a.py"),
		).toBeNull();
		expect(leadingSignature(["func f(x int) {", "}"], "a.go")).toBeNull();
	});
});

describe("reshapeEquivalent", () => {
	const block = (
		filename: string,
		lines: string[],
		opener?: string,
		opensBrace = false,
	) => ({
		filename,
		lines,
		opener,
		opensBrace,
	});

	it("lists the lines that match only after receiver removal", () => {
		const result = reshapeEquivalent(
			block("a.py", ["    x = f(1)", "    g(x)", "    return x"], "def a(v):"),
			block(
				"b.py",
				["        x = f(1)", "        self.g(x)", "        return x"],
				"    def a(self, v):",
			),
		);
		expect(result).toEqual({
			equivalent: true,
			pairs: [[1, 1]],
			codePairs: [],
			reindent: 4,
		});
	});

	it("rejects a body that differs beyond a receiver", () => {
		const result = reshapeEquivalent(
			block("a.ts", ["  f(a, b);", "}"], undefined, true),
			block("b.ts", ["  this.f(b, a);", "}"], undefined, true),
		);
		expect(result.equivalent).toBe(false);
	});

	it("rejects tabs, comments, other families and unbalanced bodies", () => {
		const py = (lines: string[]) => block("a.py", lines, "def a(v):");
		expect(
			reshapeEquivalent(py(["\tx = 1"]), py(["    x = 1"])).equivalent,
		).toBe(false);
		expect(
			reshapeEquivalent(py(["    x = 1  # c"]), py(["    x = 1  # c"]))
				.equivalent,
		).toBe(false);
		expect(
			reshapeEquivalent(block("a.ts", ["  f();"]), block("b.java", ["  f();"]))
				.equivalent,
		).toBe(false);
		expect(
			reshapeEquivalent(
				block("a.ts", ["  f();", "}"]),
				block("b.ts", ["  f();", "}"]),
			).equivalent,
		).toBe(false);
	});
});

describe("receiverOnlyLine state meaning", () => {
	it("refuses a receiver gained or lost on an assignment target", () => {
		expect(
			receiverOnlyLine("count = n", "self.count = n", "a.py", "b.py"),
		).toBe(false);
		expect(
			receiverOnlyLine("self.count = n", "count = n", "a.py", "b.py"),
		).toBe(false);
		expect(
			receiverOnlyLine("cls.count += n", "self.count += n", "a.py", "b.py"),
		).toBe(false);
		expect(
			receiverOnlyLine(
				"total = total + 1",
				"self.total = total + 1",
				"a.py",
				"b.py",
			),
		).toBe(false);
		expect(receiverOnlyLine("this.n = n;", "n = n;", "a.ts", "b.ts")).toBe(
			false,
		);
	});

	it("refuses one receiver dropped while another is added", () => {
		expect(
			receiverOnlyLine(
				"total = self.a + x",
				"total = a + self.x",
				"a.py",
				"b.py",
			),
		).toBe(false);
	});

	it("still accepts a receiver gained on the value side", () => {
		expect(
			receiverOnlyLine("total = a + x", "total = self.a + x", "a.py", "b.py"),
		).toBe(true);
	});
});

describe("reshapeEquivalent code pairs", () => {
	const block = (filename: string, lines: string[], opensBrace = false) => ({
		filename,
		lines,
		opensBrace,
	});

	it("lists an assignment target change as a code pair", () => {
		const result = reshapeEquivalent(
			block("a.ts", ["  n = 1;", "  f(x);"], true),
			block("b.ts", ["  this.n = 1;", "  this.f(x);"], true),
		);
		expect(result.equivalent).toBe(true);
		expect(result.pairs).toEqual([
			[0, 0],
			[1, 1],
		]);
		expect(result.codePairs).toEqual([[0, 0]]);
	});

	it("lists a swapped receiver as a code pair", () => {
		const result = reshapeEquivalent(
			block("a.py", ["total = self.a + x"]),
			block("b.py", ["total = a + self.x"]),
		);
		expect(result.codePairs).toEqual([[0, 0]]);
	});
});

describe("checker opener scan", () => {
	it("returns null for hostile lines without scanning them", () => {
		for (const line of [`${"static ".repeat(32000)}!`, "a <b ".repeat(32000)]) {
			const started = performance.now();
			expect(leadingSignature([line, "}"], "a.ts")).toBeNull();
			expect(receiverOnlyLine(line, line, "a.ts", "b.ts")).toBe(false);
			expect(
				reshapeEquivalent(
					{ filename: "a.ts", lines: [line], opensBrace: false },
					{ filename: "b.ts", lines: [line], opensBrace: false },
				).equivalent,
			).toBe(false);
			expect(performance.now() - started).toBeLessThan(1000);
		}
	}, 5000);

	it("handles a 2000-character modifier run quickly", () => {
		const started = performance.now();
		leadingSignature([`${"static ".repeat(285)}!`], "a.ts");
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("does not read with (scope) { as a definition opening", () => {
		expect(leadingSignature(["with (scope) {", "}"], "a.js")).toBeNull();
		expect(leadingSignature(["run(scope) {", "}"], "a.js")).not.toBeNull();
	});
});

describe("matcher and checker agree on the shared reshape vocabulary", () => {
	const openers: [string, string][] = [
		["function f(a) {", "a.ts"],
		["async function f(a) {", "a.js"],
		["export default function f(a) {", "a.ts"],
		["  run(a, b) {", "a.ts"],
		["  static make(a) {", "a.ts"],
		["  async load<T>(a: T) {", "a.ts"],
		["  get value() {", "a.ts"],
		["if (ready(x)) {", "a.ts"],
		["while (more(x)) {", "a.ts"],
		["switch (kind(x)) {", "a.ts"],
		["with (scope) {", "a.js"],
		["return f(x) {", "a.ts"],
		["} catch (e) {", "a.ts"],
		["const x = f(y) {", "a.ts"],
		["def f(self, a):", "a.py"],
		["async def f(a):", "a.py"],
		["class A(Base):", "a.py"],
		["if ready(x):", "a.py"],
		["for x in f(y):", "a.py"],
	];

	it.each(openers)("agrees on %s in %s", (line, file) => {
		const terminator = file.endsWith(".py") ? [] : ["}"];
		const matcher = signatureRange([line], file) !== null;
		const checker = leadingSignature([line, ...terminator], file) !== null;
		expect(checker).toBe(matcher);
	});

	const receivers: [string, string, string][] = [
		["f(x)", "this.f(x)", "ts"],
		["f(x)", "this.f(x)", "js"],
		["this.n = 1;", "n = 1;", "ts"],
		["f(x)", "self.f(x)", "py"],
		["f(x)", "cls.f(x)", "py"],
		["self.f(x)", "cls.f(x)", "py"],
		["total = self.a + x", "total = a + self.x", "py"],
		["count = n", "self.count = n", "py"],
		["x = self", "x = self.", "py"],
		["f(x)", "that.f(x)", "ts"],
		["f(x)", "self.f(x)", "ts"],
		["f(x)", "this.f(x)", "py"],
	];

	it.each(receivers)("classifies %s against %s the same in %s", (a, b, ext) => {
		const file = `f.${ext}`;
		const matcher = receiverChangeClass(a, b, file, file);
		expect(receiverOnlyLine(a, b, file, file)).toBe(matcher === "receiver");
	});
});
