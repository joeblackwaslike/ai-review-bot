import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { SeedGate } from "../seeds/score.js";

const SeedGateSchema = z.object({
	pass: z.boolean(),
	originalsMissed: z.number(),
	cleanFindings: z.number(),
	reasons: z.array(z.string()),
});

/** `<root>/<plan-hash>/seed-gates.json`, `{strategy: SeedGate}`. `replay --seeds --strategy <name> --gate-plan <hash>` writes it through `writeSeedGate`. */
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

export function writeSeedGate(
	root: string,
	planHash: string,
	strategy: string,
	gate: SeedGate,
): void {
	const file = join(root, planHash, "seed-gates.json");
	const next = { ...readSeedGates(root, planHash), [strategy]: gate };
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(tmp, file);
}
