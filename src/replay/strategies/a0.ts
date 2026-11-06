import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAnthropicAuth, resolveOpenAIAuth } from "../../auth.js";
import { mapWithConcurrency } from "../../concurrency.js";
import { parseAgentConcurrency } from "../../config.js";
import { computeCost } from "../../models.js";
import { buildAuditUserMessage } from "../../prompt.js";
import {
	type AgentOutcome,
	mergeReviewsDetailed,
	runAgent,
} from "../../review.js";
import { CLAUDE_TIER_MAP, OPENAI_TIER_MAP, routeModel } from "../../router.js";
import { roundCostUsd } from "../cost.js";
import { routerContext, toLiveFindings } from "../live-wiring.js";
import type { ReviewStrategy, StrategyInput } from "../strategy.js";
import type { RoundUsage } from "../types.js";
import { CHARS_PER_TOKEN, EXPECTED_COMPLETION_TOKENS } from "./a.js";
import {
	DEFAULT_TOLERANCE,
	repeatsForBudget,
	withinTolerance,
} from "./a0-repeats.js";

type OkOutcome = Extract<AgentOutcome, { status: "ok" }>;
const isOk = (o: AgentOutcome): o is OkOutcome => o.status === "ok";

const A0_SKILL = "a0-single-reviewer.md";
const MAX_REPEATS = 10;

const skillsDir = fileURLToPath(new URL("../../../skills", import.meta.url));
const readSkillFile = (name: string): string =>
	readFileSync(`${skillsDir}/${name}`, "utf8");

export function strategyA0Version(readSkill: (name: string) => string): string {
	return createHash("sha256")
		.update(
			JSON.stringify([readSkill(A0_SKILL), CLAUDE_TIER_MAP, OPENAI_TIER_MAP]),
		)
		.digest("hex")
		.slice(0, 12);
}

let cachedVersion: string | undefined;

const selectionFor = (input: StrategyInput) =>
	routeModel(routerContext(input.files), input.fixture.provider);

const oneRunEstimate = (input: StrategyInput): number =>
	computeCost(
		{
			promptTokens: input.diff.length / CHARS_PER_TOKEN,
			completionTokens: EXPECTED_COMPLETION_TOKENS,
		},
		selectionFor(input).model,
	);

export const strategyA0: ReviewStrategy = {
	name: "a0",
	get version() {
		cachedVersion ??= strategyA0Version(readSkillFile);
		return cachedVersion;
	},
	needsCheckout: false,
	estimateCost(input) {
		const perRunUsd = oneRunEstimate(input);
		return (
			perRunUsd *
			repeatsForBudget({
				targetUsd: input.budget.maxUsd,
				perRunUsd,
				tolerance: DEFAULT_TOLERANCE,
				max: MAX_REPEATS,
			})
		);
	},
	async run(input) {
		const started = Date.now();
		const { fixture } = input;
		const selection = selectionFor(input);
		const auth =
			fixture.provider === "anthropic"
				? await resolveAnthropicAuth()
				: await resolveOpenAIAuth();
		const context = buildAuditUserMessage({
			owner: fixture.owner,
			repo: fixture.repo,
			ref: "replay",
			extraInstructions: "",
			files: [{ path: "replay.diff", content: input.diff }],
		});
		const once = () => runAgent(A0_SKILL, context, selection, "", { auth });

		const first = await once();
		if (first.status !== "ok")
			throw new Error(`a0 first run failed: ${first.status}`);
		const targetUsd = input.budget.maxUsd;
		const n = repeatsForBudget({
			targetUsd,
			perRunUsd: roundCostUsd({ a0: first.usage }, selection.model),
			tolerance: DEFAULT_TOLERANCE,
			max: MAX_REPEATS,
		});
		const rest = await mapWithConcurrency(
			Array.from({ length: n - 1 }),
			parseAgentConcurrency(),
			once,
		);

		const ok = [first, ...rest].filter(isOk);
		const agentReviews = ok.map((o, i) => ({
			skill: `a0-run-${i + 1}`,
			review: o.review,
		}));
		const usage: RoundUsage = Object.fromEntries(
			ok.map((o, i) => [`a0-run-${i + 1}.md`, o.usage]),
		);
		const achievedUsd = roundCostUsd(usage, selection.model);
		const merged = mergeReviewsDetailed(agentReviews.map((a) => a.review));
		return {
			findings: toLiveFindings(merged.review),
			candidates: [],
			posted: [],
			agentReviews,
			usage,
			toolCalls: [],
			wallMs: Date.now() - started,
			spend: {
				targetUsd,
				achievedUsd,
				withinTolerance: withinTolerance(
					achievedUsd,
					targetUsd,
					DEFAULT_TOLERANCE,
				),
			},
		};
	},
};
