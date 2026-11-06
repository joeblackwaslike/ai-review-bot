import { computeCost } from "../models.js";
import type { RoundUsage } from "./types.js";

export function roundCostUsd(usage: RoundUsage, model: string): number {
	return Object.values(usage).reduce(
		(sum, u) => sum + computeCost(u, model),
		0,
	);
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
