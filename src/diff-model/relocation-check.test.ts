import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { partialStatements } from "./partial-statements.fixture.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation } from "./relocation-check.js";
import type { Operation } from "./types.js";

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
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
	});

	it("rejects a claim that omits an inserted line", () => {
		const base = fn(body(30));
		const head = [...base.slice(0, 15), "  audit(input);", ...base.slice(15)];
		const { files, op } = relocation(base, head);
		expect(op.divergences).toHaveLength(1);
		expect(op.divergences[0]?.kind).toBe("inserted");
		expect(verifyRelocation(claimedClean(op), files)).toBe(false);
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

	const indented = "  const approvedUserList = loadUsers(config);";
	const unclosed =
		"const resultOfTheLookup = compute(firstArgument, secondArgument,";
	const ruby = ["def self.money(cents)", "  format(cents)", "end"];

	it.each([
		[
			"a head line that gains a continuation line",
			["-const total = compute(a, b)"],
			["+const total = compute(a, b)", "+  + secret"],
		],
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
			"a line followed by a closer on a deeper indent",
			[`-${indented}`, "     )"],
			[`+${indented}`, "     )"],
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

	it("accepts a short Ruby method that ends in end", () => {
		const { files, op } = crossFile(
			[...ruby.map((l) => `-${l}`), " end"],
			[...ruby.map((l) => `+${l}`), " end"],
			["lib/a.rb", "lib/b.rb"],
			3,
		);
		expect(verifyRelocation(op, files)).toBe(true);
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

	it("accepts a related one-line declaration with a small change", () => {
		const base = "export const DEFAULTS = { retries: 3, timeout: 1000 };";
		const { files, op } = crossFile(
			[`-${base}`],
			[`+${base.replace("3", "5")}`],
		);
		expect(verifyRelocation(forgedChange(op, base), files)).toBe(true);
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
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
