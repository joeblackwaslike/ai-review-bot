import { createHash } from "node:crypto";
import { runAuditPass } from "../../audit.js";
import { resolveAnthropicAuth, resolveOpenAIAuth } from "../../auth.js";
import { computeCost } from "../../models.js";
import { TIER1_SKILLS } from "../../review.js";
import { REVIEWER_TUNING } from "../../reviewer-tuning.js";
import { CLAUDE_TIER_MAP, OPENAI_TIER_MAP, routeModel } from "../../router.js";
import { routerContext, toLiveReviewOutput } from "../live-wiring.js";
import type { ReviewStrategy, StrategyInput } from "../strategy.js";
import { postFilterTrace } from "../trace.js";

const AGENTS_PER_REVIEW = 5;
const CHARS_PER_TOKEN = 4;
const EXPECTED_COMPLETION_TOKENS = 2000;

const VERSION = createHash("sha256")
	.update(
		JSON.stringify([
			[...TIER1_SKILLS].sort(),
			CLAUDE_TIER_MAP,
			OPENAI_TIER_MAP,
		]),
	)
	.digest("hex")
	.slice(0, 12);

const selectionFor = (input: StrategyInput) =>
	routeModel(routerContext(input.files), input.fixture.provider);

export const strategyA: ReviewStrategy = {
	name: "a",
	version: VERSION,
	needsCheckout: false,
	estimateCost(input) {
		return computeCost(
			{
				promptTokens: (input.diff.length / CHARS_PER_TOKEN) * AGENTS_PER_REVIEW,
				completionTokens: EXPECTED_COMPLETION_TOKENS * AGENTS_PER_REVIEW,
			},
			selectionFor(input).model,
		);
	},
	async run(input) {
		const started = Date.now();
		const { fixture } = input;
		const auth =
			fixture.provider === "anthropic"
				? await resolveAnthropicAuth()
				: await resolveOpenAIAuth();
		const result = await runAuditPass({
			files: [{ path: "replay.diff", content: input.diff }],
			selection: selectionFor(input),
			extraInstructions: "",
			meta: { owner: fixture.owner, repo: fixture.repo, ref: "replay" },
			auth,
		});
		if (result.agentsAttempted > 0 && result.agentsSucceeded === 0)
			throw new Error(`all ${result.agentsAttempted} review agents failed`);
		const { posted } = postFilterTrace({
			agentReviews: result.agentReviews,
			ledger: input.history.ledger,
			files: input.files,
			tuning: REVIEWER_TUNING,
		});
		return {
			...toLiveReviewOutput(result),
			posted,
			toolCalls: [],
			wallMs: Date.now() - started,
		};
	},
};
