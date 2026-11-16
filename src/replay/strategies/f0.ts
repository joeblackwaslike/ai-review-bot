import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { legacyTierMap } from "../../router.js";
import type { ReviewStrategy } from "../strategy.js";
import { A0_IMPLEMENTATION_REVISION } from "./a0.js";
import { estimateSpendMatched, runSpendMatched } from "./spend-matched.js";

const F0_SKILL = "f0-runbook-reviewer.md";

const skillsDir = fileURLToPath(new URL("../../../skills", import.meta.url));
const readSkillFile = (name: string): string =>
	readFileSync(`${skillsDir}/${name}`, "utf8");

/** Bump when run or estimateCost behavior changes, so stored cells go stale. */
export const F0_IMPLEMENTATION_REVISION = 3;

export function strategyF0Version(
	readSkill: (name: string) => string,
	revision: number = F0_IMPLEMENTATION_REVISION,
	a0Revision: number = A0_IMPLEMENTATION_REVISION,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				readSkill(F0_SKILL),
				legacyTierMap("claude"),
				legacyTierMap("codex"),
				revision,
				a0Revision,
			]),
		)
		.digest("hex")
		.slice(0, 12);
}

let cachedVersion: string | undefined;

export const strategyF0: ReviewStrategy = {
	name: "f0",
	get version() {
		cachedVersion ??= strategyF0Version(readSkillFile);
		return cachedVersion;
	},
	needsCheckout: false,
	estimateCost: estimateSpendMatched,
	run: (input) =>
		runSpendMatched(input, {
			skill: F0_SKILL,
			label: "f0",
			ref: "replay-f0",
		}),
};
