import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SeedGate } from "../seeds/score.js";

const SeedGateSchema = z.object({
	pass: z.boolean(),
	originalsMissed: z.number(),
	cleanFindings: z.number(),
	reasons: z.array(z.string()),
});

/** `<root>/<plan-hash>/seed-gates.json`, `{strategy: SeedGate}`. Nothing writes it yet; storing `--seeds` results is phase 6. */
export function readSeedGates(
	root: string,
	planHash: string,
): Record<string, SeedGate> {
	const file = join(root, planHash, "seed-gates.json");
	if (!existsSync(file)) return {};
	return z
		.record(z.string(), SeedGateSchema)
		.parse(JSON.parse(readFileSync(file, "utf8")));
}
