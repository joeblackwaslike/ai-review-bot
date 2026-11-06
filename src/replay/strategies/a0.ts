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
		const target = input.spendTargetUsd;
		const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
		if (target === undefined) return perRunUsd;
		const byCap = Math.max(1, Math.floor(input.budget.maxUsd / perRunUsd));
		const meetsTarget =
			target <= perRunUsd || withinTolerance(perRunUsd, target, tolerance);
		const repeats = meetsTarget
			? 1
			: Math.max(
					2,
					repeatsForBudget({
						targetUsd: target,
						perRunUsd,
						tolerance,
						max: MAX_REPEATS,
					}),
				);
		return perRunUsd * Math.min(byCap, repeats);
	},
	async run(input) {
		const started = Date.now();
		const { fixture, signal } = input;
		const { maxUsd, maxWallMs } = input.budget;
		const target = input.spendTargetUsd;
		const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
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
		const once = () =>
			runAgent(A0_SKILL, context, selection, "", { auth, abortSignal: signal });
		const costOf = (o: AgentOutcome): number =>
			"usage" in o && o.usage
				? roundCostUsd({ a0: o.usage }, selection.model)
				: 0;
		const mayLaunch = () => !signal.aborted && Date.now() - started < maxWallMs;

		const first = await once();
		if (first.status !== "ok")
			throw new Error(`a0 first run failed: ${first.status}`);
		const attempts: AgentOutcome[] = [first];
		let spent = costOf(first);
		const coldUsd = spent;

		if (
			target !== undefined &&
			target > spent &&
			!withinTolerance(spent, target, tolerance) &&
			spent + coldUsd <= maxUsd &&
			mayLaunch()
		) {
			const second = await once();
			attempts.push(second);
			spent += costOf(second);
			const warmUsd = costOf(second);
			if (warmUsd > 0) {
				const wanted = Math.max(0, Math.round((target - spent) / warmUsd));
				const room = Math.floor((maxUsd - spent) / warmUsd);
				const extra = Math.max(
					0,
					Math.min(wanted, room, MAX_REPEATS - attempts.length),
				);
				let committed = spent;
				const rest = await mapWithConcurrency(
					Array.from({ length: extra }),
					parseAgentConcurrency(),
					async () => {
						if (!mayLaunch() || committed + warmUsd > maxUsd) return null;
						committed += warmUsd;
						const o = await once();
						committed += costOf(o) - warmUsd;
						return o;
					},
				);
				for (const o of rest) if (o) attempts.push(o);
			}
		}

		const usage: RoundUsage = {};
		const agentReviews: { skill: string; review: OkOutcome["review"] }[] = [];
		let failedAttempts = 0;
		for (const [i, o] of attempts.entries()) {
			const skill = `a0-run-${i + 1}`;
			if (isOk(o)) agentReviews.push({ skill, review: o.review });
			else failedAttempts++;
			if ("usage" in o && o.usage) usage[`${skill}.md`] = o.usage;
		}
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
				targetUsd: target ?? null,
				achievedUsd,
				withinTolerance:
					target !== undefined &&
					withinTolerance(achievedUsd, target, tolerance),
				failedAttempts,
			},
		};
	},
};
