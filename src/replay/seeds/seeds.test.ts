import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { seedReviewInput, truthInDiff } from "./input.js";
import { materializeSeed } from "./materialize.js";
import { listSeeds, type Seed } from "./schema.js";

const OPS = ["DEL-04", "MEC-01", "REL-01", "REL-03", "REL-10"];
const VARIANTS = ["clean", "original", "v1", "v2", "v3"];
const DEFECT_VARIANTS = ["original", "v1", "v2", "v3"];
const HINT_WORDS = /\b(bug|seed|todo|fixme|stale)\b/i;
const SLOW = 120_000;

async function filesUnder(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...(await filesUnder(p)));
		else out.push(p);
	}
	return out;
}

async function languages(seed: Seed): Promise<Set<string>> {
	const files = await filesUnder(join(seed.dir, "head"));
	return new Set(files.map((f) => extname(f)).filter((e) => e !== ""));
}

let seeds: Seed[];

beforeAll(async () => {
	seeds = await listSeeds();
});

describe("shipped seeds", () => {
	it("are 5 operations times 5 variants", () => {
		expect(seeds.map((s) => s.id).sort()).toEqual(
			OPS.flatMap((op) => VARIANTS.map((v) => `${op}/${v}`)).sort(),
		);
	});

	it("keep clean controls defect free and defect seeds with one defect", () => {
		for (const s of seeds) {
			if (s.variant === "clean") expect(s.truth).toEqual({ clean: true });
			else expect(s.truth.clean).toBe(false);
		}
	});

	it("cover at least two languages per operation across the defect variants", async () => {
		for (const op of OPS) {
			const langs = new Set<string>();
			for (const s of seeds.filter(
				(x) => x.opId === op && DEFECT_VARIANTS.includes(x.variant),
			)) {
				for (const l of await languages(s)) langs.add(l);
			}
			expect(
				langs.size,
				`${op}: ${[...langs].join(",")}`,
			).toBeGreaterThanOrEqual(2);
		}
	});

	it("contain no hint words in base or head", async () => {
		for (const s of seeds) {
			for (const side of ["base", "head"]) {
				for (const f of await filesUnder(join(s.dir, side))) {
					const text = await readFile(f, "utf8");
					expect(text, `${s.id} ${f}`).not.toMatch(HINT_WORDS);
				}
			}
		}
	});

	it(
		"materialise to two distinct commits with the defect inside the diff",
		async () => {
			for (const s of seeds) {
				const m = await materializeSeed(s);
				await m.cleanup();
				expect(m.baseSha, s.id).not.toBe(m.headSha);
				const input = await seedReviewInput(s);
				try {
					expect(input.files.length, s.id).toBeGreaterThan(0);
					expect(truthInDiff(s, input.files), s.id).toBe(true);
				} finally {
					await input.cleanup();
				}
			}
		},
		SLOW,
	);
});
