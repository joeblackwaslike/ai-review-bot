import { describe, expect, it } from "vitest";
import { collectRuns, type PushFile } from "../moved-blocks.js";
import { WorkBudget } from "./budget.js";
import { literalSafe } from "./lexical.js";
import { findRelocations } from "./relocation.js";
import {
	CHECKER_FAMILIES,
	CHECKER_OPERATORS,
	tokenEquivalent,
} from "./token-check.js";
import {
	FAMILIES,
	filesWithLiterals,
	findTokenOperations,
} from "./token-pass.js";
import { normalizeTokens, OPERATORS } from "./tokens.js";

type Src = string | string[];
const rows = (src: Src) => (Array.isArray(src) ? src : [src]);
const patch = (header: string, sign: string, lines: string[]) =>
	[header, ...lines.map((l) => `${sign}${l}`)].join("\n");

function filesOf(b: Src, h: Src, bf: string, hf: string) {
	const [base, head] = [rows(b), rows(h)];
	const file = (filename: string, p: string): PushFile => ({
		filename,
		status: "modified",
		patch: p,
		additions: 0,
		deletions: 0,
	});
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
	it.each([
		[
			"async",
			"function handler(request, response, next, options) { return 1; }",
		],
		["type", "AccountId = string | number | undefined | null | symbol;"],
		["declare", "function fetchAccount(id: string, retries: number): void;"],
		["const f = async", "request => request.body.items.map(item => item.id);"],
	])("rejects joining %s to the next line", (first, second) => {
		rejected([first, second], `${first} ${second}`);
	});

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
	const wrapped = [
		"result = process(",
		"    one_value,",
		"    two_value,",
		"    three_value,",
		"    four_value,",
		")",
	];
	const flat =
		"result = process(one_value, two_value, three_value, four_value)";

	it.each([
		[
			"python lambda tuple",
			"handler = (lambda alpha, beta: alpha + beta + gamma_value + delta,)",
			"py",
		],
		[
			"rust closure tuple",
			"let handler = (|alpha, beta| alpha + beta + gamma_value + delta,);",
			"rs",
		],
		[
			"rust generic tuple",
			"let handlers: (HashMap<String, Handler>,) = build_handlers(registry);",
			"rs",
		],
		[
			"kotlin call",
			"result = compute(alpha, beta, gamma, delta, epsilon, zeta,)",
			"kt",
		],
		[
			"dart call",
			"result = compute(alpha, beta, gamma, delta, epsilon, zeta,)",
			"dart",
		],
	])("keeps the comma of a %s", (_, line, ext) => {
		rejected([line], [line.replace(",)", ")")], ...pair(ext));
	});

	it.each(["rs", "kts", "swift"])("drops no trailing comma in %s", (ext) => {
		expect(checker("f(a, b,)", "f(a, b)", ...pair(ext))).toBe(false);
	});

	it.each(
		"java c h cpp hpp cs".split(" "),
	)("drops a comma before } after a sibling in %s", (ext) => {
		const line = "values = {first_value, second_value, third_value, fourth,};";
		accepted([line], [line.replace(",}", "}")], ...pair(ext));
	});

	it.each(["java", "c", "cs"])("keeps a comma before ) in %s", (ext) => {
		const line =
			"result = compute(first_value, second_value, third_value, fourth,);";
		rejected([line], [line.replace(",)", ")")], ...pair(ext));
		expect(checker("int v[] = {1,};", "int v[] = {1};", ...pair(ext))).toBe(
			false,
		);
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

describe("raw and verbatim strings", () => {
	it.each([
		[
			'let doc = r#"say "hello   there" and goodbye"#;',
			'let doc = r#"say "hello there" and goodbye"#;',
			"rs",
		],
		[
			'auto doc = R"(say "hello   there" and goodbye)";',
			'auto doc = R"(say "hello there" and goodbye)";',
			"cpp",
		],
		[
			'var doc = $"say {Format("hello   there")} and goodbye";',
			'var doc = $"say {Format("hello there")} and goodbye";',
			"cs",
		],
	])("rejects inner spacing changes in %s", (a, b, ext) => {
		rejected([a], [b], ...pair(ext), true);
	});

	it.each([
		["rs", 'let v = compute(r"alpha",  beta);'],
		["rs", 'let v = compute(br#"alpha"#,  beta);'],
		["c", 'const char *v = compute(R"x(alpha)x",  beta);'],
		["h", 'const char *v = compute(u8R"x(alpha)x",  beta);'],
		["hpp", 'auto v = compute(LR"(alpha)",  beta);'],
		["cs", 'var v = compute(@"alpha",  beta);'],
		["cs", 'var v = compute($"alpha",  beta);'],
	])("rejects any %s line holding a raw or verbatim string: %s", (ext, line) => {
		expect(checker([line], [line.replace("  ", " ")], ...pair(ext))).toBe(
			false,
		);
	});

	it("keeps lines whose ordinary strings merely end in r or R", () => {
		const rust = 'let m = f("user", "error", "filter", settings, defaults);';
		expect(checker([rust], [rust.replace(", ", ",  ")], ...pair("rs"))).toBe(
			true,
		);
		const cpp = 'call("OR", "FOR", first, second);';
		expect(checker([cpp], [cpp.replace(", ", ",  ")], ...pair("cpp"))).toBe(
			true,
		);
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
		expect(claimed.length).toBeGreaterThan(0);
	});

	it.each(
		"key: |,key: >,key: |-,key: >+,key: |2,key: |+1,key: | # note,- >-".split(
			",",
		),
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

describe("line breaks inside braces of line-significant languages", () => {
	it.each([
		[
			"kt",
			["val r = collection.map({ elementAlpha", "  -elementBeta })"],
			"val r = collection.map({ elementAlpha -elementBeta })",
		],
		[
			"go",
			["value := compute(func() int { first", "-second }, alpha, beta)"],
			"value := compute(func() int { first -second }, alpha, beta)",
		],
		[
			"dart",
			["final r = items.map((e) { first", "-second });"],
			"final r = items.map((e) { first -second });",
		],
	])("keeps a line break inside a %s lambda in a call", (ext, base, head) => {
		rejected(base, [head], ...pair(ext));
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
		"tsx jsx js mjs cjs ts".split(" "),
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

	it("rejects bare text in tsx and a lone element start in ts", () => {
		expect(checker([text], [respaced], "a.tsx", "b.tsx")).toBe(false);
	});

	it.each([
		"<Foo.Bar prop>",
		"</Foo>",
		"<br />",
		"<>",
		"x = <a-b>",
	])("sees %s as an element start", (line) => {
		expect(checker([line], [line])).toBe(false);
	});

	it("rejects when only one side shows an element", () => {
		expect(checker(["< b >", text], ["<b>", text])).toBe(false);
		expect(checker(["<b>", text], ["< b >", text])).toBe(false);
	});
});

describe("checker independence", () => {
	it("pins the operator table and the families", () => {
		expect([...CHECKER_OPERATORS].sort()).toEqual([...OPERATORS].sort());
		const lengths = CHECKER_OPERATORS.map((o) => o.length);
		expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
		expect(CHECKER_FAMILIES).toEqual(FAMILIES);
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

	it.each(
		"py rs js".split(" "),
	)("normalizes %s tokens with a linear number of reads", (ext) => {
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

	it.each(
		"py rs js".split(" "),
	)("refuses a %s block nested 20000 deep quickly", (ext) => {
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
