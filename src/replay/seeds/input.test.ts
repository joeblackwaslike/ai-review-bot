import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedReviewInput, truthInDiff } from "./input.js";
import { loadSeed, type Seed } from "./schema.js";

let root: string;

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

async function makeSeed(
	truth: unknown,
	variant = "original",
	opId = "REL-01",
): Promise<Seed> {
	const dir = join(root, opId, variant);
	await write(join(dir, "base", "src", "a.ts"), "one\ntwo\nthree\n");
	await write(join(dir, "base", "src", "old.ts"), "moved content\nmore\n");
	await write(join(dir, "base", "gone.ts"), "bye\n");
	await write(join(dir, "head", "src", "a.ts"), "one\nTWO\nthree\nfour\n");
	await write(join(dir, "head", "lib", "new.ts"), "moved content\nmore\n");
	await write(join(dir, "head", "added.ts"), "x\n");
	await write(join(dir, "truth.json"), JSON.stringify(truth));
	return loadSeed(dir);
}

const defectAt = (path: string, startLine: number, endLine: number) => ({
	clean: false,
	defects: [{ path, startLine, endLine, description: "d" }],
});

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "seed-input-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("seedReviewInput", () => {
	it("builds files, a numbered diff, a fixture and a read-only checkout", async () => {
		const seed = await makeSeed(defectAt("src/a.ts", 2, 2));
		const input = await seedReviewInput(seed);
		try {
			const byName = new Map(input.files.map((f) => [f.filename, f]));
			const a = byName.get("src/a.ts");
			expect(a).toMatchObject({
				status: "modified",
				additions: 2,
				deletions: 1,
			});
			expect(a?.patch?.startsWith("@@")).toBe(true);
			expect(byName.get("added.ts")).toMatchObject({
				status: "added",
				additions: 1,
				deletions: 0,
			});
			expect(byName.get("gone.ts")).toMatchObject({ status: "removed" });
			expect(byName.get("lib/new.ts")).toMatchObject({
				status: "renamed",
				previous_filename: "src/old.ts",
			});
			expect(input.diff).toContain("   2|+TWO");
			expect(input.diff).toContain("src/a.ts");

			expect(input.fixture).toMatchObject({
				owner: "seed",
				repo: "REL-01-original",
				threads: [],
				reactions: [],
			});
			expect(input.round.claims).toEqual([]);
			expect(input.round.baseSha).toBe(input.checkout.baseSha);
			expect(input.round.headSha).toBe(input.checkout.headSha);

			await access(input.checkout.path);
			await expect(
				writeFile(join(input.checkout.path, "x.txt"), "x"),
			).rejects.toThrow();
		} finally {
			await input.cleanup();
		}
		await expect(access(input.checkout.path)).rejects.toThrow();
	});
});

describe("truthInDiff", () => {
	it("is true for a defect on shown right-side lines", async () => {
		const seed = await makeSeed(defectAt("src/a.ts", 2, 4));
		const input = await seedReviewInput(seed);
		try {
			expect(truthInDiff(seed, input.files)).toBe(true);
		} finally {
			await input.cleanup();
		}
	});

	it("is false for a range outside the diff or in an untouched file", async () => {
		const seed = await makeSeed(defectAt("src/a.ts", 2, 9));
		const other = await makeSeed(defectAt("nope.ts", 1, 1), "v1");
		const input = await seedReviewInput(seed);
		try {
			expect(truthInDiff(seed, input.files)).toBe(false);
			expect(truthInDiff(other, input.files)).toBe(false);
		} finally {
			await input.cleanup();
		}
	});

	it("is true for a clean control", async () => {
		const seed = await makeSeed({ clean: true }, "clean");
		expect(truthInDiff(seed, [])).toBe(true);
	});
});
