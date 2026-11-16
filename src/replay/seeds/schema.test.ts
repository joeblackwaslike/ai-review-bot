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
		expect(SeedTruth.safeParse({ clean: true }).success).toBe(true);
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
