import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";
import { READ_CASES, scaffold, WRITE_CASES } from "./receiver-cases.fixture.js";
import { findRelocations } from "./relocation.js";
import { signatureRange } from "./reshape.js";
import type { Operation } from "./types.js";

function pushFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function deletedFrom(filename: string, start: number, lines: string[]) {
	return pushFile(
		filename,
		[
			`@@ -${start},${lines.length} +${start - 1},0 @@`,
			...lines.map((line) => `-${line}`),
		].join("\n"),
	);
}

function addedTo(filename: string, start: number, lines: string[]) {
	return pushFile(
		filename,
		[
			`@@ -0,0 +${start},${lines.length} @@`,
			...lines.map((line) => `+${line}`),
		].join("\n"),
	);
}

function move(
	baseName: string,
	headName: string,
	base: string[],
	head: string[],
): Operation[] {
	return findRelocations([
		deletedFrom(baseName, 10, base),
		addedTo(headName, 3, head),
	]);
}

function classes(op: Operation | undefined): string[] {
	return (op?.divergences ?? []).map((d) => d.class);
}

const PY_FUNCTION = [
	"def total_price(items, tax_rate):",
	"    subtotal = sum(item.price * item.qty for item in items)",
	"    taxed = subtotal * (1 + tax_rate)",
	"    rounded = round(taxed, 2)",
	"    log_total(rounded, len(items))",
	"    return rounded",
];
const PY_METHOD = [
	"    def total(self, items):",
	"        subtotal = sum(item.price * item.qty for item in items)",
	"        taxed = subtotal * (1 + self.tax_rate)",
	"        rounded = round(taxed, 2)",
	"        self.log_total(rounded, len(items))",
	"        return rounded",
];

const TS_FUNCTION = [
	"function applyDiscount(cart: Cart, code: string): number {",
	"  const rate = lookupRate(code);",
	"  const gross = totalOf(cart);",
	"  recordDiscount(cart.id, code, gross);",
	"  const net = applyRate(gross, rate);",
	"  return finalize(net, code);",
	"}",
];
const TS_METHOD = [
	"  discount(cart: Cart, code: string): number {",
	"    const rate = this.lookupRate(code);",
	"    const gross = this.totalOf(cart);",
	"    this.recordDiscount(cart.id, code, gross);",
	"    const net = this.applyRate(gross, rate);",
	"    return this.finalize(net, code);",
	"  }",
];

describe("signatureRange", () => {
	it("returns the opening line of a four-line signature", () => {
		expect(
			signatureRange(
				[
					"const x = 1;",
					"function buildReport(",
					"  rows: Row[],",
					"  options: Options,",
					"): Report {",
				],
				"a.ts",
			),
		).toEqual({ start: 1, end: 4 });
	});

	it("includes decorators directly above the opening line", () => {
		expect(
			signatureRange(
				["x = 1", "@retry(times=3)", "@cached", "def f(a,", "      b):"],
				"a.py",
			),
		).toEqual({ start: 1, end: 4 });
	});

	it("returns null when the lines above are not a definition", () => {
		expect(signatureRange(["const x = compute(1);"], "a.ts")).toBeNull();
		expect(signatureRange(["  if (ready(x)) {"], "a.ts")).toBeNull();
		expect(signatureRange(["x = compute(1)"], "a.py")).toBeNull();
	});

	it("returns null when the opening line has no block terminator", () => {
		expect(signatureRange(["def f(x) -> int"], "a.py")).toBeNull();
		expect(signatureRange(["process(items): number"], "a.ts")).toBeNull();
	});

	it("returns null when the brackets of the candidate do not balance", () => {
		expect(signatureRange(["foo(bar, {"], "a.ts")).toBeNull();
	});

	it("does not swallow body lines into a Python signature", () => {
		expect(
			signatureRange(["def f(x):", "    a = 1", "    if y:"], "a.py"),
		).toBeNull();
	});

	it("returns null for files outside the reshape languages", () => {
		expect(signatureRange(["func f(x int) {"], "a.go")).toBeNull();
		expect(signatureRange(["def f(x)"], "a.rb")).toBeNull();
	});
});

describe("reshape matching", () => {
	it("pairs a function with the method it became despite a new name and parameters", () => {
		const ops = move("src/pricing.py", "src/cart.py", PY_FUNCTION, PY_METHOD);
		expect(ops).toHaveLength(1);
		const op = ops[0] as Operation;
		expect(op.from[0]).toMatchObject({ startLine: 10, endLine: 15 });
		expect(op.to[0]).toMatchObject({ startLine: 3, endLine: 8 });
		expect(classes(op)).toEqual(["signature", "code", "receiver"]);
		expect(op.shape).toEqual({ reindent: 4 });
		expect(op.exact).toBe(false);
		expect(op.reviewWeight).toBe(3);
	});

	it("reports every line of a four-line signature", () => {
		const base = [
			"def build_report(",
			"    rows,",
			"    options,",
			"):",
			"    grouped = group_rows(rows, options.group_by)",
			"    totals = [sum_group(g, options.currency) for g in grouped]",
			"    header = render_header(options.title, len(totals))",
			"    sink.write(header)",
			"    return header, totals, grouped",
		];
		const head = [
			"    def build(self, rows, options):",
			...base.slice(4).map((l) => `    ${l}`),
		];
		const ops = move("src/report.py", "src/builder.py", base, head);
		expect(ops).toHaveLength(1);
		const sig = (ops[0] as Operation).divergences;
		expect(sig.map((d) => d.class)).toEqual([
			"signature",
			"signature",
			"signature",
			"signature",
		]);
		expect(sig.map((d) => d.kind)).toEqual([
			"changed",
			"removed",
			"removed",
			"removed",
		]);
		expect(sig.map((d) => d.original)).toEqual([
			"def build_report(",
			"rows,",
			"options,",
			"):",
		]);
		expect((ops[0] as Operation).reviewWeight).toBe(4);
	});

	it("reports a gained this. prefix as a receiver divergence with the original line", () => {
		const ops = move("src/discount.ts", "src/cart.ts", TS_FUNCTION, TS_METHOD);
		expect(ops).toHaveLength(1);
		const receivers = (ops[0] as Operation).divergences.filter(
			(d) => d.class === "receiver",
		);
		expect(receivers.map((d) => d.original)).toEqual([
			"recordDiscount(cart.id, code, gross);",
			"return finalize(net, code);",
		]);
		expect(receivers[0]).toMatchObject({
			kind: "changed",
			base: { startLine: 13, endLine: 13 },
			head: { startLine: 6, endLine: 6 },
		});
		expect(classes(ops[0])).toContain("signature");
	});

	it("reports a self. prefix removed in method-to-function", () => {
		const ops = move("src/cart.py", "src/pricing.py", PY_METHOD, PY_FUNCTION);
		expect(ops).toHaveLength(1);
		const receivers = (ops[0] as Operation).divergences.filter(
			(d) => d.class === "receiver",
		);
		expect(receivers.map((d) => d.original)).toEqual([
			"self.log_total(rounded, len(items))",
		]);
	});

	it("keeps weight at least 1 when only receiver lines differ", () => {
		const base = [
			"  process(items: Item[]): number {",
			"    const cleaned = this.sanitize(items);",
			"    const total = this.sumCosts(cleaned);",
			"    this.audit(cleaned.length, total);",
			"    const out = this.finish(total);",
			"    return this.publish(out);",
			"  }",
		];
		const head = base.map((l) => l.replace("this.", ""));
		const ops = move("src/a.ts", "src/b.ts", base, head);
		expect(ops).toHaveLength(1);
		expect(classes(ops[0])).toEqual([
			"code",
			"code",
			"receiver",
			"code",
			"receiver",
		]);
		expect((ops[0] as Operation).exact).toBe(false);
		expect((ops[0] as Operation).reviewWeight).toBe(4);
	});

	it("does not pair unrelated functions that share a four-line body", () => {
		const ops = move(
			"src/a.py",
			"src/b.py",
			[
				"def bump(value):",
				"    x = y + 1",
				"    z = x * 2",
				"    w = z - x",
				"    return w",
			],
			[
				"    def step(self, counter):",
				"        x = y + 1",
				"        z = x * 2",
				"        w = z - x",
				"        return w",
			],
		);
		expect(ops).toEqual([]);
	});

	it("does not reshape across languages", () => {
		const base = [
			"function total(items: Item[], rate: number): number {",
			"  const rows = loadRows(items);",
			"  const keys = buildKeys(rows, rate);",
			"  const index = buildIndex(keys);",
			"  check(index, rows.length);",
			"  return wrap(index);",
			"}",
		];
		const head = [
			"  total(items: Item[], rate: number): number {",
			"    const rows = this.loadRows(items);",
			"    const keys = this.buildKeys(rows, rate);",
			"    const index = this.buildIndex(keys);",
			"    this.check(index, rows.length);",
			"    return this.wrap(index);",
			"  }",
		];
		expect(move("src/a.ts", "src/b.ts", base, head)).toHaveLength(1);
		expect(move("src/a.ts", "src/b.java", base, head)).toEqual([]);
	});

	it("leaves signature lines the line matcher claimed to the line matcher", () => {
		const signature = [
			"@cached",
			"def build(",
			"    rows,",
			"    options,",
			"    sink,",
			"):",
		];
		const base = [
			...signature,
			"    grouped = self.group_rows(rows, options)",
			"    totals = self.sum_groups(grouped, options)",
			"    header = self.render_header(options, totals)",
			"    self.write_header(sink, header)",
			"    footer = self.render_footer(options, totals)",
			"    self.write_footer(sink, footer)",
			"    stats = self.collect(grouped, totals)",
			"    return self.finish(header, stats)",
		];
		const head = [
			...signature,
			...base.slice(6).map((l) => l.replace("self.", "")),
		];
		const ops = move("src/report.py", "src/builder.py", base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.from[0]?.startLine).toBe(10);
		expect(classes(ops[0])).not.toContain("signature");
	});

	it("leaves a function without a signature on one side to the plain token pass", () => {
		const base = PY_FUNCTION.slice(1);
		const head = [
			"    def total(self, items):",
			...PY_FUNCTION.slice(1).map((l) => `    ${l}`),
		];
		const ops = move("src/pricing.py", "src/cart.py", base, head);
		expect(ops).toHaveLength(1);
		expect((ops[0] as Operation).exact).toBe(true);
		expect((ops[0] as Operation).divergences).toEqual([]);
	});

	it("rejects a Python body whose relative structure changed", () => {
		const base = [
			"def sum_prices(items):",
			"    total = 0",
			"    for item in items:",
			"        total += item.price",
			"    log_total(total, len(items))",
			"    return total",
		];
		const head = [
			"    def sum_prices(self, items):",
			"        total = 0",
			"        for item in items:",
			"        total += item.price",
			"        self.log_total(total, len(items))",
			"        return total",
		];
		expect(move("src/a.py", "src/b.py", base, head)).toEqual([]);
	});

	it("includes decorators directly above the signature as signature divergences", () => {
		const base = ["@retry(times=3)", "def fetch_total(order_id, client):"];
		const head = ["    @cached", "    def fetch(self, order_id):"];
		const body = [
			"    order = load_order(order_id)",
			"    lines = expand(order.lines, order.currency)",
			"    total = sum(line.amount for line in lines)",
			"    audit(order_id, total, len(lines))",
			"    return total",
		];
		const ops = move(
			"src/orders.py",
			"src/service.py",
			[...base, ...body],
			[...head, ...body.map((l) => `    ${l}`)],
		);
		expect(ops).toHaveLength(1);
		const sig = (ops[0] as Operation).divergences.filter(
			(d) => d.class === "signature",
		);
		expect(sig.map((d) => d.original)).toEqual([
			"@retry(times=3)",
			"def fetch_total(order_id, client):",
		]);
		expect((ops[0] as Operation).from[0]).toMatchObject({ startLine: 10 });
	});

	it("matches a method moved out of a class to a free function with indent -4", () => {
		const base = [
			"    def render(self, rows):",
			"        header = make_header(rows)",
			"        body = [format_row(row) for row in rows]",
			"        footer = make_footer(len(rows))",
			"        emit(header, body, footer)",
			"        return header",
		];
		const head = [
			"def render_rows(rows):",
			"    header = make_header(rows)",
			"    body = [format_row(row) for row in rows]",
			"    footer = make_footer(len(rows))",
			"    emit(header, body, footer)",
			"    return header",
		];
		const ops = move("src/view.py", "src/render.py", base, head);
		expect(ops).toHaveLength(1);
		expect((ops[0] as Operation).shape).toEqual({ reindent: -4 });
		expect(classes(ops[0])).toEqual(["signature"]);
	});
});

function indented(lines: string[], by: number): string[] {
	return lines.map((l) => `${" ".repeat(by)}${l}`);
}

describe("reshape decorators", () => {
	const plain = [
		"rows = load_rows(a)",
		"keys = build_keys(rows, a)",
		"index = build_index(keys)",
		"check(index, len(rows))",
		"return wrap(index)",
	];
	const withCls = [
		"rows = cls.load_rows(a)",
		"keys = cls.build_keys(rows, a)",
		"index = cls.build_index(keys)",
		"cls.check(index, len(rows))",
		"return cls.wrap(index)",
	];

	it("reshapes a function into a classmethod that gained a decorator", () => {
		const ops = move(
			"src/a.py",
			"src/b.py",
			["def make(a):", ...indented(plain, 4)],
			["    @classmethod", "    def make(cls, a):", ...indented(withCls, 8)],
		);
		expect(ops).toHaveLength(1);
		expect(classes(ops[0])).toEqual([
			"signature",
			"signature",
			"code",
			"code",
			"code",
			"receiver",
			"receiver",
		]);
		expect(ops[0]?.divergences.map((d) => d.kind).slice(0, 2)).toEqual([
			"inserted",
			"changed",
		]);
		expect(ops[0]?.shape).toEqual({ reindent: 4 });
	});

	it("reshapes a function into a staticmethod that gained a decorator", () => {
		const ops = move(
			"src/a.py",
			"src/b.py",
			["def make(a):", ...indented(plain, 4)],
			[
				"    @staticmethod",
				"    def make(a, extra=None):",
				...indented(plain, 8),
			],
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.divergences.map((d) => d.kind)).toEqual([
			"inserted",
			"changed",
		]);
		expect(ops[0]?.shape).toEqual({ reindent: 4 });
	});

	it("flags self changed to cls as a receiver difference when a decorator is added", () => {
		const selfBody = withCls.map((l) => l.replace("cls.", "self."));
		const ops = move(
			"src/a.py",
			"src/b.py",
			["    def make(self, a):", ...indented(selfBody, 8)],
			["    @classmethod", "    def make(cls, a):", ...indented(withCls, 8)],
		);
		expect(ops).toHaveLength(1);
		const receivers = (ops[0]?.divergences ?? []).filter(
			(d) => d.class === "receiver",
		);
		expect(receivers).toHaveLength(2);
		expect(receivers[0]?.original).toBe("self.check(index, len(rows))");
		expect(ops[0]?.shape).toBeUndefined();
	});

	it("leaves an identical definition exact when only a decorator above it was added", () => {
		const ops = move(
			"src/a.py",
			"src/b.py",
			["def make(a):", ...indented(plain, 4)],
			["    @staticmethod", "    def make(a):", ...indented(plain, 8)],
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(true);
		expect(ops[0]?.divergences).toEqual([]);
		expect(ops[0]?.from[0]).toMatchObject({ startLine: 10, endLine: 15 });
		expect(ops[0]?.to[0]).toMatchObject({ startLine: 4, endLine: 9 });
	});

	it("pairs a py function with a pyi method", () => {
		expect(move("src/a.py", "src/b.pyi", PY_FUNCTION, PY_METHOD)).toHaveLength(
			1,
		);
	});
});

describe("reshape receiver probes", () => {
	const head = [
		"    def make(self, source):",
		"        rows = self.load_rows(source)",
		"        keys = self.build_keys(rows)",
		"        index = self.build_index(keys)",
		"        self.check(index, len(rows))",
		"        stats = self.collect(index)",
	];
	const base = [
		"def make(source):",
		"    rows = load_rows(source)",
		"    keys = build_keys(rows)",
		"    index = build_index(keys)",
		"    check(index, len(rows))",
		"    stats = collect(index)",
	];

	function probe(diffBase: string, diffHead: string) {
		const ops = move(
			"src/a.py",
			"src/b.py",
			[...base, `    ${diffBase}`, "    return finish(stats)"],
			[...head, `        ${diffHead}`, "        return self.finish(stats)"],
		);
		const all = ops.flatMap((o) => o.divergences);
		return {
			ops,
			endLine: ops[0]?.from[0]?.endLine,
			receiverOriginals: all
				.filter((d) => d.class === "receiver")
				.map((d) => d.original),
		};
	}

	it("ends the range at a changed operator instead of reporting it as a receiver", () => {
		const r = probe("total = stats + 1", "total = stats - 1");
		expect(r.ops).toHaveLength(1);
		expect(r.endLine).toBe(15);
		expect(r.receiverOriginals).not.toContain("total = stats + 1");
	});

	it("ends the range at swapped argument order", () => {
		const r = probe("total = apply(stats, rows)", "total = apply(rows, stats)");
		expect(r.ops).toHaveLength(1);
		expect(r.endLine).toBe(15);
		expect(r.receiverOriginals).not.toContain("total = apply(stats, rows)");
	});

	it("does not treat obj.self.x as a receiver", () => {
		const r = probe("value = obj.self.x", "value = obj.x");
		expect(r.ops).toHaveLength(1);
		expect(r.endLine).toBe(15);
		expect(r.receiverOriginals).not.toContain("value = obj.self.x");
	});

	it("does not treat other.cls.y as a receiver", () => {
		const r = probe("value = other.cls.y", "value = other.y");
		expect(r.ops).toHaveLength(1);
		expect(r.endLine).toBe(15);
		expect(r.receiverOriginals).not.toContain("value = other.cls.y");
	});

	it("leaves a string literal containing self. untouched", () => {
		const r = probe('label = "self.value"', 'label = "value"');
		expect(r.ops).toHaveLength(1);
		expect(r.endLine).toBe(15);
		expect(r.receiverOriginals).not.toContain('label = "self.value"');
	});

	it("keeps self as a plain identifier inside the range", () => {
		const r = probe("self = wrap(stats)", "self = wrap(stats)");
		expect(r.ops).toHaveLength(1);
		expect(r.endLine).toBe(17);
		expect(r.receiverOriginals).not.toContain("self = wrap(stats)");
		expect(r.receiverOriginals).toContain("return finish(stats)");
	});

	it("flags self changed to cls as a receiver difference", () => {
		const selfSide = head.map((l) => l.replace("make(self", "make(cls"));
		const clsSide = selfSide.map((l) => l.replaceAll("self.", "cls."));
		const ops = move("src/a.py", "src/b.py", selfSide, clsSide);
		expect(ops).toHaveLength(1);
		expect(
			(ops[0]?.divergences ?? []).filter((d) => d.class === "receiver"),
		).toHaveLength(1);
	});
});

describe("reshape budget", () => {
	it("returns the same result on every run when the token budget is tiny", () => {
		const files = [
			deletedFrom("src/pricing.py", 10, PY_FUNCTION),
			addedTo("src/cart.py", 3, PY_METHOD),
		];
		const first = findRelocations(files, { tokens: 40 });
		expect(findRelocations(files, { tokens: 40 })).toEqual(first);
		expect(findRelocations(files, { tokens: 40 })).toEqual(first);
	});
});

const STATE_BASE = [
	"def tally(items, n):",
	"    count = n + 1",
	"    rows = load_rows(items)",
	"    keys = build_keys(rows, items)",
	"    check_keys(keys, rows)",
	"    return count",
];
const STATE_HEAD = [
	"    def tally(self, items, n):",
	"        self.count = n + 1",
	"        rows = load_rows(items)",
	"        keys = build_keys(rows, items)",
	"        check_keys(keys, rows)",
	"        return count",
];
const reshapeOf = (ops: Operation[]) =>
	ops.find((o) => o.divergences.some((d) => d.class !== "comment-only"));

describe("reshape receiver weight and code classification", () => {
	it("adds a flat 1 for any number of plain receiver lines", () => {
		const op = reshapeOf(move("a.ts", "b.ts", TS_FUNCTION, TS_METHOD));
		expect(classes(op)).toEqual([
			"signature",
			"code",
			"code",
			"receiver",
			"code",
			"receiver",
		]);
		expect(op?.reviewWeight).toBe(5);
	});

	it("classes an assignment target that gained self. as code and weighs it", () => {
		const op = reshapeOf(move("a.py", "b.py", STATE_BASE, STATE_HEAD));
		expect(classes(op)).toEqual(["signature", "code"]);
		expect(op?.reviewWeight).toBe(2);
	});

	it("classes one receiver dropped and another added on a line as code", () => {
		const base = [
			"    def tally(self, x):",
			"        total = self.a + x",
			"        rows = load_rows(total)",
			"        keys = build_keys(rows, x)",
			"        check_keys(keys, rows)",
			"        return total",
		];
		const head = [
			"def tally(x):",
			"    total = a + self.x",
			"    rows = load_rows(total)",
			"    keys = build_keys(rows, x)",
			"    check_keys(keys, rows)",
			"    return total",
		];
		expect(classes(reshapeOf(move("a.py", "b.py", base, head)))).toEqual([
			"signature",
			"code",
		]);
	});

	it("keeps a read-only return that gained a receiver as receiver", () => {
		const base = [
			"def tally(n):",
			"    rows = load_rows(n)",
			"    keys = build_keys(rows, n)",
			"    check_keys(keys, rows)",
			"    flush_keys(keys, rows, n)",
			"    return n + 1",
		];
		const head = [
			"    def tally(self, n):",
			"        rows = load_rows(n)",
			"        keys = build_keys(rows, n)",
			"        check_keys(keys, rows)",
			"        flush_keys(keys, rows, n)",
			"        return self.n + 1",
		];
		const op = reshapeOf(move("a.py", "b.py", base, head));
		expect(classes(op)).toEqual(["signature", "receiver"]);
		expect(op?.reviewWeight).toBe(2);
	});
});

describe("reshape opener scan stays bounded", () => {
	const hostile = [
		`${"static ".repeat(32000)}!`,
		"a <b ".repeat(32000),
		"a b<".repeat(56000),
	];

	it.each(hostile)("finishes under a second for hostile line %#", (line) => {
		const base = [...TS_FUNCTION.slice(0, 3), line, ...TS_FUNCTION.slice(3)];
		const head = [...TS_METHOD.slice(0, 3), line, ...TS_METHOD.slice(3)];
		const started = performance.now();
		move("a.ts", "b.ts", base, head);
		expect(performance.now() - started).toBeLessThan(3000);
		const files = [deletedFrom("a.ts", 10, base), addedTo("b.ts", 3, head)];
		const modelStarted = performance.now();
		buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
		expect(performance.now() - modelStarted).toBeLessThan(3000);
	}, 5000);

	it("reads an opener of 399 characters but not one of 401", () => {
		const pad = (n: number) => `function f(${"a, ".repeat(n)}z) {`;
		const ok = pad(127);
		expect(ok.length).toBeLessThanOrEqual(400);
		expect(signatureRange([ok], "a.ts")).not.toBeNull();
		const long = pad(133);
		expect(long.length).toBeGreaterThan(400);
		expect(signatureRange([long], "a.ts")).toBeNull();
	});

	it("refuses a line longer than the analysis cap as an opener", () => {
		expect(
			signatureRange([`function f(${"a, ".repeat(900)}) {`], "a.ts"),
		).toBeNull();
	});
});

describe("reshape treats with as control flow", () => {
	it("does not read with (scope) { as a definition opening", () => {
		expect(signatureRange(["  with (scope) {"], "a.js")).toBeNull();
		expect(signatureRange(["  run(scope) {"], "a.js")).toEqual({
			start: 0,
			end: 0,
		});
	});
});

describe("reshape guards that keep a claim from forming", () => {
	it("makes no claim for a claim shorter than 5 counted lines", () => {
		const base = [
			"def compute_invoice_total(line_items, region_code):",
			"    discounted_subtotal = apply_regional_discount(line_items, region_code)",
			"    shipping_with_surcharge = estimate_shipping(discounted_subtotal, region_code)",
			"    return finalize_invoice_amount(discounted_subtotal, shipping_with_surcharge)",
		];
		const head = [
			"    def compute_invoice_total(self, line_items, region_code):",
			"        discounted_subtotal = self.apply_regional_discount(line_items, region_code)",
			"        shipping_with_surcharge = self.estimate_shipping(discounted_subtotal, region_code)",
			"        return self.finalize_invoice_amount(discounted_subtotal, shipping_with_surcharge)",
		];
		expect(reshapeOf(move("a.py", "b.py", base, head))).toBeUndefined();
	});

	it("makes no claim when the base signature opens a template literal", () => {
		const base = [
			"function applyDiscount(cart: Cart, code = `a",
			"b`): number {",
			...TS_FUNCTION.slice(1),
		];
		expect(reshapeOf(move("a.ts", "b.ts", base, TS_METHOD))).toBeUndefined();
	});

	it("makes no claim when the head signature opens a template literal", () => {
		const head = [
			"  discount(cart: Cart, code = `a",
			"b`): number {",
			...TS_METHOD.slice(1),
		];
		expect(reshapeOf(move("a.ts", "b.ts", TS_FUNCTION, head))).toBeUndefined();
	});

	it("makes no claim when the matched body closes a bracket it never opened", () => {
		const base = [...TS_FUNCTION.slice(0, 5), "  });", "}"];
		const head = [...TS_METHOD.slice(0, 5), "    });", "  }"];
		expect(reshapeOf(move("a.ts", "b.ts", base, head))).toBeUndefined();
	});
});

const PREFACE = [
	"const REGION_TABLE = buildRegionTable(loadRegions(), defaultCurrency);",
	"const SURCHARGE_TABLE = buildSurchargeTable(REGION_TABLE, surchargePolicy);",
	"const AUDIT_SINK = createAuditSink(auditConfig, REGION_TABLE, SURCHARGE_TABLE);",
	"const CACHE_KEY = deriveCacheKey(REGION_TABLE, SURCHARGE_TABLE, AUDIT_SINK);",
	"registerInvoiceHooks(AUDIT_SINK, CACHE_KEY, SURCHARGE_TABLE, REGION_TABLE);",
];

describe("reshape never claims a signature another claim already took", () => {
	it("makes no reshape when the base signature belongs to an earlier exact move", () => {
		const base = [...PREFACE, ...TS_FUNCTION];
		const files = [
			deletedFrom("a.ts", 10, base),
			addedTo("b.ts", 3, TS_METHOD),
			addedTo("c.ts", 3, [...PREFACE, TS_FUNCTION[0] as string]),
		];
		const ops = findRelocations(files);
		expect(
			ops.some((o) => o.divergences.some((d) => d.class === "signature")),
		).toBe(false);
	});

	it("makes no reshape when the head signature belongs to an earlier exact move", () => {
		const head = [...PREFACE, ...TS_METHOD];
		const files = [
			deletedFrom("a.ts", 10, TS_FUNCTION),
			addedTo("b.ts", 3, head),
			deletedFrom("c.ts", 10, [...PREFACE, TS_METHOD[0] as string]),
		];
		const ops = findRelocations(files);
		expect(
			ops.some((o) => o.divergences.some((d) => d.class === "signature")),
		).toBe(false);
	});
});

describe("reshape signature literal safety", () => {
	const regexSignature = (name: string) =>
		`${name}(cart: Cart, pattern = /a+/g, code: string): number {`;

	it("makes no claim when the base signature holds a regex literal", () => {
		const base = [
			`function ${regexSignature("applyDiscount")}`,
			...TS_FUNCTION.slice(1),
		];
		expect(reshapeOf(move("a.ts", "b.ts", base, TS_METHOD))).toBeUndefined();
	});

	it("makes no claim when the head signature holds a regex literal", () => {
		const head = [`  ${regexSignature("discount")}`, ...TS_METHOD.slice(1)];
		expect(reshapeOf(move("a.ts", "b.ts", TS_FUNCTION, head))).toBeUndefined();
	});
});

describe("reshape at scale", () => {
	const pair = (i: number) => {
		const base = [
			`function fn${i}(cart: Cart, code: string): number {`,
			`  const rate${i} = lookupRate${i}(code);`,
			`  const gross${i} = totalOf${i}(cart);`,
			`  recordDiscount${i}(cart.id, code, gross${i});`,
			`  const net${i} = applyRate${i}(gross${i}, rate${i});`,
			`  return finalize${i}(net${i}, code);`,
			"}",
		];
		const head = [
			`  method${i}(cart: Cart, code: string): number {`,
			`    const rate${i} = this.lookupRate${i}(code);`,
			`    const gross${i} = this.totalOf${i}(cart);`,
			`    this.recordDiscount${i}(cart.id, code, gross${i});`,
			`    const net${i} = this.applyRate${i}(gross${i}, rate${i});`,
			`    return this.finalize${i}(net${i}, code);`,
			"  }",
		];
		return { base, head };
	};
	const filesOf = (count: number) => {
		const pairs = Array.from({ length: count }, (_, i) => pair(i));
		return [
			deletedFrom(
				"src/a.ts",
				10,
				pairs.flatMap((p) => p.base),
			),
			addedTo(
				"src/b.ts",
				3,
				pairs.flatMap((p) => p.head),
			),
		];
	};
	const files = filesOf(500);

	it("finishes 2000 function-to-method pairs in under 3 seconds even when the budget truncates", () => {
		const started = performance.now();
		findRelocations(filesOf(2000));
		expect(performance.now() - started).toBeLessThan(3000);
	}, 8000);

	it("claims 500 function-to-method pairs in under 3 seconds", () => {
		const started = performance.now();
		const ops = findRelocations(files);
		const reshaped = ops.filter((o) =>
			o.divergences.some((d) => d.class === "signature"),
		);
		expect(reshaped.length).toBeGreaterThan(400);
		expect(performance.now() - started).toBeLessThan(3000);
	}, 8000);

	it("truncates under a tiny budget", () => {
		const full = findRelocations(files).length;
		const tiny = findRelocations(files, { tokens: 500, candidates: 50 }).length;
		expect(tiny).toBeLessThan(full);
	}, 8000);
});

describe("reshape receiver positive rule", () => {
	const run = (c: (typeof WRITE_CASES)[number]) => {
		const ext = c.lang === "py" ? "py" : "ts";
		return reshapeOf(
			move(`a.${ext}`, `b.${ext}`, scaffold(c, "base"), scaffold(c, "head")),
		);
	};

	it.each(
		WRITE_CASES.map((c) => [c.name, c] as const),
	)("never calls %s a receiver difference", (_name, c) => {
		const op = run(c);
		const receivers = (op?.divergences ?? []).filter(
			(d) => d.class === "receiver",
		);
		expect(receivers).toEqual([]);
		if (c.base.length === 1 && op)
			expect(
				op.divergences.some(
					(d) => d.class === "code" && d.original === c.base[0],
				),
			).toBe(true);
	});

	it.each(
		READ_CASES.map((c) => [c.name, c] as const),
	)("keeps %s as receiver", (_name, c) => {
		const op = run(c);
		expect(op?.divergences.filter((d) => d.class === "receiver")).toHaveLength(
			1,
		);
		expect(op?.reviewWeight).toBe(
			(op?.divergences ?? []).filter(
				(d) => d.class === "signature" || d.class === "code",
			).length + 1,
		);
	});

	it("weighs a body of 30 read-only receiver lines as a flat 1 over the signature", () => {
		const calls = Array.from(
			{ length: 30 },
			(_, i) => `step${i}(items, n, ${i})`,
		);
		const base = ["def run(items, n):", ...calls.map((l) => `    ${l}`)];
		const head = [
			"    def run(self, items, n):",
			...calls.map((l) => `        self.${l}`),
		];
		const op = reshapeOf(move("a.py", "b.py", base, head));
		expect(op?.divergences.filter((d) => d.class === "receiver")).toHaveLength(
			30,
		);
		expect(op?.reviewWeight).toBe(2);
	});

	it("emits no receiver class for the write cases end to end", () => {
		for (const c of WRITE_CASES) {
			const ext = c.lang === "py" ? "py" : "ts";
			const files = [
				deletedFrom(`a.${ext}`, 10, scaffold(c, "base")),
				addedTo(`b.${ext}`, 3, scaffold(c, "head")),
			];
			const model = buildDiffModel({
				scopeFiles: files,
				prFiles: files,
				prFilesComplete: true,
				title: "t",
				body: null,
			});
			const classesSeen = model.operations.flatMap((o) =>
				o.divergences.map((d) => d.class),
			);
			expect(classesSeen).not.toContain("receiver");
		}
	});
});

describe("reshape in files that may hold JSX", () => {
	const fn = [
		"function run(items, n) {",
		"  const rows = loadRows(items, n);",
		"  const view = <b>{rows.length}</b>;",
		"  checkRows(rows, items);",
		"  flushRows(rows, n);",
		"  return finish(view, n);",
		"}",
	];
	const method = [
		"  run(items, n) {",
		"    const rows = this.loadRows(items, n);",
		"    const view = <b>{rows.length}</b>;",
		"    this.checkRows(rows, items);",
		"    this.flushRows(rows, n);",
		"    return this.finish(view, n);",
		"  }",
	];

	it.each([
		"js",
		"mjs",
		"cjs",
		"jsx",
		"tsx",
	])("makes no reshape claim in a .%s block with JSX text", (ext) => {
		const ops = move(`a.${ext}`, `b.${ext}`, fn, method);
		expect(
			ops.some((o) => o.divergences.some((d) => d.class === "signature")),
		).toBe(false);
	});
});
