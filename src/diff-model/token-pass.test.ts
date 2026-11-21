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
		const interpolate = (line: string) => line.replaceAll("@{", "$" + "{");
		const base = [
			"logger.info(`Order @{order.id} for @{customer.name} ships to @{address.city} on @{date}`);",
		].map(interpolate);
		const head = [
			"logger.info(`Order @{order.id} for @{customer.name} ships to @{address.city}",
			"on @{date}`);",
		].map(interpolate);
		expect(moveBetween("src/a.ts", "src/b.ts", base, head)).toEqual([]);
	});

	it("leaves a Ruby reformat unmatched", () => {
		const base = [
			'config = { name: "alpha", retries: 3, timeout: 5000, verbose: false, region: "us-east" }',
		];
		const head = [
			"config = {",
			'  name: "alpha",',
			"  retries: 3,",
			"  timeout: 5000,",
			"  verbose: false,",
			'  region: "us-east"',
			"}",
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
		const patch = [
			"@@ -1,1 +1,7 @@",
			...PRETTIER_BASE.map((l) => `-${l}`),
			...PRETTIER_HEAD.map((l) => `+${l}`),
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
