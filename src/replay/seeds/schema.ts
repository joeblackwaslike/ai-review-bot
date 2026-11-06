import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Defect = z
	.object({
		path: z.string().min(1),
		startLine: z.number().int().positive(),
		endLine: z.number().int().positive(),
		description: z.string(),
	})
	.refine((d) => d.endLine >= d.startLine, "endLine before startLine");

export const SeedTruth = z.union([
	z.object({ clean: z.literal(true) }).strict(),
	z
		.object({
			clean: z.literal(false),
			defects: z.array(Defect).length(1),
		})
		.strict(),
]);
export type SeedTruth = z.infer<typeof SeedTruth>;

export interface Seed {
	id: string;
	opId: string;
	variant: string;
	dir: string;
	truth: SeedTruth;
}

export const DEFAULT_SEEDS_ROOT = dirname(fileURLToPath(import.meta.url));

/** Loads `<opId>/<variant>/truth.json` from a seed directory; throws on a malformed truth. */
export async function loadSeed(dir: string): Promise<Seed> {
	const variant = basename(dir);
	const opId = basename(dirname(dir));
	const truth = SeedTruth.parse(
		JSON.parse(await readFile(join(dir, "truth.json"), "utf8")),
	);
	return { id: `${opId}/${variant}`, opId, variant, dir, truth };
}

const OP_DIR = /^[A-Z]+-\d+$/;

async function subdirs(dir: string): Promise<string[]> {
	return (await readdir(dir, { withFileTypes: true }))
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

/** Every seed under `root`, ordered by op id then variant. Non-op directories are skipped. */
export async function listSeeds(
	root: string = DEFAULT_SEEDS_ROOT,
): Promise<Seed[]> {
	const seeds: Seed[] = [];
	for (const op of (await subdirs(root)).filter((n) => OP_DIR.test(n))) {
		for (const v of await subdirs(join(root, op))) {
			seeds.push(await loadSeed(join(root, op, v)));
		}
	}
	return seeds;
}
