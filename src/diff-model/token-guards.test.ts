import { describe, expect, it } from "vitest";
import { collectRuns, type PushFile } from "../moved-blocks.js";
import { WorkBudget } from "./budget.js";
import { literalSafe } from "./lexical.js";
import { findRelocations } from "./relocation.js";
import {
	CHECKER_FAMILIES,
	checkerOperatorsFor,
	hasBlockScalarHeader,
	opensUnclosedString,
	tokenEquivalent,
	unbalancedBlockComment,
} from "./token-check.js";
import {
	FAMILIES,
	filesWithLiterals,
	findTokenOperations,
} from "./token-pass.js";
import {
	normalizeTokens,
	opaqueLine,
	operatorsFor,
	tokenize,
	yamlOpaqueLines,
} from "./tokens.js";

const file = (filename: string, patch: string): PushFile => ({
	filename,
	status: "modified",
	patch,
	additions: 0,
	deletions: 0,
});
type Src = string | string[];
const rows = (src: Src) => (Array.isArray(src) ? src : [src]);
const patch = (header: string, sign: string, lines: string[]) =>
	[header, ...lines.map((l) => `${sign}${l}`)].join("\n");

function filesOf(b: Src, h: Src, bf: string, hf: string) {
	const [base, head] = [rows(b), rows(h)];
	return [
		file(bf, patch(`@@ -10,${base.length} +9,0 @@`, "-", base)),
		file(hf, patch(`@@ -0,0 +3,${head.length} @@`, "+", head)),
	];
}

function checker(base: Src, head: Src, bf = "a.ts", hf = "b.ts") {
	return tokenEquivalent(rows(base), rows(head), bf, hf).equivalent;
}

function tokenPassOps(base: Src, head: Src, bf: string, hf: string) {
	const files = filesOf(base, head, bf, hf);
	const { deleted, added } = collectRuns(files);
	return findTokenOperations(
		deleted,
		added,
		new WorkBudget({ tokens: 1_000_000 }),
		filesWithLiterals(files),
	);
}

function exactClaims(base: Src, head: Src, bf: string, hf: string) {
	return findRelocations(filesOf(base, head, bf, hf)).filter((o) => o.exact);
}

function claimedLines(ops: ReturnType<typeof tokenPassOps>): number[] {
	return ops.flatMap((op) =>
		op.from.flatMap((s) =>
			Array.from(
				{ length: s.endLine - s.startLine + 1 },
				(_, k) => s.startLine + k,
			),
		),
	);
}

function rejected(
	base: Src,
	head: Src,
	bf = "src/a.ts",
	hf = "src/b.ts",
	lineMatcherMayClaim = false,
) {
	expect(checker(base, head, bf, hf)).toBe(false);
	expect(tokenPassOps(base, head, bf, hf)).toEqual([]);
	if (!lineMatcherMayClaim) expect(exactClaims(base, head, bf, hf)).toEqual([]);
}

function accepted(base: Src, head: Src, bf = "src/a.ts", hf = "src/b.ts") {
	expect(checker(base, head, bf, hf)).toBe(true);
	expect(tokenPassOps(base, head, bf, hf)).toHaveLength(1);
	expect(exactClaims(base, head, bf, hf)).toHaveLength(1);
}

const pair = (ext: string): [string, string] => [
	`src/a.${ext}`,
	`src/b.${ext}`,
];
const SUM = "alpha + beta + gamma + delta + epsilon + zeta;";

describe("restricted productions keep their line break", () => {
	it.each(
		"async type declare abstract namespace module interface enum get set static let await".split(
			" ",
		),
	)("rejects joining a line ending in %s", (word) => {
		const base = [word, `t = ${SUM}`];
		const head = [`${word} t = ${SUM}`];
		expect(checker(base, head)).toBe(false);
		expect(tokenPassOps(base, head, "src/a.ts", "src/b.ts")).toEqual([]);
	});
});

describe("odd line terminators", () => {
	it.each([
		["\r"],
		["\v"],
		["\f"],
		["\u0085"],
		["\u2028"],
		["\u2029"],
	])("rejects %j inside a line", (mark) => {
		expect(checker(`return${mark} ${SUM}`, `return ${SUM}`)).toBe(false);
	});

	it("rejects a carriage return end to end in JavaScript and Python", () => {
		rejected(`return\r ${SUM}`, `return ${SUM}`);
		rejected(
			`t = alpha_value\r+ ${SUM}`,
			`t = alpha_value + ${SUM}`,
			...pair("py"),
		);
	});

	it("accepts one trailing carriage return", () => {
		const base = [`const t = ${SUM}\r`];
		const head = ["const t =", `  ${SUM}`];
		expect(checker(base, head)).toBe(true);
		expect(tokenPassOps(base, head, "src/a.ts", "src/b.ts")).toHaveLength(1);
	});
});

describe("numbers and HTML-like comments", () => {
	it("tells 1.e3 from 1 .e3 end to end", () => {
		rejected(
			`const t = base + 1.e3 + tax + ${SUM}`,
			`const t = base + 1 .e3 + tax + ${SUM}`,
		);
	});

	it.each([
		["10n", "10 n"],
		["1e+3", "1e + 3"],
	])("tells %s from %s", (a, b) => {
		expect(
			checker(`const t = x + ${a} + y + z;`, `const t = x + ${b} + y + z;`),
		).toBe(false);
	});

	it("rejects HTML-like comment markers end to end", () => {
		rejected(`t = alpha<!--beta + ${SUM}`, `t = alpha < !--beta + ${SUM}`);
		rejected(["t = 1;", `--> hidden(${SUM}`], ["t = 1;", `-- > hidden(${SUM}`]);
	});
});

describe("trailing comma removal by language", () => {
	it("keeps the comma of a Python lambda tuple", () => {
		const line =
			"handler = (lambda alpha, beta: alpha + beta + gamma_value + delta,)";
		rejected(line, line.replace(",)", ")"), ...pair("py"));
	});

	it("keeps the lone comma of a Go call", () => {
		expect(checker("x := f(a,)", "x := f(a)", ...pair("go"))).toBe(false);
	});

	it.each([
		[
			"(first_value, lambda alpha, beta: alpha + beta,)",
			"(first_value, lambda alpha, beta: alpha + beta)",
			true,
		],
		[
			"(lambda alpha: alpha, second_value,)",
			"(lambda alpha: alpha, second_value)",
			true,
		],
		[
			"(lambda alpha=lambda: 1, beta: alpha + beta,)",
			"(lambda alpha=lambda: 1, beta: alpha + beta)",
			false,
		],
	])("handles lambda commas in %s", (a, b, expected) => {
		expect(checker(`p = ${a}`, `p = ${b}`, ...pair("py"))).toBe(expected);
	});
});

describe("Python nested same-quote f-strings", () => {
	const line = (q: string, p = "f") =>
		`message = format_message(${p}${q}user {users[${q}primary${q}]} seen in {sites[${q}main${q}]} today${q}, retries, flag)`;

	it("rejects a reused quote inside a replacement field end to end", () => {
		const base = line('"');
		rejected([base], [base.replace('"primary"', '" primary "')], ...pair("py"));
	});

	it.each("f F rf fr Rf fR".split(" "))("rejects a %s-prefixed string", (p) => {
		expect(
			checker(`v = ${p}"{x["a"]}"`, `v = ${p}"{x[" a "]}"`, ...pair("py")),
		).toBe(false);
	});

	it("keeps f-strings that use the other quote, or only escaped braces", () => {
		const other = [
			"send(rows, f\"user {users['primary']} in\", retries, flag)",
		];
		expect(checker(other, other, ...pair("py"))).toBe(true);
		const plain = ['v = f"{{literal}} {name:{width}} done"'];
		expect(checker(plain, plain, ...pair("py"))).toBe(true);
	});
});

describe("YAML line mode", () => {
	const script = [
		"steps:",
		"  run: |",
		"    echo one",
		"",
		"    echo two",
		"  shell: bash",
		"  name: build-and-test",
		"  retries: 3",
	];
	const deeper = (lines: string[]) =>
		lines.map((l) => (l === "" ? l : `  ${l}`));
	const yaml = pair("yml");
	const server = [
		"server:",
		"  host: example.com",
		"  port: 8080",
		"  tls: true",
		"  retries: 3",
		"  timeout: 30",
	];

	it("claims nothing of a block scalar that lost an inner blank line", () => {
		const head = deeper(script.filter((l) => l !== ""));
		expect(checker(script, head, ...yaml)).toBe(false);
		const claimed = claimedLines(tokenPassOps(script, head, ...yaml));
		expect([11, 12, 13, 14].some((n) => claimed.includes(n))).toBe(false);
		expect(claimed).toEqual([]);
	});

	it.each(
		"key: |,key: >,key: |-,key: >+,key: | # note".split(","),
	)("rejects a line ending in %s", (line) => {
		expect(
			checker(
				["root:", `  ${line}`, "    text"],
				["  root:", `    ${line}`, "      text"],
				...yaml,
			),
		).toBe(false);
	});

	it("claims nothing of a line whose trailing whitespace differs", () => {
		const base = server.map((l) =>
			l.replace("host: example.com", "host: example.com  "),
		);
		const head = deeper(base.map((l) => l.trimEnd()));
		expect(checker(base, head, ...yaml)).toBe(false);
		expect(claimedLines(tokenPassOps(base, head, ...yaml))).not.toContain(11);
	});

	it.each([
		"`x`",
		'"""x"""',
		"'''x'''",
		"<<EOF",
	])("drops a claim holding %s", (text) => {
		expect(
			checker(
				["root:", `  key: ${text}`],
				["  root:", `    key: ${text}`],
				...yaml,
			),
		).toBe(false);
	});
});

describe("line breaks inside braces of Go", () => {
	it("keeps a line break inside a function literal in a call", () => {
		rejected(
			["value := compute(func() int { first", "-second }, alpha, beta)"],
			"value := compute(func() int { first -second }, alpha, beta)",
			...pair("go"),
		);
	});
});

const EXPRESSION_WORDS =
	"default case delete void typeof in of instanceof new throw yield await else do return".split(
		" ",
	);

describe("slashes that may open a regex literal", () => {
	it("rejects a regex after a parenthesis or default end to end", () => {
		rejected(
			[
				"if (alpha_value &&",
				"  beta_value) /x y/.test(source_text) && run_handler(alpha_value);",
			],
			[
				"if (alpha_value &&",
				"  beta_value) /x  y/.test(source_text) && run_handler(alpha_value);",
			],
			"src/a.ts",
			"src/b.ts",
			true,
		);
		rejected(
			"export default /a  b/g.test(value) && alpha(beta, gamma, delta);",
			"export default /a b/g.test(value) && alpha(beta, gamma, delta);",
			"src/a.ts",
			"src/b.ts",
			true,
		);
	});

	it.each(
		EXPRESSION_WORDS,
	)("treats a slash after %s as a regex start", (word) => {
		expect(checker(`v = ${word} /a  b/g;`, `v = ${word} /a b/g;`)).toBe(false);
		expect(literalSafe([`v = ${word} /a  b/g;`], "a.js")).toBe(false);
	});

	it("treats a slash after any closing parenthesis as ambiguous", () => {
		expect(
			checker("x = (a + b) / 2;", "x = (a + b)  / 2;", "a.js", "b.js"),
		).toBe(false);
		expect(literalSafe(["x = (a + b) / 2;"], "a.js")).toBe(false);
	});

	it.each([
		"x = total / count;",
		"x = list[0] / 2;",
		"x = 10 / count;",
		"x = v[i] / v[j];",
	])("still treats division in %s as safe", (line) => {
		expect(literalSafe([line], "a.js")).toBe(true);
		expect(checker([line], [line.replace(" / ", "/")], "a.js", "b.js")).toBe(
			true,
		);
	});
});

describe("JSX text keeps its whitespace, commas and quotes", () => {
	const text = "    Hello  world and welcome back to the dashboard today";
	const respaced = text.replace("  world", " world");

	it.each(
		"tsx jsx js mjs cjs".split(" "),
	)("rejects collapsed text in %s end to end", (ext) => {
		rejected(["<p>", text], ["<p>", respaced], ...pair(ext), true);
	});

	it("rejects a dropped comma in tsx end to end", () => {
		rejected(
			["<Foo>", "  see (alpha,) here and there for more text content"],
			["<Foo>", "  see (alpha) here and there for more text content"],
			...pair("tsx"),
			true,
		);
	});

	it("rejects bare text in tsx", () => {
		expect(checker([text], [respaced], "a.tsx", "b.tsx")).toBe(false);
	});

	it.each([
		"<Foo.Bar prop>",
		"</Foo>",
		"<br />",
		"<>",
		"x = <a-b>",
	])("sees %s as an element start", (line) => {
		expect(checker([line], [line], "a.js", "b.js")).toBe(false);
	});

	it("rejects when only one side shows an element", () => {
		expect(checker(["< b >", text], ["<b>", text], "a.js", "b.js")).toBe(false);
		expect(checker(["<b>", text], ["< b >", text], "a.js", "b.js")).toBe(false);
	});

	it("keeps matching a TypeScript move whose lines hold generics", () => {
		const line =
			"const r: Promise<Array<string>> = compute(alpha, beta, gamma, delta);";
		accepted(line, [
			"const r: Promise<Array<string>> = compute(",
			"  alpha,",
			"  beta,",
			"  gamma,",
			"  delta",
			");",
		]);
	});
});

function readCounter(tokens: string[]) {
	let reads = 0;
	const proxy = new Proxy(tokens, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) reads++;
			return Reflect.get(target, key, receiver);
		},
	});
	return { proxy, reads: () => reads };
}

describe("deep nesting and long lines stay linear", () => {
	const DEPTH = 20_000;
	const repeat = (n: number, ...unit: string[]) =>
		Array.from({ length: n }, () => unit).flat();

	it.each([
		"py",
		"go",
		"js",
	])("normalizes %s tokens with a linear number of reads", (ext) => {
		const tokens = [...repeat(DEPTH, "["), "x", ...repeat(DEPTH, ",", "]")];
		const counter = readCounter(tokens);
		normalizeTokens(counter.proxy, `a.${ext}`);
		expect(counter.reads()).toBeLessThan(20 * tokens.length);
	});

	it("scans empty-body back-references with a linear number of reads", () => {
		const tokens = [
			...repeat(DEPTH, "("),
			"x",
			...repeat(DEPTH, ")", ";", "}"),
		];
		const counter = readCounter(tokens);
		normalizeTokens(counter.proxy, "a.js");
		expect(counter.reads()).toBeLessThan(20 * tokens.length);
	});

	it.each([
		"py",
		"go",
		"js",
	])("refuses a %s block nested 20000 deep quickly", (ext) => {
		const chunks = DEPTH / 400;
		const lines = [
			...Array<string>(chunks).fill("[".repeat(400)),
			"x",
			...Array<string>(chunks).fill(",]".repeat(400)),
			...(ext === "py" ? [] : [";"]),
		];
		const started = performance.now();
		expect(checker(lines, lines, `a.${ext}`, `b.${ext}`)).toBe(false);
		expect(performance.now() - started).toBeLessThan(5000);
	});

	it("accepts brackets nested 200 deep and refuses 201, in both passes", () => {
		const nest = (d: number, q: string) =>
			`${"[".repeat(d)}${q}a${q}, ${q}b${q}, c${"]".repeat(d)};`;
		const swapped = (d: number) => checker([nest(d, "'")], [nest(d, '"')]);
		expect(swapped(200)).toBe(true);
		expect(swapped(201)).toBe(false);
		const ops = (d: number) =>
			tokenPassOps([nest(d, "'")], [nest(d, '"')], "src/a.ts", "src/b.ts");
		expect(ops(200)).toHaveLength(1);
		expect(ops(201)).toEqual([]);
	});

	const unit = (u: string, chars: number) =>
		u.repeat(Math.ceil(chars / u.length));

	it.each(
		"a/a/a/ (b)/c+".split(" "),
	)("refuses a 160KB line of %s everywhere", (u) => {
		const line = `x = ${unit(u, 160_000)}1;`;
		const started = performance.now();
		expect(checker([line], `${line} `, "a.js", "b.js")).toBe(false);
		expect(literalSafe([line], "a.js")).toBe(false);
		expect(tokenPassOps([line], [line], "src/a.ts", "src/b.ts")).toEqual([]);
		expect(performance.now() - started).toBeLessThan(5000);
	});
});

describe("narrowed eligibility", () => {
	it("lists only the trusted families in both passes", () => {
		const trusted = "js jsx mjs cjs ts tsx py pyi go yml yaml".split(" ");
		expect(FAMILIES.flat().sort()).toEqual([...trusted].sort());
		expect(CHECKER_FAMILIES.flat().sort()).toEqual([...trusted].sort());
	});

	it("pins the tables the checker intentionally duplicates: operators per language", () => {
		for (const ext of ["ts", "js", "py", "go"]) {
			expect([...checkerOperatorsFor(ext)].sort()).toEqual(
				[...operatorsFor(ext)].sort(),
			);
		}
		expect(operatorsFor("go")).toContain("<-");
		expect(operatorsFor("ts")).not.toContain("<-");
		expect(checkerOperatorsFor("ts")).not.toContain("<-");
	});
});

describe("final review holes", () => {
	const tail = "alpha + beta + gamma + delta + epsilon + zeta;";

	it("tells x<--y from x<- -y in JavaScript and TypeScript", () => {
		for (const ext of ["js", "ts"]) {
			rejected(
				"if (x<--y) z(a, b, c, d, e, f);",
				"if (x<- -y) z(a, b, c, d, e, f);",
				...pair(ext),
			);
		}
		expect(checker("ch <- v", "ch <-  v", ...pair("go"))).toBe(true);
		expect(checker("ch <- v", "ch < -v", ...pair("go"))).toBe(false);
	});

	it.each(
		"public private protected readonly override accessor using".split(" "),
	)("keeps the line break after %s", (word) => {
		rejected(
			[`class A { ${word}`, `x = ${tail} }`],
			`class A { ${word} x = ${tail} }`,
		);
	});

	it("tells a combining mark that joins a word from a split one", () => {
		rejected(["x = e\u0301", `z = 2; ${tail}`], [`x = e\u0301z = 2; ${tail}`]);
	});

	it.each([
		"\u00a0",
		"\u2003",
		"\u3000",
		"\ufeff",
	])("refuses %j as whitespace in code", (mark) => {
		for (const ext of ["ts", "py", "go", "yml"]) {
			expect(
				checker(`a =${mark}b + c + d`, "a = b + c + d", ...pair(ext)),
			).toBe(false);
		}
		expect(opaqueLine(`a =${mark}b`, "a.ts")).toBe(true);
	});

	it.each([
		"{ for await (a of b) ; }",
		"{ with (a) ; }",
		"{ if (a) b; else ; }",
		"{ l: ; }",
	])("keeps the semicolon in %s", (code) => {
		expect(checker(code, code.replace(/ ?; }/, " }"))).toBe(false);
		const tokens = tokenize([code], "a.ts").tokens;
		expect(normalizeTokens(tokens, "a.ts")).toContain(";");
	});

	it("reads block scalar indicators with an indent digit in either order", () => {
		for (const line of ["k: |2-", "k: >1+", "k: |-2", "k: >+1"])
			expect(yamlOpaqueLines([line])).toEqual([true]);
	});

	it("lets a trailing backslash continue a string in a patch", () => {
		expect(opensUnclosedString("a.ts", "+x = 'abc")).toBe(true);
		expect(opensUnclosedString("a.ts", "+x = 'abc\\")).toBe(false);
	});

	it("scans a hostile f-string line in linear time", () => {
		const lines = Array.from(
			{ length: 20 },
			() => "f'".repeat(400) + "{".repeat(1000),
		);
		const started = performance.now();
		expect(checker(lines, lines, ...pair("py"))).toBe(false);
		for (const line of lines) opaqueLine(line, "a.py");
		expect(performance.now() - started).toBeLessThan(3000);
	});

	it.each([
		"ts",
		"js",
		"py",
		"go",
	])("skips a %s file whose patch opens a string it does not close", (ext) => {
		const open = ext === "py" ? "x = 'abc" : 'x = "abc';
		const clean =
			ext === "py" ? "x = 'abc'  # it's fine" : 'x = "abc"; // it\'s fine';
		const at = (line: string) =>
			file(`src/a.${ext}`, `@@ -1,2 +1,2 @@\n ${line}\n-y = 1`);
		expect(filesWithLiterals([at(open)]).has(`src/a.${ext}`)).toBe(true);
		expect(filesWithLiterals([at(clean)]).has(`src/a.${ext}`)).toBe(false);
		for (const line of [" * it's a doc comment", "x = 'abc\\"]) {
			expect(filesWithLiterals([at(line)]).has(`src/a.${ext}`)).toBe(false);
		}
	});

	it("keeps a blank line inside a multi-line YAML scalar", () => {
		const base = [
			"root:",
			"  text: first part of the text",
			"",
			"    second part after the blank",
			"  other: 1",
			"  more: 2",
		];
		const deeper = (l: string[]) => l.map((x) => (x ? `  ${x}` : x));
		const without = base.filter((l) => l !== "");
		for (const [from, to] of [
			[base, deeper(without)],
			[without, deeper(base)],
		] as const) {
			expect(checker(from, to, ...pair("yml"))).toBe(false);
			const claimed = claimedLines(tokenPassOps(from, to, ...pair("yml")));
			expect(claimed).not.toContain(11);
			expect(claimed.includes(12) && from === base).toBe(false);
		}
		accepted(base, deeper(base), ...pair("yml"));
	});

	it.each([
		"key: |2-",
		"key: >1+",
		"key: |-2",
		"key: >+1",
	])("rejects the indicator in %s", (line) => {
		expect(
			checker(
				["root:", `  ${line}`, "    text"],
				["  root:", `    ${line}`, "      text"],
				...pair("yml"),
			),
		).toBe(false);
	});
});

describe("line breaks that are not obviously a wrap", () => {
	const more = "alpha + beta + gamma + delta;";

	it.each([
		["const a = 1\nconst b = 2", `const a = 1 const b = 2`],
		["a = b\nc = d", "a = b c = d"],
		["x\nfoo()", "x foo()"],
		["let a\nlet b", "let a let b"],
		[
			"const el = lookup()!\nconst next = 1",
			"const el = lookup()! const next = 1",
		],
		[
			"type X = Array<string>\nconst y = 1",
			"type X = Array<string> const y = 1",
		],
	])("keeps the break in %j", (base, head) => {
		const [b, h] = [
			`${base} ${more}`.split("\n"),
			`${head} ${more}`.split("\n"),
		];
		for (const ext of ["ts", "js"]) rejected(b, h, ...pair(ext));
	});

	it.each([
		[
			"call args",
			"const r = compute(alpha, beta, gamma, delta, epsilon, zeta);",
			[
				"const r = compute(",
				"  alpha,",
				"  beta,",
				"  gamma,",
				"  delta,",
				"  epsilon,",
				"  zeta",
				");",
			],
		],
		[
			"ternary",
			"const r = ready ? alphaValue(betaValue) : gammaValue(deltaValue);",
			[
				"const r = ready",
				"  ? alphaValue(betaValue)",
				"  : gammaValue(deltaValue);",
			],
		],
		[
			"chain",
			"const r = items.filter(isReady).map(toValue).reduce(sumAll, 0);",
			[
				"const r = items",
				"  .filter(isReady)",
				"  .map(toValue)",
				"  .reduce(sumAll, 0);",
			],
		],
		[
			"arrow",
			"const f = (alpha, beta) => alpha.value + beta.value + gamma.value;",
			[
				"const f = (alpha, beta) =>",
				"  alpha.value + beta.value + gamma.value;",
			],
		],
		[
			"Allman",
			"function handler(request, response) { return respond(request, response); }",
			[
				"function handler(request, response)",
				"{",
				"  return respond(request, response);",
				"}",
			],
		],
	])("still matches a Prettier wrap of %s", (_, flat, wrapped) => {
		accepted(flat, wrapped);
		accepted(wrapped, flat);
	});
});

describe("block comment bodies", () => {
	const statements = Array.from(
		{ length: 5 },
		(_, i) => `const setting${i} = processOption(accountId, customerId, ${i});`,
	);
	const wrapped = statements.flatMap((l) => [l.slice(0, 22), l.slice(22)]);

	it.each([
		"ts",
		"js",
		"tsx",
		"go",
	])("skips a %s file whose changed lines sit inside a comment", (ext) => {
		const head = file(
			`src/b.${ext}`,
			["@@ -1,2 +1,12 @@", " /*", ...wrapped.map((l) => `+${l}`), " */"].join(
				"\n",
			),
		);
		const base = file(
			`src/a.${ext}`,
			["@@ -1,5 +1,0 @@", ...statements.map((l) => `-${l}`)].join("\n"),
		);
		expect(filesWithLiterals([head]).has(head.filename)).toBe(true);
		expect(findRelocations([base, head]).filter((o) => o.exact)).toEqual([]);
	});

	it.each([
		["a closer without an opener", " */\n+x = 1;"],
		["an opener without a closer", "+/* note\n y = 2;"],
		["a changed row inside a comment", " /*\n+x = 1;\n */"],
	])("flags %s", (_, body) => {
		const patch = `@@ -1 +1 @@\n${body}`;
		expect(unbalancedBlockComment("a.ts", patch)).toBe(true);
		expect(filesWithLiterals([file("a.ts", patch)]).has("a.ts")).toBe(true);
	});

	it("leaves balanced comments alone", () => {
		expect(unbalancedBlockComment("a.ts", " /* c */\n+x = 1;\n+/**/")).toBe(
			false,
		);
	});
});

describe("review round fixes", () => {
	it("keeps a statement break the way greptile reported it", () => {
		const base = [
			"function total(items) { const subtotal = computeSubtotal(items)",
			"return subtotal + calculateTax(items); }",
		];
		rejected(base, base.join(" "));
	});

	it("rejects an f-string whose field hides a quote behind an inner brace pair", () => {
		const base =
			'message = render_message(f"{ {} or users["primary"] }", request_id, account_id)';
		rejected(base, base.replace('"primary"', '" primary "'), ...pair("py"));
		expect(opaqueLine(base, "a.py")).toBe(true);
		expect(opaqueLine('v = f"{compute(a,', "a.py")).toBe(true);
		expect(opaqueLine('v = f"{a} {b[1]}" + "x"', "a.py")).toBe(false);
		expect(
			checker('v = f"{a} and {b[1]}"', 'v = f"{a}  and {b[1]}"', ...pair("py")),
		).toBe(false);
		expect(
			checker('v = f"{a} {b[1]}"', 'v = f"{a} {b[1]}"', ...pair("py")),
		).toBe(true);
	});

	it("skips a YAML file whose context line holds a block scalar header", () => {
		const body = Array.from(
			{ length: 5 },
			(_, i) => `  line ${i} of the script text`,
		);
		const head = file(
			"ci/b.yml",
			["@@ -1,1 +1,6 @@", " script: |2", ...body.map((l) => `+  ${l}`)].join(
				"\n",
			),
		);
		const base = file(
			"ci/a.yml",
			["@@ -1,5 +1,0 @@", ...body.map((l) => `-${l}`)].join("\n"),
		);
		expect(filesWithLiterals([head]).has("ci/b.yml")).toBe(true);
		expect(findRelocations([base, head]).filter((o) => o.exact)).toEqual([]);
		expect(hasBlockScalarHeader("b.yml", "@@ -1 +1 @@\n script: |2")).toBe(
			true,
		);
	});
});
