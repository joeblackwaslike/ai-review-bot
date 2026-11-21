import { describe, expect, it } from "vitest";
import { collectRuns, type PushFile } from "../moved-blocks.js";
import { WorkBudget } from "./budget.js";
import { findRelocations } from "./relocation.js";
import { findTokenOperations } from "./token-pass.js";

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

function moveBetween(
	baseName: string,
	headName: string,
	base: string[],
	head: string[],
) {
	return findRelocations([
		deletedFrom(baseName, 10, base),
		addedTo(headName, 3, head),
	]);
}

const PRETTIER_BASE = [
	'const config = { name: "alpha", retries: 3, timeout: 5000, verbose: false, region: "us-east" };',
];
const PRETTIER_HEAD = [
	"const config = {",
	'  name: "alpha",',
	"  retries: 3,",
	"  timeout: 5000,",
	"  verbose: false,",
	'  region: "us-east",',
	"};",
];

const BLACK_BASE = [
	"result = process_order(customer_id, order_items, discount_code, shipping_address, billing_address)",
];
const BLACK_HEAD = [
	"result = process_order(",
	"    customer_id,",
	"    order_items,",
	"    discount_code,",
	"    shipping_address,",
	"    billing_address,",
	")",
];

const PY_BLOCK = [
	"def total_price(items, tax_rate):",
	"    subtotal = sum(item.price * item.quantity for item in items)",
	"    if subtotal > FREE_SHIPPING_THRESHOLD:",
	"        shipping = 0",
	"    else:",
	"        shipping = flat_shipping_rate",
	"    return subtotal + shipping + subtotal * tax_rate",
];

function indented(lines: string[], by: number): string[] {
	return lines.map((l) => (l.trim() === "" ? l : " ".repeat(by) + l));
}

function dedented(lines: string[], by: number): string[] {
	return lines.map((l) => l.slice(by));
}

const YAML_BLOCK = [
	"deploy_service:",
	"  image: registry.example.com/service:latest",
	"  replicas: 3",
	"  environment:",
	"    LOG_LEVEL: debug",
	"    REGION: us-east-1",
];

describe("token pass", () => {
	it("matches a move that was reformatted by Prettier", () => {
		const ops = moveBetween(
			"src/a.ts",
			"src/b.ts",
			PRETTIER_BASE,
			PRETTIER_HEAD,
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			type: "relocation",
			exact: true,
			from: [{ filename: "src/a.ts", startLine: 10, endLine: 10 }],
			to: [{ filename: "src/b.ts", startLine: 3, endLine: 9 }],
		});
	});

	it("matches a Black-wrapped Python call moved between files", () => {
		const ops = moveBetween("a/old.py", "a/new.py", BLACK_BASE, BLACK_HEAD);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			exact: true,
			from: [{ startLine: 10, endLine: 10 }],
			to: [{ startLine: 3, endLine: 9 }],
		});
		expect(ops[0]?.shape).toBeUndefined();
	});

	it("matches a Python block moved one level deeper and records reindent +4", () => {
		const ops = moveBetween(
			"a/old.py",
			"a/new.py",
			PY_BLOCK,
			indented(PY_BLOCK, 4),
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ exact: true, shape: { reindent: 4 } });
	});

	it("matches a Python block moved one level shallower and records reindent -4", () => {
		const ops = moveBetween(
			"a/old.py",
			"a/new.py",
			indented(PY_BLOCK, 4),
			PY_BLOCK,
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ exact: true, shape: { reindent: -4 } });
	});

	it("matches a YAML block moved one level deeper", () => {
		const ops = moveBetween(
			"ci/old.yml",
			"ci/new.yml",
			YAML_BLOCK,
			indented(YAML_BLOCK, 2),
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ exact: true, shape: { reindent: 2 } });
	});

	it("rejects a Python block whose relative structure changed", () => {
		const head = indented(PY_BLOCK, 4).map((l, i) =>
			i === 3 ? dedented([l], 2)[0] : l,
		);
		expect(
			moveBetween("a/old.py", "a/new.py", PY_BLOCK, head as string[]),
		).toEqual([]);
	});

	it("leaves a reformatted template literal unmatched", () => {
		const base = [
			"emit(first, second, third, fourth, `fixed text`, fifth, sixth);",
		];
		const head = [
			"emit(first, second, third, fourth,",
			"`fixed text`, fifth, sixth);",
		];
		expect(moveBetween("src/a.ts", "src/b.ts", base, head)).toEqual([]);
	});

	it("leaves a Ruby reformat unmatched", () => {
		const base = [
			"result = process_order(customer_id, order_items, discount_code, shipping_address)",
		];
		const head = [
			"result = process_order(",
			"  customer_id,",
			"  order_items,",
			"  discount_code,",
			"  shipping_address",
			")",
		];
		expect(moveBetween("lib/a.rb", "lib/b.rb", base, head)).toEqual([]);
	});

	it("does not claim lines the line matcher already claimed", () => {
		const exact = Array.from(
			{ length: 6 },
			(_, i) => `  const value${i} = computeValue(${i}) + offset;`,
		);
		const ops = moveBetween(
			"src/a.ts",
			"src/b.ts",
			[...exact, "", ...PRETTIER_BASE],
			[...exact, "", ...PRETTIER_HEAD],
		);
		const claimed = ops.flatMap((op) =>
			(op.to as { startLine: number; endLine: number }[]).flatMap((s) =>
				Array.from(
					{ length: s.endLine - s.startLine + 1 },
					(_, k) => s.startLine + k,
				),
			),
		);
		expect(new Set(claimed).size).toBe(claimed.length);
		expect(ops.length).toBeGreaterThanOrEqual(1);
	});

	it("returns an exact operation with no divergences for a reformat-only move", () => {
		const ops = moveBetween(
			"src/a.ts",
			"src/b.ts",
			PRETTIER_BASE,
			PRETTIER_HEAD,
		);
		expect(ops[0]?.exact).toBe(true);
		expect(ops[0]?.divergences).toEqual([]);
		expect(ops[0]?.reviewWeight).toBe(0);
	});

	it("keeps a changed line out of the match so the edited gap stays unclaimed", () => {
		const first =
			'const alpha = { name: "alpha", retries: 3, timeout: 5000, verbose: false, region: "us-east" };';
		const middle = "applyRate(Math.floor(price * percentage * multiplier));";
		const last =
			'const omega = { name: "omega", retries: 9, timeout: 9000, verbose: true, region: "eu-west" };';
		const base = [first, middle, last];
		const head = [
			"const alpha = {",
			'  name: "alpha",',
			"  retries: 3,",
			"  timeout: 5000,",
			"  verbose: false,",
			'  region: "us-east",',
			"};",
			"applyRate(Math.round(price * percentage * multiplier));",
			"const omega = {",
			'  name: "omega",',
			"  retries: 9,",
			"  timeout: 9000,",
			"  verbose: true,",
			'  region: "eu-west",',
			"};",
		];
		const ops = moveBetween("src/a.ts", "src/b.ts", base, head);
		expect(ops).toHaveLength(2);
		expect(ops.every((op) => op.exact && op.divergences.length === 0)).toBe(
			true,
		);
		expect(ops[0]?.from[0]).toMatchObject({ startLine: 10, endLine: 10 });
		expect(ops[1]?.from[0]).toMatchObject({ startLine: 12, endLine: 12 });
		expect(ops[0]?.to[0]).toMatchObject({ startLine: 3, endLine: 9 });
		expect(ops[1]?.to[0]).toMatchObject({ startLine: 11, endLine: 17 });
	});

	it("does not match across a changed operator", () => {
		const base = ["total = first + ++second + third + fourth + fifth + sixth;"];
		const head = ["total = first++ + second + third + fourth + fifth + sixth;"];
		expect(moveBetween("src/a.ts", "src/b.ts", base, head)).toEqual([]);
	});

	it("does not pair a pair within one change region", () => {
		const multiline = [
			"setupServer({",
			"  port: 8080,",
			'  host: "0.0.0.0",',
			"  retries: 3,",
			"  timeout: 5000,",
			"});",
		];
		const oneLine = [
			'setupServer({ port: 8080, host: "0.0.0.0", retries: 3, timeout: 5000 });',
		];
		const patch = [
			"@@ -1,6 +1,1 @@",
			...multiline.map((l) => `-${l}`),
			...oneLine.map((l) => `+${l}`),
		].join("\n");
		expect(findRelocations([pushFile("src/a.ts", patch)])).toEqual([]);
	});

	it("respects the budget by stopping the pass deterministically", () => {
		const files = [
			deletedFrom("src/a.ts", 10, PRETTIER_BASE),
			addedTo("src/b.ts", 3, PRETTIER_HEAD),
		];
		const run = (tokens: number) => {
			const { deleted, added } = collectRuns(files);
			return findTokenOperations(deleted, added, new WorkBudget({ tokens }));
		};
		expect(run(5)).toEqual([]);
		expect(run(5)).toEqual([]);
		expect(run(200_000)).toHaveLength(1);
	});
});

function withContext(
	filename: string,
	before: string[],
	changed: string[],
	after: string[],
	sign: "-" | "+",
): PushFile {
	const total = before.length + changed.length + after.length;
	const header =
		sign === "-"
			? `@@ -1,${total} +1,${before.length + after.length} @@`
			: `@@ -1,${before.length + after.length} +1,${total} @@`;
	return pushFile(
		filename,
		[
			header,
			...before.map((l) => ` ${l}`),
			...changed.map((l) => `${sign}${l}`),
			...after.map((l) => ` ${l}`),
		].join("\n"),
	);
}

function claimedHeadLines(
	ops: { to: { startLine: number; endLine: number }[] }[],
) {
	return ops.flatMap((op) =>
		op.to.flatMap((s) =>
			Array.from(
				{ length: s.endLine - s.startLine + 1 },
				(_, k) => s.startLine + k,
			),
		),
	);
}

describe("token pass false-relocation guards", () => {
	it("leaves CSS selectors unmatched when whitespace between tokens changed", () => {
		const base = [
			"ul .item { color: red; margin: 0 auto; padding: 4px 8px; border: 1px solid blue; }",
		];
		const head = [
			"ul.item { color: red; margin: 0 auto; padding: 4px 8px; border: 1px solid blue; }",
		];
		expect(moveBetween("web/a.css", "web/b.css", base, head)).toEqual([]);
	});

	it("leaves a Scala braceless definition unmatched when its call is rewrapped", () => {
		const base = [
			"def apply(order: Order): Total = process(order, taxRate, shippingRate, discountCode)",
		];
		const head = [
			"def apply(order: Order): Total = process(",
			"  order,",
			"  taxRate,",
			"  shippingRate,",
			"  discountCode",
			")",
		];
		expect(moveBetween("app/a.scala", "app/b.scala", base, head)).toEqual([]);
	});

	it("leaves a YAML value unmatched when the space after the colon is dropped", () => {
		const base = [
			"server:",
			"  host: example.com",
			"  port: 8080",
			"  tls: true",
			"  retries: 3",
			"  timeout: 30",
			"  region: us-east-1",
		];
		const head = indented(base, 2).map((l) =>
			l.replace("port: 8080", "port:8080"),
		);
		const ops = moveBetween("ci/a.yml", "ci/b.yml", base, head);
		expect(claimedHeadLines(ops)).not.toContain(3 + 2);
	});

	it("leaves a YAML list item unmatched when the space after the dash is dropped", () => {
		const base = [
			"versions:",
			"  - 1.0",
			"  - 1.1",
			"  - 1.2",
			"  - 2.0",
			"  - 2.1",
			"  - 3.0",
		];
		const head = indented(base, 2).map((l) => l.replace("- 1.1", "-1.1"));
		const ops = moveBetween("ci/a.yml", "ci/b.yml", base, head);
		expect(claimedHeadLines(ops)).not.toContain(3 + 2);
	});

	it("leaves a YAML block scalar unmatched when its inner spacing changed", () => {
		const base = [
			"steps:",
			"  run: |",
			"    echo  one   two",
			"    echo three",
			"  shell: bash",
			"  name: build-and-test",
			"  retries: 3",
		];
		const head = indented(base, 2).map((l) =>
			l.replace("echo  one   two", "echo one two"),
		);
		const ops = moveBetween("ci/a.yml", "ci/b.yml", base, head);
		expect(claimedHeadLines(ops)).not.toContain(3 + 2);
	});

	it("keeps a line break between count++ and a following ++limit", () => {
		const base = [
			"items.forEach(register);",
			"count++",
			"limit(alpha, beta, gamma, delta, epsilon)",
		];
		const head = [
			"items.forEach(register);",
			"count",
			"++limit(alpha, beta, gamma, delta, epsilon)",
		];
		const ops = moveBetween("src/a.ts", "src/b.ts", base, head);
		expect(claimedHeadLines(ops)).not.toContain(3 + 1);
		expect(claimedHeadLines(ops)).not.toContain(3 + 2);
	});

	it("leaves a C preprocessor line unmatched when whitespace after the macro name changed", () => {
		const base = [
			"#define CLAMP_TO_RANGE(value, low, high) ((value) < (low) ? (low) : ((value) > (high) ? (high) : (value)))",
		];
		const head = [
			"#define CLAMP_TO_RANGE (value, low, high) ((value) < (low) ? (low) : ((value) > (high) ? (high) : (value)))",
		];
		expect(moveBetween("src/a.c", "src/b.c", base, head)).toEqual([]);
	});

	it("leaves a joined SQL template body unmatched", () => {
		const body = [
			"SELECT id, name, email, created_at",
			"FROM users",
			"WHERE active = 1",
			"AND created_at > last_login",
			"ORDER BY name",
		];
		const joined = [body.join(" ")];
		const ops = findRelocations([
			withContext("src/a.ts", ["const q = `"], body, ["`;"], "-"),
			withContext("src/b.ts", ["const q = `"], joined, ["`;"], "+"),
		]);
		expect(ops).toEqual([]);
	});

	it("leaves a Python docstring interior unmatched when moved deeper", () => {
		const body = [
			"    Compute the total price for the order, applying the discount",
			"    first and then the tax, and return the rounded amount owed",
			"    in the currency of the customer account on file.",
		];
		const ops = findRelocations([
			withContext(
				"a/old.py",
				["def total(order):", '    """'],
				body,
				['    """'],
				"-",
			),
			withContext(
				"a/new.py",
				["class Pricing:", "    def total(self, order):", '        """'],
				indented(body, 4),
				['        """'],
				"+",
			),
		]);
		expect(ops).toEqual([]);
	});

	it("still matches a reformat of balanced statements one per line", () => {
		const base = [
			"registerUser(request.body); sendWelcome(request.user); trackSignup(request.user, campaign);",
		];
		const head = [
			"registerUser(request.body);",
			"sendWelcome(request.user);",
			"trackSignup(request.user, campaign);",
		];
		const ops = moveBetween("src/a.ts", "src/b.ts", base, head);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.exact).toBe(true);
	});

	it("leaves a block fragment with an unmatched closing bracket unclaimed", () => {
		const base = [
			"if (ready) {",
			"  startEngine(alpha,beta);",
			"  runDiagnostics(gamma);",
			"}",
		];
		const head = [
			"while (ready) {",
			"  startEngine(alpha, beta);",
			"  runDiagnostics( gamma );",
			"}",
		];
		expect(moveBetween("src/a.ts", "src/b.ts", base, head)).toEqual([]);
	});

	it("never pairs files of different language families", () => {
		const base = [
			"result := process(customerID, orderItems, discountCode, shippingAddress)",
		];
		const head = [
			"result := process(",
			"  customerID,",
			"  orderItems,",
			"  discountCode,",
			"  shippingAddress",
			")",
		];
		expect(moveBetween("svc/a.go", "svc/b.kt", base, head)).toEqual([]);
		expect(moveBetween("svc/a.go", "svc/b.go", base, head)).toHaveLength(1);
	});
});
