import { existsSync } from "node:fs";
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

const SeedSpan = z
	.object({
		filename: z.string().min(1),
		side: z.enum(["base", "head"]),
		startLine: z.number().int().positive(),
		endLine: z.number().int().positive(),
	})
	.strict()
	.refine((s) => s.endLine >= s.startLine, "endLine before startLine");

/**
 * An operation a correct diff model reports for a seed. Lines are base-side numbers for
 * deleted code and head-side numbers for added code.
 */
export const SeedOperation = z
	.object({
		type: z.enum(["relocation", "rename", "mechanical"]),
		from: z.array(SeedSpan),
		to: z.array(SeedSpan),
		divergences: z.array(
			z
				.object({
					kind: z.enum(["changed", "inserted", "removed"]),
					base: SeedSpan.optional(),
					head: SeedSpan.optional(),
				})
				.strict(),
		),
	})
	.strict();
export type SeedOperation = z.infer<typeof SeedOperation>;
export type SeedSpan = z.infer<typeof SeedSpan>;

const Operations = z.array(SeedOperation).optional();

export const SeedTruth = z.union([
	z.object({ clean: z.literal(true), operations: Operations }).strict(),
	z
		.object({
			clean: z.literal(false),
			defects: z.array(Defect).length(1),
			operations: Operations,
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

/** The committed seeds, found from the package root so a built `dist/` copy still resolves. */
export function defaultSeedsRoot(fromUrl: string): string {
	let dir = dirname(fileURLToPath(fromUrl));
	for (;;) {
		if (existsSync(join(dir, "package.json")))
			return join(dir, "src", "replay", "seeds");
		const parent = dirname(dir);
		if (parent === dir) return join(process.cwd(), "src", "replay", "seeds");
		dir = parent;
	}
}

export const DEFAULT_SEEDS_ROOT = defaultSeedsRoot(import.meta.url);

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
