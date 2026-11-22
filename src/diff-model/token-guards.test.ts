import { describe, expect, it } from "vitest";
import { collectRuns, type PushFile } from "../moved-blocks.js";
import { WorkBudget } from "./budget.js";
import { findRelocations } from "./relocation.js";
import { tokenEquivalent } from "./token-check.js";
import { findTokenOperations } from "./token-pass.js";

function pushFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function deletedFrom(filename: string, lines: string[]) {
	return pushFile(
		filename,
		[`@@ -10,${lines.length} +9,0 @@`, ...lines.map((line) => `-${line}`)].join(
			"\n",
		),
	);
}

function addedTo(filename: string, lines: string[]) {
	return pushFile(
		filename,
		[`@@ -0,0 +3,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join(
			"\n",
		),
	);
}

interface GuardCase {
	name: string;
	base: string[];
	head: string[];
	baseFile?: string;
	headFile?: string;
}

function filesOf(c: GuardCase): PushFile[] {
	return [
		deletedFrom(c.baseFile ?? "src/a.ts", c.base),
		addedTo(c.headFile ?? "src/b.ts", c.head),
	];
}

function checkerSays(c: GuardCase): boolean {
	return tokenEquivalent(
		c.base,
		c.head,
		c.baseFile ?? "src/a.ts",
		c.headFile ?? "src/b.ts",
	).equivalent;
}

function matcherOps(c: GuardCase) {
	const { deleted, added } = collectRuns(filesOf(c));
	return findTokenOperations(
		deleted,
		added,
		new WorkBudget({ tokens: 1_000_000 }),
	);
}

function exactRelocations(c: GuardCase) {
	return findRelocations(filesOf(c)).filter((op) => op.exact);
}

function expectRejected(c: GuardCase) {
	expect(checkerSays(c)).toBe(false);
	expect(matcherOps(c)).toEqual([]);
	expect(exactRelocations(c)).toEqual([]);
}

function expectAccepted(c: GuardCase) {
	expect(checkerSays(c)).toBe(true);
	expect(matcherOps(c)).toHaveLength(1);
	expect(exactRelocations(c)).toHaveLength(1);
}

describe("restricted productions keep their line break", () => {
	const rejected: GuardCase[] = [
		{
			name: "async before function",
			base: [
				"async",
				"function handler(request, response, next, options) { return next(request); }",
			],
			head: [
				"async function handler(request, response, next, options) { return next(request); }",
			],
		},
		{
			name: "type before an alias body",
			base: [
				"type",
				"AccountId = string | number | undefined | null | symbol;",
			],
			head: ["type AccountId = string | number | undefined | null | symbol;"],
		},
		{
			name: "declare before a function",
			base: [
				"declare",
				"function fetchAccount(id: string, retries: number, flag: boolean): void;",
			],
			head: [
				"declare function fetchAccount(id: string, retries: number, flag: boolean): void;",
			],
		},
		{
			name: "async before an arrow parameter",
			base: [
				"const handler = async",
				"request => request.body.items.map(item => item.identifier);",
			],
			head: [
				"const handler = async request => request.body.items.map(item => item.identifier);",
			],
		},
	];
	it.each(rejected)("rejects $name", expectRejected);

	it.each([
		"async",
		"type",
		"declare",
		"abstract",
		"namespace",
		"module",
		"interface",
		"enum",
		"get",
		"set",
		"static",
		"let",
		"await",
	])("rejects joining a line that ends in %s to the next one", (word) => {
		const c: GuardCase = {
			name: word,
			base: [word, "target = alpha + beta + gamma + delta + epsilon;"],
			head: [`${word} target = alpha + beta + gamma + delta + epsilon;`],
		};
		expect(checkerSays(c)).toBe(false);
	});

	it("still accepts a wrap that keeps async on its own line of the statement", () => {
		expectAccepted({
			name: "wrapped async function",
			base: [
				"async function handler(request, response, next, options) { return next(request); }",
			],
			head: [
				"async function handler(request, response, next, options) {",
				"  return next(request);",
				"}",
			],
		});
	});
});

describe("whitespace that is a line terminator in other languages", () => {
	const marks: [string, string][] = [
		["a carriage return", "\r"],
		["a line separator", "\u2028"],
		["a paragraph separator", "\u2029"],
		["a vertical tab", "\v"],
		["a form feed", "\f"],
		["a next-line character", "\u0085"],
	];
	it.each(marks)("rejects %s inside a JavaScript line", (_, mark) => {
		const c: GuardCase = {
			name: "return split",
			base: [`return${mark} alpha + beta + gamma + delta + epsilon;`],
			head: ["return alpha + beta + gamma + delta + epsilon;"],
		};
		expect(checkerSays(c)).toBe(false);
	});

	it("rejects a carriage return inside a Python line end to end", () => {
		expectRejected({
			name: "python cr",
			base: ["total = alpha_value\r+ beta_value + gamma_value + delta_value"],
			head: ["total = alpha_value + beta_value + gamma_value + delta_value"],
			baseFile: "src/a.py",
			headFile: "src/b.py",
		});
	});

	it("rejects a JavaScript carriage return after return end to end", () => {
		expectRejected({
			name: "js cr",
			base: ["return\r alpha + beta + gamma + delta + epsilon + zeta;"],
			head: ["return alpha + beta + gamma + delta + epsilon + zeta;"],
		});
	});

	it("accepts one trailing carriage return", () => {
		const c: GuardCase = {
			name: "crlf",
			base: ["const total = alpha + beta + gamma + delta + epsilon + zeta;\r"],
			head: [
				"const total =",
				"  alpha + beta + gamma + delta + epsilon + zeta;",
			],
		};
		expect(checkerSays(c)).toBe(true);
	});
});

describe("JavaScript numbers and HTML-like comments", () => {
	it("tells 1.e3 from 1 .e3 end to end", () => {
		expectRejected({
			name: "exponent",
			base: ["const total = base + 1.e3 + tax + shipping + discount + fee;"],
			head: ["const total = base + 1 .e3 + tax + shipping + discount + fee;"],
		});
	});

	it.each([
		["0x1F", "0x1 F"],
		["1_000", "1 _000"],
		["10n", "10 n"],
		["1e+3", "1e + 3"],
	])("tells %s from %s", (a, b) => {
		const c: GuardCase = {
			name: a,
			base: [`const total = base + ${a} + tax + shipping + discount;`],
			head: [`const total = base + ${b} + tax + shipping + discount;`],
		};
		expect(checkerSays(c)).toBe(false);
	});

	it("rejects an HTML-like comment opener end to end", () => {
		expectRejected({
			name: "html comment",
			base: ["total = alpha<!--beta + gamma + delta + epsilon + zeta;"],
			head: ["total = alpha < !--beta + gamma + delta + epsilon + zeta;"],
		});
	});

	it("rejects an HTML-like comment closer at the start of a line", () => {
		expectRejected({
			name: "html close",
			base: ["total = 1;", "--> hidden(alpha, beta, gamma, delta, epsilon);"],
			head: ["total = 1;", "-- > hidden(alpha, beta, gamma, delta, epsilon);"],
		});
	});
});
