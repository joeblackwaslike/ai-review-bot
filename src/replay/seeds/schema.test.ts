import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultSeedsRoot, listSeeds, SeedTruth } from "./schema.js";

describe("SeedTruth", () => {
	const operation = {
		type: "relocation",
		from: [{ filename: "a.py", side: "base", startLine: 3, endLine: 9 }],
		to: [{ filename: "b.py", side: "head", startLine: 1, endLine: 7 }],
		divergences: [
			{
				kind: "changed",
				class: "code",
				base: { filename: "a.py", side: "base", startLine: 5, endLine: 5 },
				head: { filename: "b.py", side: "head", startLine: 3, endLine: 3 },
			},
		],
	};

	it("accepts operations and still rejects unknown keys", () => {
		expect(
			SeedTruth.safeParse({ clean: true, operations: [operation] }).success,
		).toBe(true);
		expect(SeedTruth.safeParse({ clean: true, operations: [] }).success).toBe(
			true,
		);
		expect(SeedTruth.safeParse({ clean: true }).success).toBe(false);
		expect(SeedTruth.safeParse({ clean: true, extra: 1 }).success).toBe(false);
		expect(
			SeedTruth.safeParse({
				clean: true,
				operations: [{ ...operation, extra: 1 }],
			}).success,
		).toBe(false);
		expect(
			SeedTruth.safeParse({
				clean: true,
				operations: [{ ...operation, type: "move" }],
			}).success,
		).toBe(false);
	});
});

describe("SeedOperation structure", () => {
	const base = { filename: "a.py", side: "base", startLine: 3, endLine: 9 };
	const head = { filename: "b.py", side: "head", startLine: 1, endLine: 7 };
	const relocation = { type: "relocation", from: [base], to: [head] };
	const accepts = (operation: object) =>
		SeedTruth.safeParse({
			clean: true,
			operations: [{ divergences: [], ...operation }],
		}).success;
	const divergence = (d: object) =>
		accepts({ ...relocation, divergences: [{ class: "code", ...d }] });

	it("requires operations", () => {
		expect(SeedTruth.safeParse({ clean: true }).success).toBe(false);
	});

	it("requires a divergence class and accepts each one", () => {
		expect(divergence({ kind: "changed", base, head })).toBe(true);
		expect(divergence({ kind: "changed", base, head, class: "rename" })).toBe(
			true,
		);
		expect(
			divergence({ kind: "changed", base, head, class: "comment-only" }),
		).toBe(true);
		expect(divergence({ kind: "changed", base, head, class: "other" })).toBe(
			false,
		);
		expect(
			accepts({
				...relocation,
				divergences: [{ kind: "changed", base, head }],
			}),
		).toBe(false);
	});

	it("requires head and forbids base for an inserted divergence", () => {
		expect(divergence({ kind: "inserted", head })).toBe(true);
		expect(divergence({ kind: "inserted" })).toBe(false);
		expect(divergence({ kind: "inserted", base, head })).toBe(false);
	});

	it("requires base and forbids head for a removed divergence", () => {
		expect(divergence({ kind: "removed", base })).toBe(true);
		expect(divergence({ kind: "removed" })).toBe(false);
		expect(divergence({ kind: "removed", base, head })).toBe(false);
	});

	it("requires both sides for a changed divergence", () => {
		expect(divergence({ kind: "changed", base })).toBe(false);
		expect(divergence({ kind: "changed", head })).toBe(false);
	});

	it("requires a relocation and a rename to name both sides", () => {
		for (const type of ["relocation", "rename"]) {
			expect(accepts({ type, from: [base], to: [head] })).toBe(true);
			expect(accepts({ type, from: [], to: [head] })).toBe(false);
			expect(accepts({ type, from: [base], to: [] })).toBe(false);
		}
	});

	it("lets a mechanical operation have one empty side", () => {
		expect(accepts({ type: "mechanical", from: [], to: [head] })).toBe(true);
		expect(accepts({ type: "mechanical", from: [base], to: [] })).toBe(true);
	});

	it("keeps from spans on the base side and to spans on the head side", () => {
		expect(accepts({ ...relocation, from: [head] })).toBe(false);
		expect(accepts({ ...relocation, to: [base] })).toBe(false);
	});

	it("accepts exact and a mechanical reason, and only on the right type", () => {
		expect(accepts({ ...relocation, exact: false })).toBe(true);
		expect(accepts({ ...relocation, exact: "no" })).toBe(false);
		const mechanical = { type: "mechanical", from: [base], to: [head] };
		expect(accepts({ ...mechanical, reason: "whitespace" })).toBe(true);
		expect(accepts({ ...mechanical, reason: "imports" })).toBe(true);
		expect(accepts({ ...mechanical, reason: "style" })).toBe(false);
		expect(accepts({ ...relocation, reason: "whitespace" })).toBe(false);
	});
});

describe("SeedTruth copy and class fields", () => {
	const copy = {
		type: "copy",
		shape: { sourceNew: true },
		from: [{ filename: "a.ts", side: "head", startLine: 5, endLine: 13 }],
		to: [{ filename: "b.ts", side: "head", startLine: 5, endLine: 13 }],
		divergences: [
			{
				kind: "changed",
				class: "receiver",
				base: { filename: "a.ts", side: "head", startLine: 7, endLine: 7 },
				head: { filename: "b.ts", side: "head", startLine: 7, endLine: 7 },
			},
		],
	};
	const parse = (operation: unknown) =>
		SeedTruth.safeParse({ clean: true, operations: [operation] }).success;

	it("accepts a copy with sourceNew and a divergence class", () => {
		expect(parse(copy)).toBe(true);
	});

	const at = (file: string, side: "base" | "head", line: number) => ({
		filename: file,
		side,
		startLine: line,
		endLine: line,
	});
	const signatureDivergence = {
		kind: "changed",
		class: "signature",
		base: at("a.ts", "base", 5),
		head: at("b.ts", "head", 5),
	};
	const relocation = {
		type: "relocation",
		shape: { reindent: 4 },
		from: [{ filename: "a.ts", side: "base", startLine: 5, endLine: 13 }],
		to: [{ filename: "b.ts", side: "head", startLine: 5, endLine: 13 }],
		divergences: [signatureDivergence],
	};

	it("accepts a relocation with a signature divergence and a reindent", () => {
		expect(parse(relocation)).toBe(true);
	});

	it("rejects a copy with a signature divergence", () => {
		expect(
			parse({
				...copy,
				divergences: [{ ...signatureDivergence, base: at("a.ts", "head", 5) }],
			}),
		).toBe(false);
	});

	it("allows sourceNew only on a copy and reindent only on a relocation", () => {
		expect(parse({ ...relocation, shape: { sourceNew: true } })).toBe(false);
		expect(parse({ ...copy, shape: { reindent: 4 } })).toBe(false);
		expect(
			parse({ ...relocation, type: "rename", shape: { reindent: 4 } }),
		).toBe(false);
	});

	it("rejects an empty shape", () => {
		expect(parse({ ...copy, shape: {} })).toBe(false);
	});

	it("requires both copy spans on the head side", () => {
		expect(parse({ ...copy, from: [{ ...copy.from[0], side: "base" }] })).toBe(
			false,
		);
		expect(parse({ ...copy, to: [{ ...copy.to[0], side: "base" }] })).toBe(
			false,
		);
	});

	it("rejects a copy whose spans overlap or are equal", () => {
		const same = { ...copy, to: [{ ...copy.from[0] }], divergences: [] };
		expect(parse(same)).toBe(false);
		const overlap = {
			...copy,
			from: [{ filename: "a.ts", side: "head", startLine: 5, endLine: 13 }],
			to: [{ filename: "a.ts", side: "head", startLine: 13, endLine: 20 }],
			divergences: [],
		};
		expect(parse(overlap)).toBe(false);
		const apart = {
			...overlap,
			to: [{ filename: "a.ts", side: "head", startLine: 14, endLine: 20 }],
		};
		expect(parse(apart)).toBe(true);
	});

	it("keeps divergence spans inside the operation's own spans", () => {
		expect(
			parse({
				...copy,
				divergences: [
					{
						...copy.divergences[0],
						head: at("b.ts", "head", 99),
					},
				],
			}),
		).toBe(false);
		expect(
			parse({
				...copy,
				divergences: [
					{
						...copy.divergences[0],
						base: at("other.ts", "head", 7),
					},
				],
			}),
		).toBe(false);
	});

	it("keeps a divergence span on the side of the span it lies in", () => {
		expect(
			parse({
				...copy,
				divergences: [{ ...copy.divergences[0], base: at("a.ts", "base", 7) }],
			}),
		).toBe(false);
	});

	it("forbids divergences on an exact operation", () => {
		expect(parse({ ...copy, exact: true })).toBe(false);
		expect(parse({ ...copy, exact: false })).toBe(true);
		expect(parse({ ...copy, exact: true, divergences: [] })).toBe(true);
	});

	it("rejects an unknown divergence class or shape key", () => {
		expect(
			parse({
				...copy,
				divergences: [
					{
						kind: "changed",
						class: "other",
						base: { filename: "a.ts", side: "head", startLine: 7, endLine: 7 },
						head: { filename: "b.ts", side: "head", startLine: 7, endLine: 7 },
					},
				],
			}),
		).toBe(false);
		expect(parse({ ...copy, shape: { sourceNew: true, extra: 1 } })).toBe(
			false,
		);
	});
});

describe("defaultSeedsRoot", () => {
	const real = join(process.cwd(), "src", "replay", "seeds");

	it("resolves to the committed seeds from source", async () => {
		expect(defaultSeedsRoot(import.meta.url)).toBe(real);
		expect(await listSeeds()).toHaveLength(39);
	});

	it("resolves to the committed seeds from a built dist path", () => {
		const built = pathToFileURL(
			join(process.cwd(), "dist", "replay", "seeds", "schema.js"),
		).href;
		expect(defaultSeedsRoot(built)).toBe(real);
	});
});
