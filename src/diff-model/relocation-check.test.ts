import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation } from "./relocation-check.js";
import type { Operation } from "./types.js";

function pushFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function moveFiles(
	base: string[],
	head: string[],
	names: [string, string] = ["src/a.ts", "src/b.ts"],
): PushFile[] {
	return [
		pushFile(
			names[0],
			[`@@ -10,${base.length} +9,0 @@`, ...base.map((line) => `-${line}`)].join(
				"\n",
			),
		),
		pushFile(
			names[1],
			[`@@ -0,0 +3,${head.length} @@`, ...head.map((line) => `+${line}`)].join(
				"\n",
			),
		),
	];
}

function relocation(base: string[], head: string[], names?: [string, string]) {
	const files = moveFiles(base, head, names);
	const ops = findRelocations(files);
	expect(ops).toHaveLength(1);
	return { files, op: ops[0] as Operation };
}

function body(count: number): string[] {
	return Array.from(
		{ length: count },
		(_, i) => `  const v${i} = compute(${i}) + offset;`,
	);
}

function fn(lines: string[]): string[] {
	return ["export function applyDiscount(input) {", ...lines, "}"];
}

function withLine(lines: string[], index: number, text: string): string[] {
	return lines.map((line, i) => (i === index ? text : line));
}

function claimedClean(op: Operation): Operation {
	return { ...op, exact: true, divergences: [] };
}

describe("verifyRelocation", () => {
	it("accepts a clean move", () => {
		const block = fn(body(20));
		const { files, op } = relocation(block, block);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("accepts a reformatted-only move", () => {
		const block = fn(body(20));
		const { files, op } = relocation(
			block,
			block.map((line) => `    ${line}`),
		);
		expect(op.divergences).toEqual([]);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("accepts a re-indented move containing a single-line template literal", () => {
		const block = withLine(fn(body(20)), 5, `  const label = \`x \${v}\`;`);
		const { files, op } = relocation(
			block,
			block.map((line) => `    ${line}`),
		);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("accepts a move whose divergences are all listed", () => {
		const base = withLine(fn(body(30)), 10, "  const rate = Math.floor(p);");
		const changed = withLine(base, 10, "  const rate = Math.round(p);");
		const head = [
			...changed.slice(0, 20),
			"  audit(rate);",
			...changed.slice(20),
		];
		const { files, op } = relocation(base, head);
		expect(op.divergences.length).toBeGreaterThanOrEqual(2);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("rejects a claim that omits a changed line", () => {
		const base = fn(body(30));
		const head = withLine(base, 10, "  const rate = Math.round(p);");
		const { files, op } = relocation(base, head);
		expect(op.divergences).toHaveLength(1);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("rejects a template literal whose inner whitespace changed when the claim says unchanged", () => {
		const base = fn([
			...body(8),
			"  const sql = `",
			"    select id",
			"    from t",
			"  `;",
			...body(8),
		]);
		const head = withLine(base, 10, "        select id");
		const { files, op } = relocation(base, head);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("rejects a claim that omits a deleted guard", () => {
		const base = fn(body(30));
		const head = [...base.slice(0, 12), ...base.slice(13)];
		const { files, op } = relocation(base, head);
		expect(op.divergences.map((d) => d.kind)).toContain("removed");
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("rejects a listed divergence the lines do not support", () => {
		const block = fn(body(20));
		const { files, op } = relocation(block, block);
		const from = op.from[0] as Operation["from"][0];
		const to = op.to[0] as Operation["to"][0];
		const bogus: Operation = {
			...op,
			exact: false,
			divergences: [
				{
					kind: "changed",
					class: "code",
					base: { ...from, startLine: 12, endLine: 12 },
					head: { ...to, startLine: 5, endLine: 5 },
				},
			],
		};
		expect(verifyRelocation(bogus, files)).toBe(false);
	});

	it("rejects a reordered block claimed clean", () => {
		const block = fn(body(20));
		const swapped = block.map((line, i) =>
			i === 5 ? (block[6] as string) : i === 6 ? (block[5] as string) : line,
		);
		const { files, op } = relocation(block, swapped);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("rejects a changed string-literal interior claimed clean", () => {
		const base = withLine(fn(body(20)), 5, '  const s = "a  b";');
		const head = withLine(base, 5, '  const s = "a b";');
		const { files, op } = relocation(base, head);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("accepts a re-indented line that contains a string", () => {
		const block = withLine(fn(body(20)), 5, '  const s = "a  b";');
		const { files, op } = relocation(
			block,
			block.map((line) => `    ${line}`),
		);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("rejects x + +y changed to x ++y claimed clean", () => {
		const base = withLine(fn(body(20)), 5, "  const z = x + +y;");
		const head = withLine(base, 5, "  const z = x ++y;");
		const { files, op } = relocation(base, head);
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	describe("forged claims", () => {
		function changedMove() {
			const base = fn(body(30));
			const head = withLine(base, 10, "  const rate = Math.round(p);");
			const { files, op } = relocation(base, head);
			const [divergence] = op.divergences;
			expect(op.divergences).toHaveLength(1);
			expect(verifyRelocation(op, files)).toBe(true);
			return {
				files,
				op,
				divergence: divergence as Operation["divergences"][0],
			};
		}

		function withDivergence(
			op: Operation,
			divergence: Operation["divergences"][0],
			extra: Operation["divergences"] = [],
		): Operation {
			return { ...op, divergences: [divergence, ...extra] };
		}

		it("rejects a span in a file that is not in the patch set", () => {
			const { files, op, divergence } = changedMove();
			const forged = withDivergence(op, {
				...divergence,
				base: {
					...(divergence.base as Operation["from"][0]),
					filename: "src/nope.ts",
				},
			});
			expect(verifyRelocation(forged, files)).toBe(false);
			const missing: Operation = {
				...op,
				from: [
					{ ...(op.from[0] as Operation["from"][0]), filename: "src/nope.ts" },
				],
			};
			expect(verifyRelocation(missing, files)).toBe(false);
		});

		it("rejects a claim whose spans are all missing from the patch set or off the changed lines", () => {
			const { files, op } = changedMove();
			const from = op.from[0] as Operation["from"][0];
			const to = op.to[0] as Operation["to"][0];
			const absent: Operation = {
				...op,
				divergences: [],
				from: [{ ...from, filename: "src/nope-a.ts" }],
				to: [{ ...to, filename: "src/nope-b.ts" }],
			};
			const offLines: Operation = {
				...op,
				divergences: [],
				from: [{ ...from, startLine: 900, endLine: 930 }],
				to: [{ ...to, startLine: 900, endLine: 930 }],
			};
			expect(verifyRelocation(absent, files)).toBe(false);
			expect(verifyRelocation(offLines, files)).toBe(false);
		});

		it("rejects a span on lines that are not changed lines of the patch", () => {
			const { files, op, divergence } = changedMove();
			const forged = withDivergence(op, {
				...divergence,
				head: {
					...(divergence.head as Operation["to"][0]),
					startLine: 900,
					endLine: 900,
				},
			});
			expect(verifyRelocation(forged, files)).toBe(false);
		});

		it("rejects a base span that points into the head file", () => {
			const { files, op, divergence } = changedMove();
			const forged = withDivergence(op, {
				...divergence,
				base: divergence.head,
			});
			expect(verifyRelocation(forged, files)).toBe(false);
		});

		it("rejects a divergence span covering more than one line", () => {
			const { files, op, divergence } = changedMove();
			const base = divergence.base as Operation["from"][0];
			const forged = withDivergence(op, {
				...divergence,
				base: { ...base, endLine: base.endLine + 1 },
			});
			expect(verifyRelocation(forged, files)).toBe(false);
		});

		it("rejects the same line claimed by two divergences", () => {
			const { files, op, divergence } = changedMove();
			expect(
				verifyRelocation(withDivergence(op, divergence, [divergence]), files),
			).toBe(false);
		});

		it("rejects a divergence with a wrong original text", () => {
			const { files, op, divergence } = changedMove();
			const forged = withDivergence(op, {
				...divergence,
				original: "  const rate = somethingElse(p);",
			});
			expect(verifyRelocation(forged, files)).toBe(false);
		});

		it("rejects a claim with an extra unlisted trailing line on the head side", () => {
			const block = fn(body(20));
			const { op } = relocation(block, block);
			const files = moveFiles(block, [...block, "  extra();"]);
			const to = op.to[0] as Operation["to"][0];
			const forged: Operation = {
				...op,
				to: [{ ...to, endLine: to.endLine + 1 }],
			};
			expect(verifyRelocation(forged, files)).toBe(false);
		});

		it("rejects inserted or removed claimed over lines that are actually paired", () => {
			const block = fn(body(20));
			const { files, op } = relocation(block, block);
			const from = op.from[0] as Operation["from"][0];
			const to = op.to[0] as Operation["to"][0];
			const inserted: Operation = {
				...op,
				exact: false,
				divergences: [
					{
						kind: "inserted",
						class: "code",
						head: {
							...to,
							startLine: to.startLine + 3,
							endLine: to.startLine + 3,
						},
					},
				],
			};
			const removed: Operation = {
				...op,
				exact: false,
				divergences: [
					{
						kind: "removed",
						class: "code",
						base: {
							...from,
							startLine: from.startLine + 3,
							endLine: from.startLine + 3,
						},
					},
				],
			};
			expect(verifyRelocation(inserted, files)).toBe(false);
			expect(verifyRelocation(removed, files)).toBe(false);
		});
	});

	describe("indentation-sensitive and heredoc content", () => {
		it("reports one dedented line of a Python move as a divergence and rejects a clean claim", () => {
			const base = body(20);
			const head = withLine(base, 8, "const v8 = compute(8) + offset;");
			const { files, op } = relocation(base, head, ["a.py", "b.py"]);
			expect(op.divergences.length).toBeGreaterThanOrEqual(1);
			expect(verifyRelocation(op, files)).toBe(true);
			expect(verifyRelocation(claimedClean(op), files)).toBe(false);
		});

		it("rejects a shell continuation broken by trailing whitespace claimed clean", () => {
			const base = withLine(body(10), 4, "  cmd --flag \\");
			const head = withLine(base, 4, "  cmd --flag \\ ");
			const { files, op } = relocation(base, head, ["a.sh", "b.sh"]);
			expect(verifyRelocation(claimedClean(op), files)).toBe(false);
		});

		it("does not treat a shell heredoc whose inner whitespace changed as exact", () => {
			const base = [
				...body(6),
				"cat <<EOF",
				"  inner   text",
				"EOF",
				...body(6),
			];
			const head = withLine(base, 7, "  inner text");
			const { files, op } = relocation(base, head, ["a.sh", "b.sh"]);
			expect(op.exact).toBe(false);
			expect(verifyRelocation(claimedClean(op), files)).toBe(false);
		});
	});
});
