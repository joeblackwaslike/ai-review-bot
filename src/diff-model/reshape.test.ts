import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
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

	it("includes Rust attributes directly above the opening line", () => {
		expect(
			signatureRange(["#[inline]", "pub fn go(&self) -> u32 {"], "a.rs"),
		).toEqual({ start: 0, end: 1 });
	});

	it("returns null when the lines above are not a definition", () => {
		expect(signatureRange(["const x = compute(1);"], "a.ts")).toBeNull();
		expect(signatureRange(["if (ready(x)) {"], "a.ts")).toBeNull();
		expect(signatureRange(["x = compute(1)"], "a.py")).toBeNull();
	});
});

describe("reshape matching", () => {
	it("pairs a function with the method it became despite a new name and parameters", () => {
		const ops = move("src/pricing.py", "src/cart.py", PY_FUNCTION, PY_METHOD);
		expect(ops).toHaveLength(1);
		const op = ops[0] as Operation;
		expect(op.from[0]).toMatchObject({ startLine: 10, endLine: 15 });
		expect(op.to[0]).toMatchObject({ startLine: 3, endLine: 8 });
		expect(classes(op)).toEqual(["signature", "receiver", "receiver"]);
		expect(op.shape).toEqual({ reindent: 4 });
		expect(op.exact).toBe(false);
		expect(op.reviewWeight).toBe(1);
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
			"const rate = lookupRate(code);",
			"const gross = totalOf(cart);",
			"recordDiscount(cart.id, code, gross);",
			"const net = applyRate(gross, rate);",
			"return finalize(net, code);",
		]);
		expect(receivers[0]).toMatchObject({
			kind: "changed",
			base: { startLine: 11, endLine: 11 },
			head: { startLine: 4, endLine: 4 },
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
			"taxed = subtotal * (1 + self.tax_rate)",
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
			"receiver",
			"receiver",
			"receiver",
			"receiver",
			"receiver",
		]);
		expect((ops[0] as Operation).exact).toBe(false);
		expect((ops[0] as Operation).reviewWeight).toBe(1);
	});

	it("does not pair unrelated functions that share a short body", () => {
		const ops = move(
			"src/a.py",
			"src/b.py",
			["def increment(value):", "    x = y + 1", "    return x"],
			["    def bump(self, counter):", "        x = y + 1", "        return x"],
		);
		expect(ops).toEqual([]);
	});

	it("does not reshape across languages", () => {
		const body = [
			"    total = compute(items, rate)",
			"    taxed = apply(total, rate, region)",
			"    rounded = round(taxed, digits)",
			"    record(rounded, items.length)",
			"    result = finish(rounded, taxed)",
		];
		const pyHead = [
			"    def total(self, items):",
			...body.map((l) => `    ${l}`),
		];
		const tsHead = [
			"  total(items: Item[]): number {",
			...body.map((l) => `  ${l}`),
		];
		const pyBase = ["def total_price(items, rate):", ...body.map((l) => l)];
		expect(move("src/a.py", "src/b.py", pyBase, pyHead)).toHaveLength(1);
		expect(move("src/a.py", "src/b.ts", pyBase, tsHead)).toEqual([]);
	});

	it("does not claim signature lines that the line matcher already claimed", () => {
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
			"    return self.finish(header, totals)",
		];
		const head = [
			...signature,
			...base.slice(6).map((l) => l.replace("self.", "")),
		];
		const ops = move("src/report.py", "src/builder.py", base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.from[0]?.startLine).toBe(10);
		expect(classes(ops[0])).not.toContain("signature");
		expect(classes(ops[0])).not.toContain("receiver");
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

	it("matches a Rust Self:: receiver", () => {
		const base = [
			"fn build_label(prefix: &str, id: u32) -> String {",
			"    let base = normalize(prefix);",
			"    let suffix = encode(id, 36);",
			"    let label = join(base, suffix);",
			"    record(label.len());",
			"    finish(label)",
			"}",
		];
		const head = [
			"    fn label(&self, prefix: &str) -> String {",
			"        let base = Self::normalize(prefix);",
			"        let suffix = Self::encode(id, 36);",
			"        let label = Self::join(base, suffix);",
			"        Self::record(label.len());",
			"        Self::finish(label)",
			"    }",
		];
		const ops = move("src/label.rs", "src/model.rs", base, head);
		expect(ops).toHaveLength(1);
		expect(classes(ops[0])).toEqual([
			"signature",
			"receiver",
			"receiver",
			"receiver",
			"receiver",
			"receiver",
		]);
		expect(
			(ops[0] as Operation).divergences.map((d) => d.original).slice(1, 3),
		).toEqual([
			"let base = normalize(prefix);",
			"let suffix = encode(id, 36);",
		]);
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
