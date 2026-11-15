import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAuditUserMessage } from "../../prompt.js";
import { mergeReviewsDetailed, runAgent } from "../../review.js";
import { legacyTierMap } from "../../router.js";
import { resolveSelectionAuth, toLiveFindings } from "../live-wiring.js";
import type { ReviewStrategy } from "../strategy.js";
import type { RoundUsage } from "../types.js";
import { oneRunEstimate, selectionFor } from "./a0.js";

const F0_SKILL = "f0-runbook-reviewer.md";

const skillsDir = fileURLToPath(new URL("../../../skills", import.meta.url));
const readSkillFile = (name: string): string =>
	readFileSync(`${skillsDir}/${name}`, "utf8");

/** Bump when run or estimateCost behavior changes, so stored cells go stale. */
export const F0_IMPLEMENTATION_REVISION = 1;

export function strategyF0Version(
	readSkill: (name: string) => string,
	revision: number = F0_IMPLEMENTATION_REVISION,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				readSkill(F0_SKILL),
				legacyTierMap("claude"),
				legacyTierMap("codex"),
				revision,
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
	estimateCost: oneRunEstimate,
	async run(input) {
		const started = Date.now();
		const { fixture, signal } = input;
		const selection = selectionFor(input);
		const auth = await resolveSelectionAuth(selection.provider);
		const context = buildAuditUserMessage({
			owner: fixture.owner,
			repo: fixture.repo,
			ref: "replay",
			extraInstructions: "",
			files: [{ path: "replay.diff", content: input.diff }],
		});
		const outcome = await runAgent(F0_SKILL, context, selection, "", {
			auth,
			abortSignal: signal,
		});
		if (outcome.status !== "ok")
			throw new Error(`f0 run failed: ${outcome.status}`);
		const usage: RoundUsage = { "f0.md": outcome.usage };
		const merged = mergeReviewsDetailed([outcome.review]);
		return {
			findings: toLiveFindings(merged.review),
			candidates: [],
			posted: [],
			agentReviews: [{ skill: "f0", review: outcome.review }],
			usage,
			toolCalls: [],
			wallMs: Date.now() - started,
		};
	},
};
