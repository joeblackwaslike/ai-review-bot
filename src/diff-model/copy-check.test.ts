import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { verifyCopy } from "./copy-check.js";
import { buildDiffModel } from "./index.js";
import * as relocationModule from "./relocation.js";
import type { Operation, Span } from "./types.js";

vi.mock("./relocation.js", async (original) => {
	const actual = await original<typeof import("./relocation.js")>();
	return { ...actual, findRelocations: vi.fn(actual.findRelocations) };
});

const { findRelocations } =
	await vi.importActual<typeof import("./relocation.js")>("./relocation.js");

function pushFile(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

function hunk(oldStart: number, newStart: number, rows: string[]): string {
	const oldCount = rows.filter((r) => !r.startsWith("+")).length;
	const newCount = rows.filter((r) => !r.startsWith("-")).length;
	return [
		`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
		...rows,
	].join("\n");
}

function added(filename: string, start: number, lines: string[]): PushFile {
	return pushFile(
		filename,
		hunk(
			0,
			start,
			lines.map((l) => `+${l}`),
		),
	);
}

function withContext(
	filename: string,
	start: number,
	context: string[],
	after: string[] = [],
): PushFile {
	return pushFile(
		filename,
		hunk(start, start, [
			...context.map((l) => ` ${l}`),
			...after.map((l) => ` ${l}`),
		]),
	);
}

function deleted(filename: string, start: number, lines: string[]): PushFile {
	return pushFile(
		filename,
		hunk(
			start,
			0,
			lines.map((l) => `-${l}`),
		),
	);
}

function body(count: number, tag = "v"): string[] {
	return Array.from(
		{ length: count },
		(_, i) => `  const ${tag}${i} = compute(${i}) + offset;`,
	);
}

function head(filename: string, startLine: number, endLine: number): Span {
	return { filename, side: "head", startLine, endLine, shown: "full" };
}

function claim(from: Span, to: Span, extra: Partial<Operation> = {}) {
	return {
		id: "copy-1",
		type: "copy",
		from: [from],
		to: [to],
		exact: true,
		divergences: [],
		reviewWeight: 0,
		...extra,
	} satisfies Operation;
}

function found(files: PushFile[]) {
	const ops = findRelocations(files);
	return {
		copies: ops.filter((op) => op.type === "copy"),
		others: ops.filter((op) => op.type !== "copy"),
	};
}

function onlyCopy(files: PushFile[]) {
	const { copies, others } = found(files);
	expect(copies).toHaveLength(1);
	return { op: copies[0] as Operation, others };
}

const contextSource = (lines = body(6)) => [
	withContext("src/a.ts", 10, lines, ["  done();"]),
	added("src/b.ts", 3, lines),
];

const addedSource = (lines = body(6)) => [
	added("src/a.ts", 10, lines),
	added("src/b.ts", 3, lines),
];

describe("verifyCopy", () => {
	it("verifies a copy of context lines with no weight and no sourceNew", () => {
		const files = contextSource();
		const { op, others } = onlyCopy(files);
		expect(op.reviewWeight).toBe(0);
		expect(op.shape?.sourceNew).toBeUndefined();
		expect(verifyCopy(op, files, others)).toBe(true);
	});

	it("verifies a duplicate of added lines as sourceNew with weight", () => {
		const files = addedSource();
		const { op, others } = onlyCopy(files);
		expect(op.shape?.sourceNew).toBe(true);
		expect(op.reviewWeight).toBeGreaterThanOrEqual(1);
		expect(verifyCopy(op, files, others)).toBe(true);
	});

	it("drops a duplicate of added lines that says sourceNew false", () => {
		const files = addedSource();
		const { op, others } = onlyCopy(files);
		const lie = { ...op, reviewWeight: 0, shape: undefined };
		expect(verifyCopy(lie, files, others)).toBe(false);
	});

	it("drops an edited copy of added lines that says sourceNew false", () => {
		const a = body(10);
		const b = a.map((l, i) =>
			i === 2 ? "  const v2 = compute(2) - offset;" : l,
		);
		const files = [added("src/a.ts", 10, a), added("src/b.ts", 3, b)];
		const { op, others } = onlyCopy(files);
		expect(op.reviewWeight).toBe(1);
		expect(verifyCopy(op, files, others)).toBe(true);
		expect(verifyCopy({ ...op, shape: undefined }, files, others)).toBe(false);
	});

	it("drops an edited copy of context lines that says sourceNew true", () => {
		const a = body(10);
		const b = a.map((l, i) =>
			i === 2 ? "  const v2 = compute(2) - offset;" : l,
		);
		const files = [
			withContext("src/a.ts", 10, a, ["done"]),
			added("src/b.ts", 3, b),
		];
		const { op, others } = onlyCopy(files);
		const lie = { ...op, shape: { sourceNew: true } };
		expect(verifyCopy(lie, files, others)).toBe(false);
	});

	it("drops a context source that says sourceNew true", () => {
		const files = contextSource();
		const { op, others } = onlyCopy(files);
		const lie = { ...op, reviewWeight: 1, shape: { sourceNew: true } };
		expect(verifyCopy(lie, files, others)).toBe(false);
	});

	it("keeps a copy of an edited copy of new code sourceNew with weight", () => {
		const a = body(10);
		const b = a.map((l, i) =>
			i === 2 ? "  const v2 = compute(2) - offset;" : l,
		);
		const files = [
			added("src/a.ts", 10, a),
			added("src/b.ts", 3, b),
			added("src/c.ts", 5, b),
		];
		const { copies, others } = found(files);
		const edited = copies.find((op) => op.divergences.length > 0);
		const chained = copies.find((op) => op.to[0]?.filename === "src/c.ts");
		expect(edited).toBeDefined();
		expect(chained).toBeDefined();
		const op = chained as Operation;
		expect(verifyCopy(edited as Operation, files, others)).toBe(true);
		expect(verifyCopy(op, files, others)).toBe(true);
		expect(op.shape?.sourceNew).toBe(true);
		expect(op.reviewWeight).toBeGreaterThanOrEqual(1);
		const lie = {
			...op,
			reviewWeight: op.divergences.length,
			shape: undefined,
		};
		expect(verifyCopy(lie, files, others)).toBe(false);
	});

	it("verifies a copy of relocated code as pre-existing", () => {
		const eight = body(8);
		const files = [
			deleted("src/old.ts", 1, eight),
			added("src/b.ts", 1, eight),
			added("src/c.ts", 1, eight),
		];
		const { op, others } = onlyCopy(files);
		expect(others).toHaveLength(1);
		expect(op.reviewWeight).toBe(0);
		expect(op.shape?.sourceNew).toBeUndefined();
		expect(verifyCopy(op, files, others)).toBe(true);
	});

	it("drops a copy of relocated code when the relocation is not verified", () => {
		const eight = body(8);
		const files = [
			deleted("src/old.ts", 1, eight),
			added("src/b.ts", 1, eight),
			added("src/c.ts", 1, eight),
		];
		const { op } = onlyCopy(files);
		expect(verifyCopy(op, files, [])).toBe(false);
	});

	it("drops a copy whose source lines are not in the head", () => {
		const files = contextSource();
		const { op, others } = onlyCopy(files);
		const from = head("src/a.ts", 110, 115);
		expect(verifyCopy({ ...op, from: [from] }, files, others)).toBe(false);
		const missing = head("src/a.ts", 12, 17);
		expect(verifyCopy({ ...op, from: [missing] }, files, others)).toBe(false);
	});

	it("drops a copy whose target lines include a context line", () => {
		const files = contextSource();
		const { op, others } = onlyCopy(files);
		const swapped = {
			...op,
			from: op.to,
			to: op.from,
			reviewWeight: 1,
			shape: { sourceNew: true },
		};
		expect(verifyCopy(swapped, files, others)).toBe(false);
	});

	it("drops a copy whose source spans two runs of the patch", () => {
		const lines = body(4);
		const files = [
			pushFile(
				"src/a.ts",
				hunk(10, 10, [
					...lines.map((l) => ` ${l}`),
					"-  gone();",
					...lines.map((l) => ` ${l}`),
				]),
			),
			added("src/b.ts", 3, [...lines, ...lines]),
		];
		const bad = claim(head("src/a.ts", 10, 17), head("src/b.ts", 3, 10));
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("drops overlapping source and target ranges", () => {
		const lines = body(12);
		const files = [added("src/b.ts", 3, lines)];
		const bad = claim(head("src/b.ts", 3, 8), head("src/b.ts", 5, 10), {
			reviewWeight: 1,
			shape: { sourceNew: true },
		});
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("drops a copy within one consecutive run of added lines", () => {
		const six = body(6);
		const files = [added("src/b.ts", 3, [...six, ...six])];
		const bad = claim(head("src/b.ts", 3, 8), head("src/b.ts", 9, 14), {
			reviewWeight: 1,
			shape: { sourceNew: true },
		});
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("drops a copy over a prose file", () => {
		const prose = body(6);
		const files = [
			withContext("docs/a.md", 10, prose, ["done"]),
			added("docs/b.md", 3, prose),
		];
		const bad = claim(head("docs/a.md", 10, 15), head("docs/b.md", 3, 8));
		expect(verifyCopy(bad, files, [])).toBe(false);
		const good = [
			withContext("src/a.ts", 10, prose, ["done"]),
			added("src/b.ts", 3, prose),
		];
		expect(
			verifyCopy(
				claim(head("src/a.ts", 10, 15), head("src/b.ts", 3, 8)),
				good,
				[],
			),
		).toBe(true);
	});

	it("drops a copy over a JSON file", () => {
		const data = body(6);
		const files = [
			withContext("src/a.json", 10, data, ["done"]),
			added("src/b.json", 3, data),
		];
		const bad = claim(head("src/a.json", 10, 15), head("src/b.json", 3, 8));
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("drops a copy over a lockfile", () => {
		const data = body(6);
		const files = [
			withContext("src/a.ts", 10, data, ["done"]),
			added("pnpm-lock.yaml", 3, data),
		];
		const bad = claim(head("src/a.ts", 10, 15), head("pnpm-lock.yaml", 3, 8));
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("drops a four-line block that is not a definition", () => {
		const four = body(4);
		const files = [
			withContext("src/a.ts", 10, four, ["done"]),
			added("src/b.ts", 3, four),
		];
		const bad = claim(head("src/a.ts", 10, 13), head("src/b.ts", 3, 6));
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("drops a one-line block", () => {
		const one = body(1);
		const files = [
			withContext("src/a.ts", 10, one, ["done"]),
			added("src/b.ts", 3, one),
		];
		const bad = claim(head("src/a.ts", 10, 10), head("src/b.ts", 3, 3));
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("verifies a whole definition of three lines and drops a short one", () => {
		const long = [
			"function clampValue(value) {",
			"  return Math.min(value, 9);",
			"}",
		];
		const short = ["function f(a) {", "  return a;", "}"];
		const verify = (lines: string[]) =>
			verifyCopy(
				claim(head("src/a.ts", 10, 12), head("src/b.ts", 3, 5)),
				[
					withContext("src/a.ts", 10, lines, ["done"]),
					added("src/b.ts", 3, lines),
				],
				[],
			);
		expect(verify(long)).toBe(true);
		expect(verify(short)).toBe(false);
	});

	it("drops a block of imports only", () => {
		const imports = Array.from(
			{ length: 6 },
			(_, i) => `import { name${i} } from "./module${i}.js";`,
		);
		const files = [
			withContext("src/a.ts", 10, imports, ["done"]),
			added("src/b.ts", 3, imports),
		];
		const bad = claim(head("src/a.ts", 10, 15), head("src/b.ts", 3, 8));
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("drops a block made only of object properties", () => {
		const props = Array.from(
			{ length: 6 },
			(_, i) => `  field${i}: value${i},`,
		);
		const files = [
			withContext("src/a.ts", 10, props, ["done"]),
			added("src/b.ts", 3, props),
		];
		const bad = claim(head("src/a.ts", 10, 15), head("src/b.ts", 3, 8));
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("drops a block whose brackets do not close", () => {
		const open = [...body(5), "  call("];
		const files = [
			withContext("src/a.ts", 10, open, ["done"]),
			added("src/b.ts", 3, open),
		];
		const bad = claim(head("src/a.ts", 10, 15), head("src/b.ts", 3, 8));
		expect(verifyCopy(bad, files, [])).toBe(false);
	});

	it("drops a claim with the wrong weight", () => {
		const files = contextSource();
		const { op, others } = onlyCopy(files);
		expect(verifyCopy({ ...op, reviewWeight: 2 }, files, others)).toBe(false);
	});

	it("drops exact true with divergences", () => {
		const a = body(10);
		const b = a.map((l, i) =>
			i === 2 ? "  const v2 = compute(2) - offset;" : l,
		);
		const files = [
			withContext("src/a.ts", 10, a, ["done"]),
			added("src/b.ts", 3, b),
		];
		const { op, others } = onlyCopy(files);
		expect(op.divergences).toHaveLength(1);
		expect(verifyCopy(op, files, others)).toBe(true);
		expect(verifyCopy({ ...op, exact: true }, files, others)).toBe(false);
	});

	it("drops a copy that hides a differing line", () => {
		const a = body(10);
		const b = a.map((l, i) =>
			i === 2 ? "  const v2 = compute(2) - offset;" : l,
		);
		const files = [
			withContext("src/a.ts", 10, a, ["done"]),
			added("src/b.ts", 3, b),
		];
		const { op, others } = onlyCopy(files);
		const hidden = { ...op, exact: true, divergences: [], reviewWeight: 0 };
		expect(verifyCopy(hidden, files, others)).toBe(false);
	});

	it("drops a copy that lists a signature divergence", () => {
		const a = body(10);
		const b = a.map((l, i) =>
			i === 2 ? "  const v2 = compute(2) - offset;" : l,
		);
		const files = [
			withContext("src/a.ts", 10, a, ["done"]),
			added("src/b.ts", 3, b),
		];
		const { op, others } = onlyCopy(files);
		const relabeled = {
			...op,
			reviewWeight: 0,
			divergences: op.divergences.map((d) => ({
				...d,
				class: "signature" as const,
			})),
		};
		expect(verifyCopy(relabeled, files, others)).toBe(false);
	});

	it("drops a divergence the lines do not bear out", () => {
		const files = contextSource();
		const { op, others } = onlyCopy(files);
		const bogus = {
			...op,
			exact: false,
			reviewWeight: 1,
			divergences: [
				{
					kind: "changed" as const,
					class: "code" as const,
					base: head("src/a.ts", 12, 12),
					head: head("src/b.ts", 5, 5),
					original: (body(6)[2] as string).trim(),
				},
			],
		};
		expect(verifyCopy(bogus, files, others)).toBe(false);
	});

	it("drops a source span that is not head-side", () => {
		const files = contextSource();
		const { op, others } = onlyCopy(files);
		const from = [{ ...(op.from[0] as Span), side: "base" as const }];
		expect(verifyCopy({ ...op, from }, files, others)).toBe(false);
	});

	it("drops a claim with a non-copy type or several spans", () => {
		const files = contextSource();
		const { op, others } = onlyCopy(files);
		expect(verifyCopy({ ...op, type: "relocation" }, files, others)).toBe(
			false,
		);
		expect(verifyCopy({ ...op, to: [...op.to, ...op.to] }, files, others)).toBe(
			false,
		);
	});

	it("drops a claim that carries a reindent", () => {
		const files = contextSource();
		const { op, others } = onlyCopy(files);
		const bad = { ...op, shape: { reindent: 2 } };
		expect(verifyCopy(bad, files, others)).toBe(false);
	});
});

const meta = { prFilesComplete: true, title: "t", body: null };

describe("buildDiffModel with copies", () => {
	beforeEach(() => {
		vi.mocked(relocationModule.findRelocations).mockImplementation(
			findRelocations,
		);
	});

	it("keeps a duplicated handler copy without dropping a claim", () => {
		const handler = [
			"export function handleRetry(request) {",
			"  const attempts = request.attempts + 1;",
			"  if (attempts > MAX_ATTEMPTS) {",
			"    return reject(request);",
			"  }",
			"  return schedule(request, attempts);",
			"}",
		];
		const files = [
			withContext("src/a.ts", 10, handler, ["done();"]),
			added("src/b.ts", 3, handler),
		];
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			...meta,
		});
		expect(model.droppedClaims).toBe(0);
		expect(model.operations.filter((op) => op.type === "copy")).toHaveLength(1);
	});

	it("drops a copy whose source relocation the checker rejects", () => {
		const eight = body(8);
		const files = [
			deleted("src/old.ts", 1, eight),
			added("src/b.ts", 1, eight),
			added("src/c.ts", 1, eight),
		];
		const real = findRelocations(files);
		const forged = real.map((op) =>
			op.type === "relocation"
				? { ...op, exact: false, reviewWeight: 7, divergences: [] }
				: op,
		);
		vi.mocked(relocationModule.findRelocations).mockReturnValue(forged);
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			...meta,
		});
		expect(model.operations.filter((op) => op.type !== "mechanical")).toEqual(
			[],
		);
		expect(model.droppedClaims).toBe(2);
	});
});
