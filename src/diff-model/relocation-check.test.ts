import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";
import { partialStatements } from "./partial-statements.fixture.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation } from "./relocation-check.js";
import type { Operation, Span } from "./types.js";

function pushFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function lineClaim(
	baseFile: string,
	baseStart: number,
	baseEnd: number,
	headFile: string,
	headStart: number,
	headEnd: number,
): Operation {
	const span = (
		filename: string,
		side: "base" | "head",
		startLine: number,
		endLine: number,
	) => ({ filename, side, startLine, endLine, shown: "full" as const });
	return {
		id: "relocation-1",
		type: "relocation",
		from: [span(baseFile, "base", baseStart, baseEnd)],
		to: [span(headFile, "head", headStart, headEnd)],
		exact: true,
		divergences: [],
		reviewWeight: 0,
	};
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

	it("accepts a move that dropped a first-statement guard and rejects it as clean", () => {
		const head = fn(body(30));
		const base = [
			head[0] as string,
			"  if (!input) return null;",
			...head.slice(1),
		];
		const { files, op } = relocation(base, head);
		expect(op.divergences).toHaveLength(1);
		expect(verifyRelocation(op, files)).toBe(true);
		expect(
			verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
		).toBe(false);
	});

	it("rejects a claim that omits an inserted line", () => {
		const base = fn(body(30));
		const head = [...base.slice(0, 15), "  audit(input);", ...base.slice(15)];
		const { files, op } = relocation(base, head);
		expect(op.divergences).toHaveLength(1);
		expect(op.divergences[0]?.kind).toBe("inserted");
		expect(
			verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
		).toBe(false);
	});

	it("rejects an exact claim over a re-indented Python block", () => {
		const lines = Array.from(
			{ length: 8 },
			(_, i) => `    value_${i} = f(${i})`,
		);
		const reindented = lines.map((line) => `        ${line.trim()}`);
		const files = [
			{
				...pushFile(
					"billing/old.py",
					[`@@ -10,8 +9,0 @@`, ...lines.map((l) => `-${l}`)].join("\n"),
				),
			},
			pushFile(
				"billing/new.py",
				[`@@ -0,0 +3,8 @@`, ...reindented.map((l) => `+${l}`)].join("\n"),
			),
		];
		const claim: Operation = {
			id: "relocation-1",
			type: "relocation",
			from: [
				{
					filename: "billing/old.py",
					side: "base",
					startLine: 10,
					endLine: 17,
					shown: "full",
				},
			],
			to: [
				{
					filename: "billing/new.py",
					side: "head",
					startLine: 3,
					endLine: 10,
					shown: "full",
				},
			],
			exact: true,
			divergences: [],
			reviewWeight: 0,
		};
		expect(verifyRelocation(claim, files)).toBe(false);
	});

	it("rejects a claim that omits a changed line", () => {
		const base = fn(body(30));
		const head = withLine(base, 10, "  const rate = Math.round(p);");
		const { files, op } = relocation(base, head);
		expect(op.divergences).toHaveLength(1);
		expect(
			verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
		).toBe(false);
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
		expect(
			verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
		).toBe(false);
	});

	it("rejects a claim that omits a deleted guard", () => {
		const base = fn(body(30));
		const head = [...base.slice(0, 12), ...base.slice(13)];
		const { files, op } = relocation(base, head);
		expect(op.divergences.map((d) => d.kind)).toContain("removed");
		expect(
			verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
		).toBe(false);
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
		expect(
			verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
		).toBe(false);
	});

	it("rejects a changed string-literal interior claimed clean", () => {
		const base = withLine(fn(body(20)), 5, '  const s = "a  b";');
		const head = withLine(base, 5, '  const s = "a b";');
		const { files, op } = relocation(base, head);
		expect(
			verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
		).toBe(false);
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
		expect(
			verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
		).toBe(false);
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
			expect(
				verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
			).toBe(false);
		});

		it("rejects a shell continuation broken by trailing whitespace claimed clean", () => {
			const base = withLine(body(10), 4, "  cmd --flag \\");
			const head = withLine(base, 4, "  cmd --flag \\ ");
			const { files, op } = relocation(base, head, ["a.sh", "b.sh"]);
			expect(
				verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
			).toBe(false);
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
			expect(
				verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
			).toBe(false);
		});
	});
});

function pairBlock(
	base: string[],
	head: string[],
	at: number[],
): [string[], string[]] {
	const b = fn(body(30));
	const h = fn(body(30));
	at.forEach((index, k) => {
		b.splice(index, 0, base[k] as string);
		h.splice(index, 0, head[k] as string);
	});
	return [b, h];
}

function reclassed(
	op: Operation,
	cls: Operation["divergences"][number]["class"],
) {
	return {
		...op,
		divergences: op.divergences.map((d) => ({ ...d, class: cls })),
	};
}

function codeChange() {
	return relocation(
		fn(body(30)),
		withLine(fn(body(30)), 15, "  const v14 = evil() + offset;"),
	);
}

describe("verifyRelocation divergence classes", () => {
	it("accepts a real comment-only divergence", () => {
		const base = fn(body(30));
		base.splice(15, 0, "  // apply the discount");
		const head = withLine(base, 15, "  // apply discount");
		const { files, op } = relocation(base, head);
		expect(op.divergences[0]?.class).toBe("comment-only");
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("accepts a real rename and its distinct-identifier weight", () => {
		const [base, head] = pairBlock(
			["  f(alpha);", "  g(alpha);"],
			["  f(first);", "  g(first);"],
			[10, 20],
		);
		const { files, op } = relocation(base, head);
		expect(op.divergences.every((d) => d.class === "rename")).toBe(true);
		expect(op.reviewWeight).toBe(1);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("drops a forged comment-only class on a real code change", () => {
		const { files, op } = codeChange();
		expect(op.divergences[0]?.class).toBe("code");
		const forged = { ...reclassed(op, "comment-only"), reviewWeight: 0 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a forged rename class on a real code change", () => {
		const { files, op } = codeChange();
		const forged = { ...reclassed(op, "rename"), reviewWeight: 0 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops an exact claim that lists a divergence", () => {
		const { files, op } = codeChange();
		expect(verifyRelocation({ ...op, exact: true }, files)).toBe(false);
	});

	it("drops a claim whose reviewWeight differs from the verified divergences", () => {
		const { files, op } = codeChange();
		expect(verifyRelocation({ ...op, reviewWeight: 0 }, files)).toBe(false);
	});

	it("drops a python floor-division change forged as comment-only", () => {
		const [base, head] = pairBlock(["  x = a // b"], ["  x = a // c"], [15]);
		const { files, op } = relocation(base, head, ["src/a.py", "src/b.py"]);
		const forged = { ...reclassed(op, "comment-only"), reviewWeight: 0 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a shell URL change forged as comment-only", () => {
		const [base, head] = pairBlock(
			["  curl http://good.example.com/x"],
			["  curl http://evil.example.com/x"],
			[15],
		);
		const { files, op } = relocation(base, head, ["src/a.sh", "src/b.sh"]);
		const forged = { ...reclassed(op, "comment-only"), reviewWeight: 0 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a swap forged as a rename", () => {
		const [base, head] = pairBlock(
			["  f(a, b);", "  g(a, b);"],
			["  f(b, a);", "  g(b, a);"],
			[10, 20],
		);
		const { files, op } = relocation(base, head);
		const forged = { ...reclassed(op, "rename"), reviewWeight: 2 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a merge forged as a rename", () => {
		const [base, head] = pairBlock(
			["  f(a, b);", "  g(a, b);"],
			["  f(b, b);", "  g(b, b);"],
			[10, 20],
		);
		const { files, op } = relocation(base, head);
		const forged = { ...reclassed(op, "rename"), reviewWeight: 1 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a literal flip forged as a rename", () => {
		const [base, head] = pairBlock(
			["  done = true;", "  flag(true);"],
			["  done = false;", "  flag(false);"],
			[10, 20],
		);
		const { files, op } = relocation(base, head);
		const forged = { ...reclassed(op, "rename"), reviewWeight: 1 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a rename that leaves the old name in the head span", () => {
		const [base, head] = pairBlock(
			["  f(a);", "  g(a);", "  h(a);"],
			["  f(z);", "  g(z);", "  h(a);"],
			[8, 14, 20],
		);
		const { files, op } = relocation(base, head);
		const forged = { ...reclassed(op, "rename"), reviewWeight: 1 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});
});

describe("verifyRelocation rename guards", () => {
	it("drops a rename claim when an inserted head line still uses the old name", () => {
		const [base, head] = pairBlock(
			["  f(a);", "  g(a);"],
			["  f(z);", "  g(z);"],
			[8, 20],
		);
		const clean = relocation(base, head);
		const dirty = [...head];
		dirty.splice(25, 0, "  k(a);");
		const files = moveFiles(base, dirty);
		const spanTo = clean.op.to[0] as Operation["to"][number];
		const forged: Operation = {
			...clean.op,
			to: [{ ...spanTo, endLine: spanTo.endLine + 1 }],
			divergences: [
				...clean.op.divergences,
				{
					kind: "inserted",
					class: "code",
					head: {
						filename: "src/b.ts",
						side: "head",
						startLine: spanTo.startLine + 25,
						endLine: spanTo.startLine + 25,
						shown: "full",
					},
				},
			],
			reviewWeight: 2,
		};
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops two old names collapsed into one new name forged as a rename", () => {
		const [base, head] = pairBlock(
			["  f(a, b);", "  g(a, b);"],
			["  f(c, c);", "  g(c, c);"],
			[10, 20],
		);
		const { files, op } = relocation(base, head);
		const forged = { ...reclassed(op, "rename"), reviewWeight: 2 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a rename claim that covers only some base occurrences of the old name", () => {
		const base = fn(body(30));
		base.splice(8, 0, "  f(a);");
		base.splice(14, 0, "  g(a);");
		base.splice(20, 0, "  h(a);");
		const head = fn(body(30));
		head.splice(8, 0, "  f(z);");
		head.splice(14, 0, "  g(z);");
		const { files, op } = relocation(base, head);
		expect(op.divergences.map((d) => d.kind)).toEqual([
			"changed",
			"changed",
			"removed",
		]);
		const forged: Operation = {
			...op,
			divergences: op.divergences.map((d) =>
				d.kind === "changed" ? { ...d, class: "rename" as const } : d,
			),
			reviewWeight: 2,
		};
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a claim carrying a class the checker does not know", () => {
		const { files, op } = codeChange();
		const forged = {
			...op,
			divergences: op.divergences.map((d) => ({ ...d, class: "trivial" })),
		} as unknown as Operation;
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("accepts a real python hash-comment change as comment-only", () => {
		const [base, head] = pairBlock(["  # old note"], ["  # new note"], [15]);
		const { files, op } = relocation(base, head, ["src/a.py", "src/b.py"]);
		expect(op.divergences.map((d) => d.class)).toEqual(["comment-only"]);
		expect(verifyRelocation(op, files)).toBe(true);
	});
});

describe("verifyRelocation comment allowlist", () => {
	it.each([
		[
			"src/a.css",
			"src/b.css",
			"  background: url(http://a/x.png);",
			"  background: url(http://b/x.png);",
		],
		["docs/a.md", "docs/b.md", "  [docs](http://a)", "  [docs](http://b)"],
		[
			"web/a.html",
			"web/b.html",
			'  <a href="http://a/x">go</a>',
			'  <a href="http://b/x">go</a>',
		],
		[
			"notes/a.txt",
			"notes/b.txt",
			"  see http://a/x now",
			"  see http://b/x now",
		],
		["lib/a.zzz", "lib/b.zzz", "  see http://a/x now", "  see http://b/x now"],
	])("drops a changed // line in %s forged as comment-only", (from, to, before, after) => {
		const [base, head] = pairBlock([before], [after], [15]);
		const { files, op } = relocation(base, head, [from, to]);
		expect(op.divergences.map((d) => d.class)).toEqual(["code"]);
		const forged = { ...reclassed(op, "comment-only"), reviewWeight: 0 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it.each([
		["ts"],
		["go"],
		["java"],
	])("accepts a real // comment change in a .%s file", (ext) => {
		const [base, head] = pairBlock(["  // old note"], ["  // new note"], [15]);
		const { files, op } = relocation(base, head, [
			`src/a.${ext}`,
			`src/b.${ext}`,
		]);
		expect(op.divergences.map((d) => d.class)).toEqual(["comment-only"]);
		expect(verifyRelocation(op, files)).toBe(true);
	});
});

describe("verifyRelocation oversized lines", () => {
	const long = `  const big = "${"x".repeat(2100)}";`;

	it("verifies an exact claim containing a very long line", () => {
		const block = withLine(fn(body(30)), 15, long);
		const { files, op } = relocation(block, block);
		expect(op.exact).toBe(true);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("verifies a code-divergence claim containing a very long line", () => {
		const base = withLine(fn(body(30)), 15, long);
		const head = withLine(base, 5, "  const v4 = evil() + offset;");
		const { files, op } = relocation(base, head);
		expect(op.divergences.map((d) => d.class)).toEqual(["code"]);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("still drops a rename claim over an oversized line", () => {
		const base = withLine(fn(body(30)), 15, long);
		base.splice(8, 0, "  f(a);");
		base.splice(20, 0, "  g(a);");
		const head = base.map((l) => l.replace("(a)", "(z)"));
		const { files, op } = relocation(base, head);
		const forged = { ...reclassed(op, "rename"), reviewWeight: 1 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});
});

describe("verifyRelocation block comment allowlist", () => {
	it("drops a changed /* */ line in a .md file forged as comment-only", () => {
		const [base, head] = pairBlock(["  /* old */"], ["  /* new */"], [15]);
		const { files, op } = relocation(base, head, ["docs/a.md", "docs/b.md"]);
		const forged = { ...reclassed(op, "comment-only"), reviewWeight: 0 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("accepts a real /* */ comment change in a .css file", () => {
		const [base, head] = pairBlock(["  /* old */"], ["  /* new */"], [15]);
		const { files, op } = relocation(base, head, ["src/a.css", "src/b.css"]);
		expect(op.divergences.map((d) => d.class)).toEqual(["comment-only"]);
		expect(verifyRelocation(op, files)).toBe(true);
	});
});

describe("verifyRelocation whole-line // allowlist", () => {
	it("drops a whole-line // change in a .md file forged as comment-only", () => {
		const [base, head] = pairBlock(["  // old"], ["  // new"], [15]);
		const { files, op } = relocation(base, head, ["docs/a.md", "docs/b.md"]);
		expect(op.divergences.map((d) => d.class)).toEqual(["code"]);
		const forged = { ...reclassed(op, "comment-only"), reviewWeight: 0 };
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("verifies a same-file relocation", () => {
		const block = fn(body(20));
		const files = [
			pushFile(
				"src/a.ts",
				[
					`@@ -10,${block.length} +9,0 @@`,
					...block.map((line) => `-${line}`),
					`@@ -60,0 +50,${block.length} @@`,
					...block.map((line) => `+${line}`),
				].join("\n"),
			),
		];
		const ops = findRelocations(files);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.from[0]?.filename).toBe(ops[0]?.to[0]?.filename);
		expect(verifyRelocation(ops[0] as Operation, files)).toBe(true);
	});

	it("drops a one-line claim whose text occurs twice on the base side", () => {
		const line = "  const registeredHandlerCount = loadHandlers(config);";
		const claim = () => lineClaim("src/a.ts", 10, 10, "src/b.ts", 3, 3);
		const added = pushFile(
			"src/b.ts",
			["@@ -0,0 +3,1 @@", `+${line}`].join("\n"),
		);
		const once = pushFile(
			"src/a.ts",
			["@@ -10,1 +9,0 @@", `-${line}`].join("\n"),
		);
		const twice = pushFile(
			"src/a.ts",
			["@@ -10,1 +9,0 @@", `-${line}`, "@@ -40,1 +38,0 @@", `-${line}`].join(
				"\n",
			),
		);
		expect(verifyRelocation(claim(), [once, added])).toBe(true);
		expect(verifyRelocation(claim(), [twice, added])).toBe(false);
	});

	it("drops a one-line claim whose text occurs twice on the head side", () => {
		const line = "  const registeredHandlerCount = loadHandlers(config);";
		const op = lineClaim("src/a.ts", 10, 10, "src/b.ts", 3, 3);
		const removed = pushFile(
			"src/a.ts",
			["@@ -10,1 +9,0 @@", `-${line}`].join("\n"),
		);
		const twice = pushFile(
			"src/b.ts",
			["@@ -0,0 +3,1 @@", `+${line}`, "@@ -30,0 +33,1 @@", `+${line}`].join(
				"\n",
			),
		);
		expect(verifyRelocation(op, [removed, twice])).toBe(false);
	});

	it("drops a short claim that carries too little information", () => {
		const line = "  return value;";
		const op = lineClaim("src/a.ts", 10, 10, "src/b.ts", 3, 3);
		const files = [
			pushFile("src/a.ts", ["@@ -10,1 +9,0 @@", `-${line}`].join("\n")),
			pushFile("src/b.ts", ["@@ -0,0 +3,1 @@", `+${line}`].join("\n")),
		];
		expect(verifyRelocation(op, files)).toBe(false);
	});

	function oneLine(
		baseFile: string,
		headFile: string,
		base: string,
		head: string = base,
	) {
		const op = lineClaim(baseFile, 10, 10, headFile, 40, 40);
		const files =
			baseFile === headFile
				? [
						pushFile(
							baseFile,
							[
								"@@ -10,1 +9,0 @@",
								`-${base}`,
								"@@ -39,0 +40,1 @@",
								`+${head}`,
							].join("\n"),
						),
					]
				: [
						pushFile(baseFile, ["@@ -10,1 +9,0 @@", `-${base}`].join("\n")),
						pushFile(headFile, ["@@ -39,0 +40,1 @@", `+${head}`].join("\n")),
					];
		return { op, files };
	}

	it("requires 50 characters of information for a short same-file claim", () => {
		const short = oneLine(
			"src/a.ts",
			"src/a.ts",
			"  return { ready: missing.length === 0, missing };",
		);
		const long = oneLine(
			"src/a.ts",
			"src/a.ts",
			"  const subtotal = computeSubtotal(items, taxRate, shippingZone);",
		);
		expect(verifyRelocation(short.op, short.files)).toBe(false);
		expect(verifyRelocation(long.op, long.files)).toBe(true);
	});

	it("accepts the same 41-character line when it crosses files", () => {
		const { op, files } = oneLine(
			"src/a.ts",
			"src/b.ts",
			"  return { ready: missing.length === 0, missing };",
		);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it.each([
		"  .map((item) => item.registeredHandlerCount)",
		"  ?.registeredHandlerCount.toString()",
		"  ?? loadRegisteredHandlerCount(config)",
		"  ? registeredHandlerCount : fallbackHandlerCount",
		"  => registeredHandlerCount(config, options)",
		"  + computeRegisteredOffset(config, options)",
		"  , registeredHandlerCount(config, options)",
		"  && registeredHandlerCount(config, options)",
		"  || registeredHandlerCount(config, options)",
	])("drops a short claim that continues an expression: %s", (line) => {
		const { op, files } = oneLine("src/a.ts", "src/b.ts", line);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("accepts a short whole-definition claim", () => {
		const base = [
			"def is_retryable(status):",
			"    return status >= 500 and status != 501",
		];
		const op = lineClaim("a.py", 10, 11, "b.py", 4, 5);
		const files = [
			pushFile(
				"a.py",
				["@@ -10,2 +9,0 @@", ...base.map((l) => `-${l}`)].join("\n"),
			),
			pushFile(
				"b.py",
				["@@ -3,0 +4,2 @@", ...base.map((l) => `+${l}`)].join("\n"),
			),
		];
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("accepts an unindented one-line declaration under 30 characters", () => {
		const { op, files } = oneLine(
			"src/a.ts",
			"src/b.ts",
			"export const MAX = 3;",
		);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("accepts an indented SCREAMING_CASE declaration", () => {
		const { op, files } = oneLine(
			"src/a.ts",
			"src/b.ts",
			"  const MAX_RETRIES = 3;",
		);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("drops an indented lower-case declaration under 30 characters", () => {
		const { op, files } = oneLine("src/a.ts", "src/b.ts", "  const max = 3;");
		expect(verifyRelocation(op, files)).toBe(false);
	});
});

describe("verifyRelocation independent small-claim rules", () => {
	const span = (
		filename: string,
		side: "base" | "head",
		startLine: number,
		endLine = startLine,
	) => ({ filename, side, startLine, endLine, shown: "full" as const });

	function exactClaim(from: Operation["from"], to: Operation["to"]): Operation {
		return {
			id: "relocation-1",
			type: "relocation",
			from,
			to,
			exact: true,
			divergences: [],
			reviewWeight: 0,
		};
	}

	function crossFile(
		baseRows: string[],
		headRows: string[],
		names: [string, string] = ["src/a.ts", "src/b.ts"],
		claimed = 1,
	) {
		const files = [
			pushFile(names[0], ["@@ -10,4 +10,1 @@", ...baseRows].join("\n")),
			pushFile(names[1], ["@@ -3,1 +3,4 @@", ...headRows].join("\n")),
		];
		const op = exactClaim(
			[span(names[0], "base", 10, 9 + claimed)],
			[span(names[1], "head", 3, 2 + claimed)],
		);
		return { files, op };
	}

	function forgedChange(op: Operation, original: string): Operation {
		return {
			...op,
			exact: false,
			reviewWeight: 1,
			divergences: [
				{
					kind: "changed",
					class: "code",
					base: op.from[0],
					head: op.to[0],
					original,
				},
			],
		};
	}

	const unclosed =
		"const resultOfTheLookup = compute(firstArgument, secondArgument,";

	it.each([
		[
			"a base line followed by a continuation context line",
			["-const total = compute(a, b)", " .map(wrap);"],
			["+const total = compute(a, b)"],
		],
		[
			"a line without a terminator followed by another line",
			["-const approvedUserList = loadUsers(config).length", " other();"],
			["+const approvedUserList = loadUsers(config).length", " other();"],
		],
		[
			"a line that ends in an operator",
			["-const approvedUserList = loadUsers(config) &&"],
			["+const approvedUserList = loadUsers(config) &&"],
		],
		[
			"a line that ends in a backslash",
			["-total_amount_for_user = compute_amount(account) + \\"],
			["+total_amount_for_user = compute_amount(account) + \\"],
		],
		[
			"a line that starts with a closer",
			["-} else if (user.isAdmin && flags.betaAccess) {"],
			["+} else if (user.isAdmin && flags.betaAccess) {"],
		],
		[
			"a single line with unclosed brackets",
			[`-${unclosed}`],
			[`+${unclosed}`],
		],
		["a one-letter declaration", ["-const i = 0;"], ["+const i = 0;"]],
		["a comparison read as a declaration", ["-FOO == bar"], ["+FOO == bar"]],
	])("drops an exact short claim over %s", (_, baseRows, headRows) => {
		const { files, op } = crossFile(baseRows, headRows);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("drops a claim that is one Python line ending in a colon", () => {
		const line = "def compute_total_with_tax(price, quantity, rate):";
		const { files, op } = crossFile(
			[`-${line}`],
			[`+${line}`],
			["a.py", "b.py"],
		);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it.each(
		partialStatements,
	)("drops an exact claim over %s", (_, baseRows, headRows, claimed, ext) => {
		const { files, op } = crossFile(
			baseRows,
			headRows,
			[`src/a.${ext}`, `src/b.${ext}`],
			claimed,
		);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("accepts a moved signature ending in an opening brace", () => {
		const signature = [
			"export function reasoningProviderOptions(",
			"  selection: ModelSelection,",
			"): Record<string, Record<string, string>> | undefined {",
		];
		const { files, op } = crossFile(
			signature.map((l) => `-${l}`),
			signature.map((l) => `+${l}`),
			["src/a.ts", "src/b.ts"],
			3,
		);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("treats text whose first line has over 50 sites as not unique", () => {
		const claimOver = (sites: number) => {
			const block = (i: number) => [
				"shared first line of every block",
				`  const unique${i}Value = compute(${i}, config);`,
			];
			const deleted = Array.from({ length: sites }, (_, i) => [
				`@@ -${i * 10 + 1},2 +${i * 10 + 1},0 @@`,
				...block(i).map((l) => `-${l}`),
			]).flat();
			const patch = [
				...deleted,
				"@@ -9000,0 +9000,2 @@",
				...block(0).map((l) => `+${l}`),
			].join("\n");
			const op = exactClaim(
				[span("src/a.ts", "base", 1, 2)],
				[span("src/a.ts", "head", 9000, 9001)],
			);
			return verifyRelocation(op, [pushFile("src/a.ts", patch)]);
		};
		expect(claimOver(10)).toBe(true);
		expect(claimOver(60)).toBe(false);
	});

	it.each([
		[
			"a forged declaration claim with an unrelated head line",
			"-const MAX = 5;",
			"+foo(bar, baz);",
			["src/a.ts", "src/b.ts"],
		],
		[
			"a forged claim between differently named constants",
			"-const ALPHA = 5;",
			"+const BETA = 5;",
			["src/a.ts", "src/b.ts"],
		],
		[
			"a declaration claim across extension families",
			"-const TIMEOUT = 30;",
			"+TIMEOUT = 30",
			["src/config.ts", "src/config.py"],
		],
	] as const)("drops %s", (_, baseRow, headRow, names) => {
		const { files, op } = crossFile([baseRow], [headRow], [...names]);
		expect(verifyRelocation(forgedChange(op, baseRow.slice(1)), files)).toBe(
			false,
		);
	});

	it.each([
		["a template literal", "const a = `start", "end`;", false],
		["no literal opener", "const a = start;", "end;", true],
	])("verifies a short claim in a file with %s", (_, open, close, holds) => {
		const seed = '    const userDisplayNameForAccount = "first";';
		const patch = (sign: string, line: string) =>
			["@@ -1,3 +1,3 @@", ` ${open}`, `${sign}${line}`, ` ${close}`].join("\n");
		const files = [
			pushFile("src/a.ts", patch("-", seed)),
			pushFile("src/b.ts", patch("+", seed.trimStart())),
		];
		const op = exactClaim(
			[span("src/a.ts", "base", 2)],
			[span("src/b.ts", "head", 2)],
		);
		expect(verifyRelocation(op, files)).toBe(holds);
	});

	it("drops a declaration claim when the name is also declared on a multi-line deleted line", () => {
		const claim = (extra: string[]) => {
			const files = [
				pushFile(
					"src/b.ts",
					["@@ -10,1 +10,0 @@", "-const LIMIT = { n: 1 };"].join("\n"),
				),
				pushFile(
					"src/c.ts",
					["@@ -3,0 +3,1 @@", "+const LIMIT = { n: 2 };"].join("\n"),
				),
				pushFile(
					"src/a.ts",
					["@@ -1,3 +1,0 @@", ...extra.map((l) => `-${l}`)].join("\n"),
				),
			];
			const op = exactClaim(
				[span("src/b.ts", "base", 10)],
				[span("src/c.ts", "head", 3)],
			);
			return verifyRelocation(
				forgedChange(op, "const LIMIT = { n: 1 };"),
				files,
			);
		};
		expect(claim([])).toBe(true);
		expect(claim(["const LIMIT = {", "  n: 1,", "};"])).toBe(false);
	});

	const sameFileLine =
		"  const subtotal = computeSubtotal(items, taxRate, shippingZone);";

	it("drops a same-file short claim whose lines share one hunk", () => {
		const files = [
			pushFile(
				"src/a.ts",
				[
					"@@ -10,6 +10,6 @@",
					`-${sameFileLine}`,
					" context one",
					" context two",
					" context three",
					`+${sameFileLine}`,
				].join("\n"),
			),
		];
		const op = exactClaim(
			[span("src/a.ts", "base", 10)],
			[span("src/a.ts", "head", 13)],
		);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("drops a same-file claim whose two sides sit in one change region", () => {
		const block = body(6);
		const files = [
			pushFile(
				"src/a.ts",
				[
					"@@ -1,8 +1,8 @@",
					" context a",
					...block.map((l) => `-${l}`),
					...block.map((l) => `+    ${l}`),
					" context b",
				].join("\n"),
			),
		];
		const op = exactClaim(
			[span("src/a.ts", "base", 2, 7)],
			[span("src/a.ts", "head", 2, 7)],
		);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("drops swapped claims over a paragraph repeated in two regions", () => {
		const paragraph = body(5);
		const region = (name: string) => [
			` context ${name}`,
			...paragraph.map((l) => `-${l}`),
			...paragraph.map((l) => `+    ${l}`),
			" context end",
		];
		const files = [
			pushFile(
				"src/a.ts",
				[
					"@@ -1,7 +1,7 @@",
					...region("a"),
					"@@ -30,7 +30,7 @@",
					...region("c"),
				].join("\n"),
			),
		];
		const swapped = exactClaim(
			[span("src/a.ts", "base", 2, 6)],
			[span("src/a.ts", "head", 31, 35)],
		);
		expect(verifyRelocation(swapped, files)).toBe(false);
	});

	it("verifies a claim over a 160KB line without scanning it", () => {
		const line = `x = "${'\\"'.repeat(80_000)}`;
		const { files, op } = crossFile([`-${line}`], [`+${line}`]);
		const started = performance.now();
		expect(verifyRelocation(op, files)).toBe(false);
		expect(performance.now() - started).toBeLessThan(5000);
	});
});

function movePair(
	baseName: string,
	headName: string,
	base: string[],
	head: string[],
): PushFile[] {
	return [
		pushFile(
			baseName,
			[`@@ -10,${base.length} +9,0 @@`, ...base.map((l) => `-${l}`)].join("\n"),
		),
		pushFile(
			headName,
			[`@@ -0,0 +3,${head.length} @@`, ...head.map((l) => `+${l}`)].join("\n"),
		),
	];
}

function handClaim(
	baseName: string,
	headName: string,
	base: string[],
	head: string[],
	shape?: Operation["shape"],
): { op: Operation; files: PushFile[] } {
	const op: Operation = {
		id: "relocation-1",
		type: "relocation",
		from: [
			{
				filename: baseName,
				side: "base",
				startLine: 10,
				endLine: 9 + base.length,
				shown: "full",
			},
		],
		to: [
			{
				filename: headName,
				side: "head",
				startLine: 3,
				endLine: 2 + head.length,
				shown: "full",
			},
		],
		exact: true,
		divergences: [],
		reviewWeight: 0,
		...(shape ? { shape } : {}),
	};
	return { op, files: movePair(baseName, headName, base, head) };
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
const PY_BASE = [
	"def total_price(items, tax_rate):",
	"    subtotal = sum(item.price for item in items)",
	"    tax = subtotal * tax_rate",
	"    return subtotal + tax",
];
const YAML_BASE = [
	"database:",
	"  host: db.internal.example",
	"  port: 5432",
	"  pool:",
	"    size: 20",
];

describe("verifyRelocation token equivalence", () => {
	it("verifies a reformatted TypeScript move", () => {
		const files = movePair(
			"src/a.ts",
			"src/b.ts",
			PRETTIER_BASE,
			PRETTIER_HEAD,
		);
		const ops = findRelocations(files);
		expect(ops).toHaveLength(1);
		expect(verifyRelocation(ops[0] as Operation, files)).toBe(true);
	});

	it("verifies a Black-wrapped Python call", () => {
		const base = [
			"result = process_order(customer_id, order_items, discount_code, shipping_address, billing_address)",
		];
		const head = [
			"result = process_order(",
			"    customer_id,",
			"    order_items,",
			"    discount_code,",
			"    shipping_address,",
			"    billing_address,",
			")",
		];
		const files = movePair("a.py", "b.py", base, head);
		const ops = findRelocations(files);
		expect(ops).toHaveLength(1);
		expect(verifyRelocation(ops[0] as Operation, files)).toBe(true);
	});

	it("verifies a re-indented Python move with the right shift", () => {
		const head = PY_BASE.map((l) => `    ${l}`);
		const files = movePair("a.py", "b.py", PY_BASE, head);
		const ops = findRelocations(files);
		expect(ops).toHaveLength(1);
		expect(ops[0]?.shape).toEqual({ reindent: 4 });
		expect(verifyRelocation(ops[0] as Operation, files)).toBe(true);
	});

	it("drops a claim whose shape.reindent is wrong", () => {
		const head = PY_BASE.map((l) => `    ${l}`);
		const { op, files } = handClaim("a.py", "b.py", PY_BASE, head, {
			reindent: 8,
		});
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("drops a claim that omits a needed shape.reindent", () => {
		const head = PY_BASE.map((l) => `    ${l}`);
		const { op, files } = handClaim("a.py", "b.py", PY_BASE, head);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("verifies a YAML block moved one level deeper", () => {
		const head = YAML_BASE.map((l) => `  ${l}`);
		const files = movePair("a.yml", "b.yml", YAML_BASE, head);
		const ops = findRelocations(files);
		expect(ops).toHaveLength(1);
		expect(verifyRelocation(ops[0] as Operation, files)).toBe(true);
	});

	it("drops a YAML claim that removes a space after the colon", () => {
		const head = YAML_BASE.map((l) => l.replace("port: 5432", "port:5432"));
		const { op, files } = handClaim("a.yml", "b.yml", YAML_BASE, head);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("drops a claim over a file whose patch contains a backtick", () => {
		const base = ["const total = a + b + c + d + e + f + g + h + i + j;"];
		const head = ["const total =", "  a + b + c + d + e + f + g + h + i + j;"];
		const { op, files } = handClaim("src/a.ts", "src/b.ts", base, head);
		expect(verifyRelocation(op, files)).toBe(true);
		const tainted = files.map((f) =>
			f.filename === "src/b.ts"
				? { ...f, patch: `${f.patch}\n unrelated(\`ctx\`)` }
				: f,
		);
		expect(verifyRelocation(op, tainted)).toBe(false);
	});

	it("drops a claim over a file whose context holds a triple quote", () => {
		const base = ["const total = a + b + c + d + e + f + g + h + i + j;"];
		const head = ["const total =", "  a + b + c + d + e + f + g + h + i + j;"];
		const { op, files } = handClaim("src/a.ts", "src/b.ts", base, head);
		const tainted = files.map((f) =>
			f.filename === "src/a.ts" ? { ...f, patch: `${f.patch}\n x = '''` } : f,
		);
		expect(verifyRelocation(op, tainted)).toBe(false);
	});

	it("drops a claim over a file whose context holds a heredoc opener", () => {
		const base = ["const total = a + b + c + d + e + f + g + h + i + j;"];
		const head = ["const total =", "  a + b + c + d + e + f + g + h + i + j;"];
		const { op, files } = handClaim("src/a.ts", "src/b.ts", base, head);
		const tainted = files.map((f) =>
			f.filename === "src/a.ts" ? { ...f, patch: `${f.patch}\n cat <<EOF` } : f,
		);
		expect(verifyRelocation(op, tainted)).toBe(false);
	});

	it("drops a Ruby reformat claim", () => {
		const { op, files } = handClaim(
			"a.rb",
			"b.rb",
			["total = compute_the_total_price(items, tax_rate, discount_code_value)"],
			[
				"total = compute_the_total_price(",
				"  items, tax_rate, discount_code_value)",
			],
		);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("drops a template literal reformat claim", () => {
		const { op, files } = handClaim(
			"src/a.ts",
			"src/b.ts",
			[
				"const message = `hello \u0024{name}, your order \u0024{orderId} has shipped`;",
			],
			[
				"const message =",
				"  `hello \u0024{name}, your order \u0024{orderId} has shipped`;",
			],
		);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("drops a claim whose lines hold unbalanced brackets", () => {
		const { op, files } = handClaim(
			"src/a.ts",
			"src/b.ts",
			[
				"const total = computeTotal(itemsInCart, taxRateForRegion,",
				"  couponCode);",
			],
			[
				"const total = computeTotal(itemsInCart, taxRateForRegion, couponCode);",
			],
		);
		expect(verifyRelocation(op, files)).toBe(true);
		const broken = handClaim(
			"src/a.ts",
			"src/b.ts",
			[
				"const total = computeTotal(itemsInCart, taxRateForRegion,",
				"  couponCode",
			],
			["const total = computeTotal(itemsInCart, taxRateForRegion, couponCode"],
		);
		expect(verifyRelocation(broken.op, broken.files)).toBe(false);
	});
});

describe("buildDiffModel with the real checker", () => {
	it("keeps a reformat-only move without dropping a claim", async () => {
		const files = movePair(
			"src/a.ts",
			"src/b.ts",
			PRETTIER_BASE,
			PRETTIER_HEAD,
		);
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
		expect(model.droppedClaims).toBe(0);
		expect(
			model.operations.filter((o) => o.type === "relocation"),
		).toHaveLength(1);
	});

	it("does not report a Ruby reformat as an operation", async () => {
		const rubyBase = [
			'config = { name: "alpha", retries: 3, timeout: 5000, verbose: false, region: "us-east" }',
		];
		const rubyHead = PRETTIER_HEAD.map((l) => l.replace(/;$/, ""));
		rubyHead[0] = "config = {";
		rubyHead[rubyHead.length - 1] = "}";
		const files = movePair("lib/a.rb", "lib/b.rb", rubyBase, rubyHead);
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
		expect(model.operations.filter((o) => o.type === "relocation")).toEqual([]);
		expect(model.droppedClaims).toBe(0);
	});
});

describe("buildDiffModel with legitimate reformats", () => {
	function model(files: PushFile[]) {
		return buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
	}

	it("keeps a Black-wrapped Python reformat", () => {
		const base = [
			"result = process_order(customer_id, order_items, discount_code, shipping_address, billing_address)",
		];
		const head = [
			"result = process_order(",
			"    customer_id,",
			"    order_items,",
			"    discount_code,",
			"    shipping_address,",
			"    billing_address,",
			")",
		];
		const built = model(movePair("a.py", "b.py", base, head));
		expect(built.droppedClaims).toBe(0);
		expect(
			built.operations.filter((o) => o.type === "relocation"),
		).toHaveLength(1);
	});

	it("keeps a YAML block moved one level deeper", () => {
		const head = YAML_BASE.map((l) => `  ${l}`);
		const built = model(movePair("a.yml", "b.yml", YAML_BASE, head));
		expect(built.droppedClaims).toBe(0);
		expect(
			built.operations.filter((o) => o.type === "relocation"),
		).toHaveLength(1);
	});

	it("keeps a gofmt-style Go reformat", () => {
		const base = [
			"server := NewServer(listenAddress, readTimeout, writeTimeout, maxHeaderBytes, tlsConfig)",
		];
		const head = [
			"server := NewServer(",
			"\tlistenAddress,",
			"\treadTimeout,",
			"\twriteTimeout,",
			"\tmaxHeaderBytes,",
			"\ttlsConfig,",
			")",
		];
		const built = model(movePair("a.go", "b.go", base, head));
		expect(built.droppedClaims).toBe(0);
		expect(
			built.operations.filter((o) => o.type === "relocation"),
		).toHaveLength(1);
	});
});

describe("verifyRelocation through the token path", () => {
	const BASE = [
		"const result = compute(",
		"  firstArgument,",
		"  secondArgument,",
		"  thirdArgument,",
		"  fourthArgument,",
		"  fifthArgument",
		");",
	];
	const HEAD = [
		"const result = compute(firstArgument, secondArgument,",
		"  thirdArgument, fourthArgument, fifthArgument);",
	];

	function patched(
		file: string,
		sign: "-" | "+",
		context: string,
		lines: string[],
	): PushFile {
		const total = lines.length + 1;
		const header =
			sign === "-" ? `@@ -9,${total} +9,1 @@` : `@@ -9,1 +9,${total} @@`;
		return pushFile(
			file,
			[header, ` ${context}`, ...lines.map((l) => `${sign}${l}`)].join("\n"),
		);
	}

	const reformat = (baseContext = "x = 1;", headContext = "x = 1;") => ({
		files: [
			patched("src/a.js", "-", baseContext, BASE),
			patched("src/b.js", "+", headContext, HEAD),
		],
		op: lineClaim("src/a.js", 10, 16, "src/b.js", 10, 11),
	});

	it("accepts a reformat only the token checker can account for", () => {
		const { files, op } = reformat();
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it.each([
		["a backtick", "x = `y`;", "x = 1;"],
		["a JSX element in the base patch", "x = <Foo>;", "x = 1;"],
		["a string it does not close", 'x = "abc', "x = 1;"],
		["a block comment opener", "/*", "x = 1;"],
	])("refuses it when a context line holds %s", (_, baseContext, headContext) => {
		const { files, op } = reformat(baseContext, headContext);
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("refuses a reformat claim that also lists an unrelated base file", () => {
		const { files, op } = reformat();
		files.push(patched("src/c.ts", "-", "x = 1;", ["const other = g(1, 2);"]));
		op.from.push({ ...(op.from[0] as Span), filename: "src/c.ts" });
		expect(verifyRelocation(op, files)).toBe(false);
	});

	it("refuses a token-equivalent claim that also lists a divergence", () => {
		const { files, op } = reformat();
		const listed: Operation = {
			...op,
			exact: false,
			reviewWeight: 1,
			divergences: [
				{
					kind: "changed",
					class: "code",
					base: op.from[0],
					head: { ...(op.to[0] as Span), endLine: 10 },
					original: BASE[0] as string,
				},
			],
		};
		expect(verifyRelocation(listed, files)).toBe(false);
	});

	it("checks the recorded re-indent shift", () => {
		const block = ["def total(items):", "    return sum(items) + 1"];
		const files = [
			patched("a/old.py", "-", "x = 1", block),
			patched(
				"a/new.py",
				"+",
				"x = 1",
				block.map((l) => `    ${l}`),
			),
		];
		const claim = (shape?: Operation["shape"]) => ({
			...lineClaim("a/old.py", 10, 11, "a/new.py", 10, 11),
			...(shape ? { shape } : {}),
		});
		expect(verifyRelocation(claim({ reindent: 4 }), files)).toBe(true);
		expect(verifyRelocation(claim(), files)).toBe(false);
		expect(verifyRelocation(claim({ reindent: 2 }), files)).toBe(false);
	});

	it("refuses a shifted YAML claim when a context line has a scalar header", () => {
		const block = [
			"server:",
			"  host: example.com",
			"  port: 8080",
			"  tls: true",
			"  retries: 3",
			"  timeout: 30",
		];
		const claim = (context: string) =>
			verifyRelocation(
				{
					...lineClaim("a/a.yml", 10, 15, "a/b.yml", 10, 15),
					shape: { reindent: 2 },
				},
				[
					patched("a/a.yml", "-", context, block),
					patched(
						"a/b.yml",
						"+",
						context,
						block.map((l) => `  ${l}`),
					),
				],
			);
		expect(claim("x: 1")).toBe(true);
		expect(claim("script: |2")).toBe(false);
	});

	it("refuses a whitespace-only pair when one line holds a carriage return", () => {
		const line = "return alpha_value + beta_value + gamma_value;";
		const claim = (base: string) =>
			verifyRelocation(lineClaim("src/a.js", 10, 10, "src/b.js", 10, 10), [
				patched("src/a.js", "-", "x = 1;", [base]),
				patched("src/b.js", "+", "x = 1;", [line]),
			]);
		expect(claim(line.replace("return ", "return   "))).toBe(true);
		expect(claim(line.replace("return ", "return\r "))).toBe(false);
	});
});

describe("verifyRelocation shape on positional claims", () => {
	const py = Array.from(
		{ length: 6 },
		(_, i) => `    v${i} = compute(${i}, offset)`,
	);
	it.each([
		["src/a.ts", "src/b.ts", fn(body(20))],
		["a/old.py", "a/new.py", ["def run(offset):", ...py]],
	])("drops a forged shift on a clean move of %s", (from, to, block) => {
		const { files, op } = relocation(block, block, [from, to]);
		expect(verifyRelocation(op, files)).toBe(true);
		for (const reindent of [4, -2])
			expect(verifyRelocation({ ...op, shape: { reindent } }, files)).toBe(
				false,
			);
	});
});

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
const TS_LINES = [
	"const cart = loadCart(userId);",
	"const items = cart.items.filter((item) => item.active);",
	"const subtotal = items.reduce((sum, item) => sum + item.price, 0);",
	"const discount = lookupDiscount(cart.code);",
	"const taxed = subtotal * (1 - discount);",
	"const shipping = shippingFor(cart.region, items.length);",
	"const total = taxed + shipping;",
	"recordTotal(cart.id, total);",
	"const receipt = buildReceipt(cart, items, total);",
	"sendReceipt(cart.email, receipt);",
	"auditTotal(cart.id, total, items.length);",
	"return total;",
];

function named(
	baseName: string,
	headName: string,
	base: string[],
	head: string[],
): PushFile[] {
	return [
		pushFile(
			baseName,
			[`@@ -10,${base.length} +9,0 @@`, ...base.map((l) => `-${l}`)].join("\n"),
		),
		pushFile(
			headName,
			[`@@ -0,0 +3,${head.length} @@`, ...head.map((l) => `+${l}`)].join("\n"),
		),
	];
}

function claim(
	baseName: string,
	headName: string,
	base: string[],
	head: string[],
) {
	const files = named(baseName, headName, base, head);
	const ops = findRelocations(files);
	expect(ops).toHaveLength(1);
	return { files, op: ops[0] as Operation };
}

function reweighed(op: Operation): Operation {
	const counted = op.divergences.filter(
		(d) => d.class === "signature" || d.class === "code",
	).length;
	const receivers = op.divergences.some((d) => d.class === "receiver");
	return { ...op, reviewWeight: counted + (receivers ? 1 : 0) };
}

function without(
	op: Operation,
	drop: (d: Operation["divergences"][number]) => boolean,
) {
	return reweighed({
		...op,
		divergences: op.divergences.filter((d) => !drop(d)),
	});
}

function headSpanOf(op: Operation, line: number) {
	return {
		...(op.to[0] as Operation["to"][number]),
		startLine: line,
		endLine: line,
	};
}

function baseSpanOf(op: Operation, line: number) {
	return {
		...(op.from[0] as Operation["from"][number]),
		startLine: line,
		endLine: line,
	};
}

function withHeadText(files: PushFile[], from: string, to: string): PushFile[] {
	return files.map((f) => ({ ...f, patch: (f.patch ?? "").replace(from, to) }));
}

function retargetHead(op: Operation, filename: string): Operation {
	const move = <T extends { filename: string; side: string }>(s: T): T =>
		s.side === "head" ? { ...s, filename } : s;
	return {
		...op,
		to: op.to.map(move),
		divergences: op.divergences.map((d) => ({
			...d,
			...(d.head ? { head: move(d.head) } : {}),
		})),
	};
}

describe("verifyRelocation with signature and receiver divergences", () => {
	it("verifies a Python function turned into a method", () => {
		const { files, op } = claim(
			"src/pricing.py",
			"src/cart.py",
			PY_FUNCTION,
			PY_METHOD,
		);
		expect(op.divergences.map((d) => d.class)).toEqual([
			"signature",
			"receiver",
			"receiver",
		]);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("verifies a renamed function with new parameters and an identical body", () => {
		const pyBody = [
			"    subtotal = sum(i.price for i in items)",
			"    taxed = subtotal * (1 + rate)",
			"    rounded = round(taxed, 2)",
			"    log_total(rounded, len(items))",
			"    return rounded",
		];
		const { files, op } = claim(
			"src/pricing.py",
			"src/cart.py",
			["def total_price(items, rate):", ...pyBody],
			[
				"    def compute(self, items, rate, region):",
				...pyBody.map((l) => `    ${l}`),
			],
		);
		expect(op.shape).toEqual({ reindent: 4 });
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("keeps a function-to-method claim through buildDiffModel", () => {
		const files = named(
			"src/pricing.py",
			"src/cart.py",
			PY_FUNCTION,
			PY_METHOD,
		);
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
		expect(model.droppedClaims).toBe(0);
		expect(model.operations.map((o) => o.type)).toEqual(["relocation"]);
	});

	it("verifies a TypeScript method with a signature change and receiver lines", () => {
		const { files, op } = claim(
			"src/discount.ts",
			"src/cart.ts",
			TS_FUNCTION,
			TS_METHOD,
		);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("verifies a brace-language reshape that stops partway through the body", () => {
		const lines = [
			"const subtotal = sumItems(items, rate);",
			"const taxed = applyTax(subtotal, rate);",
			"const fee = feeFor(taxed, rate);",
			"const rounded = roundTo(taxed, 2);",
			"logTotal(rounded, items.length);",
			"audit(rounded, rate);",
			"return rounded;",
		];
		const gained = lines.map((l, i) =>
			[0, 1, 2, 3].includes(i) ? l.replace(/(\w+)\(/, "this.$1(") : l,
		);
		const files = named(
			"src/a.ts",
			"src/b.ts",
			[
				"function total(items: Item[], rate: number): number {",
				...lines.map((l) => `  ${l}`),
				"}",
			],
			[
				"  total(items: Item[]): number {",
				...gained.map((l) => `    ${l}`),
				"  }",
			],
		);
		const ops = findRelocations(files);
		const reshape = ops.find((o) =>
			o.divergences.some((d) => d.class === "signature"),
		);
		expect(reshape).toBeDefined();
		expect(verifyRelocation(reshape as Operation, files)).toBe(true);
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
		expect(model.droppedClaims).toBe(0);
	});

	it("drops a claim that hides a gained this.", () => {
		const { files, op } = claim(
			"src/discount.ts",
			"src/cart.ts",
			TS_FUNCTION,
			TS_METHOD,
		);
		const hidden = without(
			op,
			(d) =>
				d.class === "receiver" &&
				d.original === "recordDiscount(cart.id, code, gross);",
		);
		expect(hidden.divergences).toHaveLength(op.divergences.length - 1);
		expect(verifyRelocation(hidden, files)).toBe(false);
	});

	it("drops a line-matcher claim that hides a gained this.", () => {
		const head = TS_LINES.map((l, i) =>
			i === 7 ? "this.recordTotal(cart.id, total);" : l,
		);
		const { files, op } = claim(
			"src/a.ts",
			"src/b.ts",
			TS_LINES.map((l) => `  ${l}`),
			head.map((l) => `    ${l}`),
		);
		expect(verifyRelocation(op, files)).toBe(true);
		expect(
			verifyRelocation({ ...claimedClean(op), reviewWeight: 0 }, files),
		).toBe(false);
	});

	describe("a receiver label on a line that differs by more than a receiver", () => {
		const base = TS_LINES.map((l) => `  ${l}`);
		function mislabelled(headLine: string) {
			const head = TS_LINES.map((l, i) => (i === 7 ? headLine : l));
			const files = named(
				"src/a.ts",
				"src/b.ts",
				base,
				head.map((l) => `    ${l}`),
			);
			const legit = findRelocations(files)[0] as Operation;
			const forged = reweighed({
				...legit,
				divergences: legit.divergences.map((d) => ({
					...d,
					class: "receiver" as const,
				})),
			});
			return { files, forged };
		}

		it("drops this.x relabelled that.x", () => {
			const { files, forged } = mislabelled(
				"that.recordTotal(cart.id, total);",
			);
			expect(forged.divergences).toHaveLength(1);
			expect(verifyRelocation(forged, files)).toBe(false);
		});

		it("drops an argument change beside this.", () => {
			const { files, forged } = mislabelled(
				"this.recordTotal(cart.id, total + 1);",
			);
			expect(forged.divergences).toHaveLength(1);
			expect(verifyRelocation(forged, files)).toBe(false);
		});

		it("drops self.a relabelled self.b in Python", () => {
			const py = TS_LINES.map((l) =>
				l.replace(/^const /, "").replace(/;$/, ""),
			);
			const basePy = py.map((l, i) =>
				i === 7 ? "self.recordTotal(cart.id, total)" : l,
			);
			const headPy = py.map((l, i) =>
				i === 7 ? "self.auditTotal(cart.id, total)" : l,
			);
			const files = named("src/a.py", "src/b.py", basePy, headPy);
			const legit = findRelocations(files)[0] as Operation;
			const forged = reweighed({
				...legit,
				divergences: legit.divergences.map((d) => ({
					...d,
					class: "receiver" as const,
				})),
			});
			expect(forged.divergences).toHaveLength(1);
			expect(verifyRelocation(forged, files)).toBe(false);
		});
	});

	it("drops a reshape whose body changed an argument beside a receiver line", () => {
		const { files, op } = claim(
			"src/pricing.py",
			"src/cart.py",
			PY_FUNCTION,
			PY_METHOD,
		);
		const edited = withHeadText(
			files,
			"self.log_total(rounded, len(items))",
			"self.log_total(rounded, len(items), 1)",
		);
		expect(verifyRelocation(op, edited)).toBe(false);
	});

	it("drops a claim missing a signature line", () => {
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
		const { files, op } = claim("src/report.py", "src/builder.py", base, head);
		expect(verifyRelocation(op, files)).toBe(true);
		const openerOnly = without(
			op,
			(d) => d.class === "signature" && d.kind !== "changed",
		);
		expect(openerOnly.divergences).toHaveLength(1);
		expect(verifyRelocation(openerOnly, files)).toBe(false);
	});

	it("drops a claim with an invented signature divergence", () => {
		const { files, op } = claim(
			"src/pricing.py",
			"src/cart.py",
			PY_FUNCTION,
			PY_METHOD,
		);
		const invented = reweighed({
			...op,
			divergences: [
				...op.divergences,
				{
					kind: "changed",
					class: "signature",
					base: baseSpanOf(op, 12),
					head: headSpanOf(op, 5),
					original: "taxed = subtotal * (1 + tax_rate)",
				},
			],
		});
		expect(verifyRelocation(invented, files)).toBe(false);
	});

	it("drops a signature divergence on token-equal signatures", () => {
		const base = TS_LINES.map((l) => `  ${l}`);
		const wrapped = (lines: string[]) => [
			"  process(items: Item[]): number {",
			...lines,
			"  }",
		];
		const baseBlock = wrapped(
			base.map((l) => l.replace("recordTotal(", "this.recordTotal(")),
		);
		const headBlock = wrapped(base);
		const { files, op } = claim("src/a.ts", "src/b.ts", baseBlock, headBlock);
		const invented = reweighed({
			...op,
			divergences: [
				{
					kind: "changed",
					class: "signature",
					base: baseSpanOf(op, 10),
					head: headSpanOf(op, 3),
					original: "process(items: Item[]): number {",
				},
				...op.divergences,
			],
		});
		expect(verifyRelocation(invented, files)).toBe(false);
	});

	it("drops a claim whose shape.reindent is wrong or missing", () => {
		const { files, op } = claim(
			"src/pricing.py",
			"src/cart.py",
			PY_FUNCTION,
			PY_METHOD,
		);
		expect(op.shape).toEqual({ reindent: 4 });
		const { shape: _shape, ...unshaped } = op;
		expect(verifyRelocation(unshaped, files)).toBe(false);
		expect(verifyRelocation({ ...op, shape: { reindent: 8 } }, files)).toBe(
			false,
		);
	});

	it("drops a Python reshape indented with tabs", () => {
		const { op } = claim(
			"src/pricing.py",
			"src/cart.py",
			PY_FUNCTION,
			PY_METHOD,
		);
		const tabs = (lines: string[], opener: number) =>
			lines.map((l) =>
				l.replace(/^ +/, (s) => "\t".repeat(s.length / 4 - opener)),
			);
		const files = named(
			"src/pricing.py",
			"src/cart.py",
			tabs(PY_FUNCTION, 0),
			tabs(PY_METHOD, 0),
		);
		expect(verifyRelocation({ ...op, shape: { reindent: 1 } }, files)).toBe(
			false,
		);
	});

	it("verifies a decorator added to the method as an inserted signature divergence", () => {
		const base = [
			"def total_price(items, tax_rate):",
			"    subtotal = sum(item.price * item.qty for item in items)",
			"    taxed = subtotal * (1 + tax_rate)",
			"    rounded = round(taxed, 2)",
			"    log_total(rounded, len(items))",
			"    return rounded",
		];
		const head = [
			"    @classmethod",
			"    def total(cls, items):",
			"        subtotal = sum(item.price * item.qty for item in items)",
			"        taxed = subtotal * (1 + cls.tax_rate)",
			"        rounded = round(taxed, 2)",
			"        cls.log_total(rounded, len(items))",
			"        return rounded",
		];
		const { files, op } = claim("src/pricing.py", "src/cart.py", base, head);
		expect(
			op.divergences.some(
				(d) => d.class === "signature" && d.kind === "inserted",
			),
		).toBe(true);
		expect(verifyRelocation(op, files)).toBe(true);
		const lost = without(op, (d) => d.kind === "inserted");
		expect(verifyRelocation(lost, files)).toBe(false);
	});

	it("verifies a TypeScript line-matcher claim with one receiver divergence and weight 1", () => {
		const head = TS_LINES.map((l, i) =>
			i === 7 ? "this.recordTotal(cart.id, total);" : l,
		);
		const { files, op } = claim(
			"src/a.ts",
			"src/b.ts",
			TS_LINES.map((l) => `  ${l}`),
			head.map((l) => `    ${l}`),
		);
		expect(op.divergences.map((d) => d.class)).toEqual(["receiver"]);
		expect(op.reviewWeight).toBe(1);
		expect(verifyRelocation(op, files)).toBe(true);
		expect(verifyRelocation({ ...op, reviewWeight: 0 }, files)).toBe(false);
		expect(verifyRelocation({ ...op, exact: true }, files)).toBe(false);
	});

	describe("files from different families", () => {
		const unterminated = (lines: string[]) =>
			lines.map((l, i) => (i === 5 ? l.replace(/;$/, "") : l));

		function retargeted(baseName: string, headName: string, javaName: string) {
			const { files, op } = claim(
				baseName,
				headName,
				unterminated(TS_FUNCTION),
				unterminated(TS_METHOD),
			);
			const java = files.map((f) =>
				f.filename === headName ? { ...f, filename: javaName } : f,
			);
			return { files, op, java, moved: retargetHead(op, javaName) };
		}

		it("drops a ts reshape whose head is a java file", () => {
			const { files, op, java, moved } = retargeted(
				"src/discount.ts",
				"src/cart.ts",
				"src/Cart.java",
			);
			expect(verifyRelocation(op, files)).toBe(true);
			expect(verifyRelocation(moved, java)).toBe(false);
		});
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
const SWAP_BASE = [
	"    def tally(self, x):",
	"        total = self.a + x",
	"        rows = load_rows(total)",
	"        keys = build_keys(rows, x)",
	"        check_keys(keys, rows)",
	"        return total",
];
const SWAP_HEAD = [
	"def tally(x):",
	"    total = a + self.x",
	"    rows = load_rows(total)",
	"    keys = build_keys(rows, x)",
	"    check_keys(keys, rows)",
	"    return total",
];
const TS_RISKY_TAIL = "\n+  const s = `a\n+  b`;";

describe("verifyRelocation review weight for receivers", () => {
	it("weighs a signature change plus plain receiver lines as 2", () => {
		const { files, op } = claim("a.py", "b.py", PY_FUNCTION, PY_METHOD);
		expect(op.reviewWeight).toBe(2);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("drops a signature claim whose weight was forged to 0, 1 or 9", () => {
		const { files, op } = claim("a.py", "b.py", PY_FUNCTION, PY_METHOD);
		for (const w of [0, 1, 9])
			expect(verifyRelocation({ ...op, reviewWeight: w }, files)).toBe(false);
	});

	it("drops a claim that keeps the old max(...) receiver weight", () => {
		const { files, op } = claim("a.ts", "b.ts", TS_FUNCTION, TS_METHOD);
		const old = Math.max(
			op.divergences.filter((d) => d.class === "signature").length,
			1,
		);
		expect(old).not.toBe(op.reviewWeight);
		expect(verifyRelocation({ ...op, reviewWeight: old }, files)).toBe(false);
	});

	it("classes an assignment target that gained self. as code", () => {
		const { files, op } = claim("a.py", "b.py", STATE_BASE, STATE_HEAD);
		expect(op.divergences.map((d) => d.class)).toEqual(["signature", "code"]);
		expect(op.reviewWeight).toBe(2);
		expect(verifyRelocation(op, files)).toBe(true);
	});

	it("drops a claim that calls an assignment target change a receiver", () => {
		const { files, op } = claim("a.py", "b.py", STATE_BASE, STATE_HEAD);
		const forged = reweighed({
			...op,
			divergences: op.divergences.map((d) =>
				d.class === "code" ? { ...d, class: "receiver" as const } : d,
			),
		});
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("classes one receiver dropped and another added on a line as code", () => {
		const { files, op } = claim("a.py", "b.py", SWAP_BASE, SWAP_HEAD);
		expect(op.divergences.map((d) => d.class)).toEqual(["signature", "code"]);
		expect(verifyRelocation(op, files)).toBe(true);
		const forged = reweighed({
			...op,
			divergences: op.divergences.map((d) =>
				d.class === "code" ? { ...d, class: "receiver" as const } : d,
			),
		});
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a code claim whose weight leaves out the code line", () => {
		const { files, op } = claim("a.py", "b.py", STATE_BASE, STATE_HEAD);
		expect(verifyRelocation({ ...op, reviewWeight: 1 }, files)).toBe(false);
	});
});

describe("verifyRelocation forged signature and receiver claims", () => {
	it("drops a body line dedented in the head of a Python method", () => {
		const { files, op } = claim("a.py", "b.py", PY_FUNCTION, PY_METHOD);
		const edited = withHeadText(
			files,
			"+        rounded = round(taxed, 2)",
			"+    rounded = round(taxed, 2)",
		);
		expect(verifyRelocation(op, edited)).toBe(false);
	});

	it("drops a body line indented deeper in the head of a Python method", () => {
		const { files, op } = claim("a.py", "b.py", PY_FUNCTION, PY_METHOD);
		const edited = withHeadText(
			files,
			"+        rounded = round(taxed, 2)",
			"+            rounded = round(taxed, 2)",
		);
		expect(verifyRelocation(op, edited)).toBe(false);
	});

	it("drops a signature divergence whose original text was tampered", () => {
		const { files, op } = claim("a.py", "b.py", PY_FUNCTION, PY_METHOD);
		const forged = {
			...op,
			divergences: op.divergences.map((d) =>
				d.class === "signature" ? { ...d, original: "def other():" } : d,
			),
		};
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a receiver divergence whose original text was tampered", () => {
		const { files, op } = claim("a.py", "b.py", PY_FUNCTION, PY_METHOD);
		const forged = {
			...op,
			divergences: op.divergences.map((d) =>
				d.class === "receiver" ? { ...d, original: "zzz" } : d,
			),
		};
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a duplicated signature divergence", () => {
		const { files, op } = claim("a.py", "b.py", PY_FUNCTION, PY_METHOD);
		const sig = op.divergences.filter((d) => d.class === "signature");
		const forged = reweighed({
			...op,
			divergences: [...op.divergences, ...sig],
		});
		expect(verifyRelocation(forged, files)).toBe(false);
	});

	it("drops a TypeScript reshape when a template literal sits elsewhere in the head patch", () => {
		const { files, op } = claim("a.ts", "b.ts", TS_FUNCTION, TS_METHOD);
		expect(verifyRelocation(op, files)).toBe(true);
		const tainted = files.map((f) =>
			f.filename === "b.ts" ? { ...f, patch: `${f.patch}${TS_RISKY_TAIL}` } : f,
		);
		expect(verifyRelocation(op, tainted)).toBe(false);
	});
});

describe("verifyRelocation opener scan stays linear", () => {
	const longLines = [`${"static ".repeat(32000)}!`, "a <b ".repeat(32000)];

	it.each(longLines)("returns quickly for a %#th pathological line", (line) => {
		const lines = [...TS_METHOD.slice(0, 3), line, ...TS_METHOD.slice(3)];
		const files = named("a.ts", "b.ts", TS_FUNCTION, lines);
		const started = performance.now();
		const ops = findRelocations(files);
		for (const op of ops) verifyRelocation(op, files);
		expect(performance.now() - started).toBeLessThan(1000);
	}, 5000);
});
