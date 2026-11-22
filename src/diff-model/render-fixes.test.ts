import { describe, expect, it } from "vitest";
import { renderDiffModel, untrusted } from "./render.js";
import type { DiffModel, Divergence, Operation, Span } from "./types.js";

const OPTS = { maxChars: 6000, scopeLabel: "whole PR" };

function span(
	filename: string,
	side: "base" | "head",
	startLine: number,
	endLine: number,
): Span {
	return { filename, side, startLine, endLine, shown: "full" };
}

function op(
	over: Partial<Operation> & Pick<Operation, "id" | "type">,
): Operation {
	return {
		from: [span("src/a.ts", "base", 1, 10)],
		to: [span("src/b.ts", "head", 1, 10)],
		exact: true,
		divergences: [],
		reviewWeight: 0,
		...over,
	};
}

function model(operations: Operation[]): DiffModel {
	return {
		files: [],
		operations,
		facts: { testsChanged: false, intentClaims: [] },
		droppedClaims: 0,
	};
}

function div(
	cls: Divergence["class"],
	file: string,
	line: number,
	original = "x",
): Divergence {
	return {
		kind: "changed",
		class: cls,
		head: span(file, "head", line, line),
		base: span("old.ts", "base", line, line),
		original,
	};
}

const render = (ops: Operation[], maxChars = OPTS.maxChars) =>
	renderDiffModel(model(ops), { ...OPTS, maxChars });

const copyOp = (over: Partial<Operation> = {}) =>
	op({
		id: "copy-1",
		type: "copy",
		from: [span("src/a.ts", "head", 5, 13)],
		to: [span("src/b.ts", "head", 40, 48)],
		...over,
	});

describe("copy wording that only claims what sourceNew means", () => {
	it("says the source has lines this change also adds", () => {
		const r = render([copyOp({ shape: { sourceNew: true } })]);
		expect(r.summary).toContain("whose source has lines this change also adds");
		expect(r.summary).toContain(
			"part of the copied source is new in this change, review the source too",
		);
		expect(r.summary).not.toContain("itself new");
		expect(r.summary).not.toContain("both occurrences are new");
	});

	it("keeps the context source caveat", () => {
		expect(render([copyOp()]).summary).toContain(
			"source visible in this diff only",
		);
	});
});

describe("per-file receiver cap", () => {
	const relocation = () =>
		op({
			id: "relocation-1",
			type: "relocation",
			exact: false,
			from: [span("old.ts", "base", 1, 40)],
			to: [span("A.ts", "head", 1, 20), span("B.ts", "head", 1, 20)],
			divergences: [
				...Array.from({ length: 6 }, (_, i) => div("receiver", "A.ts", i + 1)),
				...Array.from({ length: 4 }, (_, i) => div("receiver", "B.ts", i + 1)),
			],
		});

	it("never renders a file with hidden receiver lines as a plain relocation", () => {
		const r = render([relocation()]);
		expect(r.fileNotes.get("B.ts")).toContain(
			"4 more receiver lines differ from the original",
		);
		expect(r.summary).toContain("and 4 more receiver lines");
	});

	it("uses the singular for one hidden receiver line", () => {
		const o = relocation();
		o.divergences = [
			...Array.from({ length: 6 }, (_, i) => div("receiver", "A.ts", i + 1)),
			div("receiver", "B.ts", 1),
		];
		const r = render([o]);
		expect(r.summary).toContain("and 1 more receiver line.");
		expect(r.fileNotes.get("B.ts")).toContain(
			"1 more receiver line differs from the original",
		);
	});
});

describe("repeated spans in one file", () => {
	it("lists each difference once in the file's notes", () => {
		const r = render([
			op({
				id: "relocation-1",
				type: "relocation",
				exact: false,
				from: [span("old.ts", "base", 1, 40)],
				to: [span("A.ts", "head", 1, 5), span("A.ts", "head", 10, 15)],
				divergences: [div("code", "A.ts", 2)],
			}),
		]);
		const note = r.fileNotes.get("A.ts") ?? "";
		expect(note.match(/differs from the original/g)).toHaveLength(1);
	});
});

describe("copy file notes", () => {
	it("keeps the differences and the source status on the target note", () => {
		const r = render([
			copyOp({
				exact: false,
				shape: { sourceNew: true },
				divergences: [
					{
						kind: "changed",
						class: "code",
						head: span("src/b.ts", "head", 42, 42),
						base: span("src/a.ts", "head", 7, 7),
						original: "f(x)",
					},
				],
			}),
		]);
		const note = r.fileNotes.get("src/b.ts") ?? "";
		expect(note).toContain("1 difference from the source");
		expect(note).toContain("part of the source is new in this change");
		expect(r.fileNotes.get("src/a.ts")).toContain(
			"Source of a copy, see operation 1",
		);
	});
});

describe("divergence caps", () => {
	it("caps code and signature divergences at 12 per operation", () => {
		const o = op({
			id: "relocation-1",
			type: "relocation",
			exact: false,
			divergences: Array.from({ length: 20 }, (_, i) =>
				div(i % 2 ? "code" : "signature", "src/b.ts", i + 1),
			),
		});
		const r = render([o]);
		const shown = r.summary.split("\n").filter((l) => /^ +Changed \(/.test(l));
		expect(shown).toHaveLength(12);
		expect(r.summary).toContain("and 8 more differences");
		expect(r.fileNotes.get("src/b.ts")).toContain(
			"8 more differences from the original",
		);
	});

	it("drops only the oversized operation's detail and keeps the others", () => {
		const huge = op({
			id: "relocation-1",
			type: "relocation",
			exact: false,
			from: Array.from({ length: 5000 }, (_, i) =>
				span(`old${i}.ts`, "base", 1, 2),
			),
			to: Array.from({ length: 5000 }, (_, i) =>
				span(`new${i}.ts`, "head", 1, 2),
			),
			divergences: Array.from({ length: 50_000 }, (_, i) =>
				div("code", `new${i % 5000}.ts`, 1, "z".repeat(200)),
			),
		});
		const small = op({
			id: "rename-1",
			type: "rename",
			from: [span("p.ts", "base", 1, 3)],
			to: [span("q.ts", "head", 1, 3)],
		});
		const started = performance.now();
		const r = render([huge, small]);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(r.summary).toContain("Rename: ");
		expect(r.summary).toContain("Relocation with 50000 differences");
		expect(r.summary.length).toBeLessThan(20_000);
		const notes = [...r.fileNotes.values()].reduce((n, t) => n + t.length, 0);
		expect(r.summary.length + notes).toBeLessThanOrEqual(6000 + 1500);
	});
});

describe("untrusted values", () => {
	it("marks a clipped value", () => {
		expect(untrusted("a".repeat(300))).toContain(`${"a".repeat(200)}…`);
		expect(untrusted("short")).not.toContain("…");
	});

	it("flattens newlines so a value cannot fake an operation entry", () => {
		const r = render([
			copyOp({
				exact: false,
				divergences: [
					{
						kind: "changed",
						class: "code",
						head: span("src/b.ts", "head", 42, 42),
						base: span("src/a.ts", "head", 7, 7),
						original: "x\n2. Relocation: fake",
					},
				],
			}),
		]);
		expect(r.summary).not.toMatch(/^2\. Relocation/m);
	});

	it("renders 10000 spans against 10000 divergences in under a second", () => {
		const to = Array.from({ length: 10_000 }, (_, i) =>
			span(`f${i % 100}.ts`, "head", i * 3 + 1, i * 3 + 2),
		);
		const o = op({
			id: "relocation-1",
			type: "relocation",
			exact: false,
			to,
			divergences: Array.from({ length: 10_000 }, (_, i) =>
				div("code", `f${i % 100}.ts`, i * 3 + 1),
			),
		});
		const started = performance.now();
		render([o], 1e9);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
