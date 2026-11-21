import { mapWithConcurrency } from "../../concurrency.js";
import { parseAgentConcurrency } from "../../config.js";
import { computeCost } from "../../models.js";
import { buildAuditUserMessage } from "../../prompt.js";
import {
	type AgentOutcome,
	mergeReviewsDetailed,
	runAgent,
} from "../../review.js";
import { routeReviewerModel } from "../../router.js";
import { requireCost, roundCostUsd } from "../cost.js";
import {
	resolveSelectionAuth,
	routerContext,
	toLiveFindings,
} from "../live-wiring.js";
import type {
	StrategyInput,
	StrategyResult,
	ToolCallRecord,
} from "../strategy.js";
import { fixtureReviewer, type RoundUsage } from "../types.js";
import { CHARS_PER_TOKEN, EXPECTED_COMPLETION_TOKENS } from "./a.js";
import {
	DEFAULT_TOLERANCE,
	repeatsForBudget,
	withinTolerance,
} from "./a0-repeats.js";

type OkOutcome = Extract<AgentOutcome, { status: "ok" }>;
const isOk = (o: AgentOutcome): o is OkOutcome => o.status === "ok";

const MAX_REPEATS = 10;

export interface SpendMatchedConfig {
	skill: string;
	/** Name of the strategy, used in errors and as the prefix of each run's skill and usage key (`a0-run-1`). */
	label: string;
	/** The `- Ref:` line of the cached prompt prefix; keep it distinct per strategy so prompt caches don't cross. */
	ref: string;
	/** Text passed to every run as the agent's custom prompt. */
	customPrompt?: string;
	/** Usage of work done before the loop; added to the result and counted toward the spend. */
	extraUsage?: RoundUsage;
	/** Tool calls made before the loop; their cost is spent before the target is chased. */
	extraToolCalls?: ToolCallRecord[];
}

export const selectionFor = (input: StrategyInput) =>
	routeReviewerModel(
		routerContext(input.files),
		input.asReviewer ?? fixtureReviewer(input.fixture),
	).selection;

export const oneRunEstimate = (input: StrategyInput): number | undefined =>
	computeCost(
		{
			promptTokens: input.diff.length / CHARS_PER_TOKEN,
			completionTokens: EXPECTED_COMPLETION_TOKENS,
		},
		selectionFor(input).model,
	);

export function estimateSpendMatched(input: StrategyInput): number | undefined {
	const perRunUsd = oneRunEstimate(input);
	if (perRunUsd === undefined) return undefined;
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
}

export async function runSpendMatched(
	input: StrategyInput,
	config: SpendMatchedConfig,
): Promise<StrategyResult> {
	const started = Date.now();
	const { fixture, signal } = input;
	const { maxUsd, maxWallMs } = input.budget;
	const target = input.spendTargetUsd;
	const extraToolCalls = config.extraToolCalls ?? [];
	const extraUsd = extraToolCalls.reduce((sum, t) => sum + t.costUsd, 0);
	const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
	const selection = selectionFor(input);
	const auth = await resolveSelectionAuth(selection.provider);
	const context = buildAuditUserMessage({
		owner: fixture.owner,
		repo: fixture.repo,
		ref: config.ref,
		extraInstructions: "",
		files: [{ path: "replay.diff", content: input.diff }],
	});
	const once = () =>
		runAgent(config.skill, context, selection, config.customPrompt ?? "", {
			auth,
			abortSignal: signal,
		});
	const costOf = (o: AgentOutcome): number =>
		"usage" in o && o.usage
			? requireCost(
					roundCostUsd({ [config.label]: o.usage }, selection.model),
					selection.model,
				)
			: 0;
	const mayLaunch = () => !signal.aborted && Date.now() - started < maxWallMs;

	const first = await once();
	if (first.status !== "ok")
		throw new Error(`${config.label} first run failed: ${first.status}`);
	const attempts: AgentOutcome[] = [first];
	const coldUsd = costOf(first);
	let spent = coldUsd + extraUsd;

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
	const loopUsage: RoundUsage = {};
	const agentReviews: { skill: string; review: OkOutcome["review"] }[] = [];
	let failedAttempts = 0;
	for (const [i, o] of attempts.entries()) {
		const skill = `${config.label}-run-${i + 1}`;
		if (isOk(o)) agentReviews.push({ skill, review: o.review });
		else failedAttempts++;
		if ("usage" in o && o.usage) loopUsage[`${skill}.md`] = o.usage;
	}
	Object.assign(usage, loopUsage, config.extraUsage);
	const achievedUsd =
		requireCost(roundCostUsd(loopUsage, selection.model), selection.model) +
		extraUsd;
	const merged = mergeReviewsDetailed(agentReviews.map((a) => a.review));
	return {
		findings: toLiveFindings(merged.review),
		candidates: [],
		posted: [],
		agentReviews,
		usage,
		toolCalls: extraToolCalls,
		wallMs: Date.now() - started,
		spend: {
			targetUsd: target ?? null,
			achievedUsd,
			withinTolerance:
				target !== undefined && withinTolerance(achievedUsd, target, tolerance),
			failedAttempts,
		},
	};
}
