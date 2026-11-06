import { computeCost } from "../models.js";
import type { RoundUsage } from "./types.js";

export function roundCostUsd(
	usage: RoundUsage,
	model: string,
): number | undefined {
	let total = 0;
	for (const u of Object.values(usage)) {
		const cost = computeCost(u, model);
		if (cost === undefined) return undefined;
		total += cost;
	}
	return total;
}

export function usageSummary(usage: RoundUsage): {
	promptTokens: number;
	cachedInputTokens: number;
	completionTokens: number;
	reasoningTokens: number;
} {
	const total = {
		promptTokens: 0,
		cachedInputTokens: 0,
		completionTokens: 0,
		reasoningTokens: 0,
	};
	for (const u of Object.values(usage)) {
		total.promptTokens += u.promptTokens;
		total.cachedInputTokens += u.cachedInputTokens ?? 0;
		total.completionTokens += u.completionTokens;
		total.reasoningTokens += u.reasoningTokens ?? 0;
	}
	return total;
}

export function requireCost(cost: number | undefined, what: string): number {
	if (cost === undefined) {
		throw new Error(
			`no price known for ${what}, so spend caps cannot be enforced. Pin models.<provider/model>.pricing in .ai-review.yaml or check network access to openrouter.ai.`,
		);
	}
	return cost;
}
