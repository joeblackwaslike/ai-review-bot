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

describe("defaultSeedsRoot", () => {
	const real = join(process.cwd(), "src", "replay", "seeds");

	it("resolves to the committed seeds from source", async () => {
		expect(defaultSeedsRoot(import.meta.url)).toBe(real);
		expect(await listSeeds()).toHaveLength(25);
	});

	it("resolves to the committed seeds from a built dist path", () => {
		const built = pathToFileURL(
			join(process.cwd(), "dist", "replay", "seeds", "schema.js"),
		).href;
		expect(defaultSeedsRoot(built)).toBe(real);
	});
});
