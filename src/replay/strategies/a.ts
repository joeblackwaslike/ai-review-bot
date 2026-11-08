import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAuditPass } from "../../audit.js";
import { computeRepeatedCost } from "../../models.js";
import { TIER1_SKILLS } from "../../review.js";
import { legacyTierMap, routeReviewerModel } from "../../router.js";
import {
	resolveSelectionAuth,
	routerContext,
	toLiveReviewOutput,
} from "../live-wiring.js";
import type { ReviewStrategy, StrategyInput } from "../strategy.js";
import { fixtureReviewer } from "../types.js";

const AGENTS_PER_REVIEW = 5;
export const CHARS_PER_TOKEN = 4;
export const EXPECTED_COMPLETION_TOKENS = 2000;

const skillsDir = fileURLToPath(new URL("../../../skills", import.meta.url));

const readSkillFile = (name: string): string =>
	readFileSync(`${skillsDir}/${name}`, "utf8");

export function strategyVersion(readSkill: (name: string) => string): string {
	const names = [...TIER1_SKILLS].sort();
	return createHash("sha256")
		.update(
			JSON.stringify([
				names.map((n) => [n, readSkill(n)]),
				legacyTierMap("claude"),
				legacyTierMap("codex"),
			]),
		)
		.digest("hex")
		.slice(0, 12);
}

let cachedVersion: string | undefined;

const selectionFor = (input: StrategyInput) =>
	routeReviewerModel(
		routerContext(input.files),
		input.asReviewer ?? fixtureReviewer(input.fixture),
	).selection;

export const strategyA: ReviewStrategy = {
	name: "a",
	get version() {
		cachedVersion ??= strategyVersion(readSkillFile);
		return cachedVersion;
	},
	needsCheckout: false,
	estimateCost(input) {
		return computeRepeatedCost(
			{
				promptTokens: input.diff.length / CHARS_PER_TOKEN,
				completionTokens: EXPECTED_COMPLETION_TOKENS,
			},
			selectionFor(input).model,
			AGENTS_PER_REVIEW,
		);
	},
	async run(input) {
		const started = Date.now();
		const { fixture } = input;
		const selection = selectionFor(input);
		const auth = await resolveSelectionAuth(selection.provider);
		const result = await runAuditPass({
			files: [{ path: "replay.diff", content: input.diff }],
			selection,
			extraInstructions: "",
			meta: { owner: fixture.owner, repo: fixture.repo, ref: "replay" },
			auth,
		});
		if (result.agentsAttempted > 0 && result.agentsSucceeded === 0)
			throw new Error(`all ${result.agentsAttempted} review agents failed`);
		return {
			...toLiveReviewOutput(result),
			posted: [],
			agentReviews: result.agentReviews,
			toolCalls: [],
			wallMs: Date.now() - started,
		};
	},
};
