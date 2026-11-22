/** Receiver edits the classifier must treat as code (writes, bindings, fragments) or may keep as receiver (read-only lines). */
const PY_FILLER = [
	"rows = load_rows(items, n)",
	"keys = build_keys(rows, items)",
	"check_keys(keys, rows)",
	"flush_keys(keys, rows, n)",
];
const TS_FILLER = [
	"const rows = loadRows(items, n);",
	"const keys = buildKeys(rows, items);",
	"checkKeys(keys, rows);",
	"flushKeys(keys, rows, n);",
];
export interface ReceiverCase {
	name: string;
	lang: "py" | "ts";
	base: string[];
	head: string[];
}
export const WRITE_CASES: ReceiverCase[] = [
	{
		name: "chained assignment",
		lang: "py",
		base: ["t = count = n"],
		head: ["t = self.count = n"],
	},
	{
		name: "second statement assignment",
		lang: "py",
		base: ["v = 1; count = n"],
		head: ["v = 1; self.count = n"],
	},
	{
		name: "assignment inside an arrow body",
		lang: "ts",
		base: ["const g = () => { count = n; };"],
		head: ["const g = () => { this.count = n; };"],
	},
	{
		name: "increment",
		lang: "ts",
		base: ["count++;"],
		head: ["this.count++;"],
	},
	{
		name: "pre-increment",
		lang: "ts",
		base: ["++count;"],
		head: ["++this.count;"],
	},
	{
		name: "increment inside a for header",
		lang: "ts",
		base: ["for (let i = 0; i < n; count++) { run(i); }"],
		head: ["for (let i = 0; i < n; this.count++) { run(i); }"],
	},
	{
		name: "for target",
		lang: "py",
		base: ["for count in items:"],
		head: ["for self.count in items:"],
	},
	{
		name: "del target",
		lang: "py",
		base: ["del count"],
		head: ["del self.count"],
	},
	{
		name: "with target",
		lang: "py",
		base: ["with open(n) as count:"],
		head: ["with open(n) as self.count:"],
	},
	{
		name: "comprehension target",
		lang: "py",
		base: ["out = [count for count in items]"],
		head: ["out = [self.count for self.count in items]"],
	},
	{
		name: "delete",
		lang: "ts",
		base: ["delete cache[n];"],
		head: ["delete this.cache[n];"],
	},
	{
		name: "for of target",
		lang: "ts",
		base: ["for (cur of items) { run(cur); }"],
		head: ["for (this.cur of items) { run(cur); }"],
	},
	{
		name: "for in target",
		lang: "ts",
		base: ["for (cur in items) { run(cur); }"],
		head: ["for (this.cur in items) { run(cur); }"],
	},
	{
		name: "target alone on a line",
		lang: "ts",
		base: ["count", "  = n;"],
		head: ["this.count", "  = n;"],
	},
	{
		name: "destructuring target across lines",
		lang: "ts",
		base: ["[", "  a,", "  b", "] = pair(n);"],
		head: ["[", "  this.a,", "  b", "] = pair(n);"],
	},
	{
		name: "backslash continuation",
		lang: "py",
		base: ["total = \\", "    helper(n)"],
		head: ["self.total = \\", "    helper(n)"],
	},
	{
		name: "call arguments swapped across lines",
		lang: "ts",
		base: ["foo(", "  this.a,", "  b);"],
		head: ["foo(", "  a,", "  this.b);"],
	},
];
export const READ_CASES: ReceiverCase[] = [
	{
		name: "return of an expression",
		lang: "py",
		base: ["return rate * n"],
		head: ["return self.rate * n"],
	},
	{
		name: "single argument call",
		lang: "py",
		base: ["log(name, n)"],
		head: ["log(self.name, n)"],
	},
	{
		name: "multi-argument call on one line",
		lang: "py",
		base: ["process(a, b, c, d)"],
		head: ["self.process(a, b, c, d)"],
	},
];

export function scaffold(c: ReceiverCase, side: "base" | "head"): string[] {
	const lines = side === "base" ? c.base : c.head;
	if (c.lang === "py") {
		const body = [...PY_FILLER, ...lines];
		return side === "base"
			? ["def run(items, n):", ...body.map((l) => `    ${l}`)]
			: ["    def run(self, items, n):", ...body.map((l) => `        ${l}`)];
	}
	const body = [...TS_FILLER, ...lines];
	return side === "base"
		? [
				"function run(items: Item[], n: number): number {",
				...body.map((l) => `  ${l}`),
				"  return n;",
				"}",
			]
		: [
				"  run(items: Item[], n: number): number {",
				...body.map((l) => `    ${l}`),
				"    return n;",
				"  }",
			];
}
