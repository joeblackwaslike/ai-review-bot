import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { legacyTierMap } from "../../router.js";
import type { ReviewStrategy } from "../strategy.js";
import {
	estimateSpendMatched,
	oneRunEstimate,
	runSpendMatched,
	selectionFor,
} from "./spend-matched.js";

const A0_SKILL = "a0-single-reviewer.md";

const skillsDir = fileURLToPath(new URL("../../../skills", import.meta.url));
const readSkillFile = (name: string): string =>
	readFileSync(`${skillsDir}/${name}`, "utf8");

/** Bump when run or estimateCost behavior changes (repeat policy, tolerance), so stored cells go stale. */
export const A0_IMPLEMENTATION_REVISION = 2;

export function strategyA0Version(
	readSkill: (name: string) => string,
	revision: number = A0_IMPLEMENTATION_REVISION,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				readSkill(A0_SKILL),
				legacyTierMap("claude"),
				legacyTierMap("codex"),
				revision,
			]),
		)
		.digest("hex")
		.slice(0, 12);
}

let cachedVersion: string | undefined;

export { oneRunEstimate, selectionFor };

export const strategyA0: ReviewStrategy = {
	name: "a0",
	get version() {
		cachedVersion ??= strategyA0Version(readSkillFile);
		return cachedVersion;
	},
	needsCheckout: false,
	estimateCost: estimateSpendMatched,
	run: (input) =>
		runSpendMatched(input, { skill: A0_SKILL, label: "a0", ref: "replay" }),
};
