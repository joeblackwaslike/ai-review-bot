import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { ProviderName } from "./names.js";

export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type EffortControl = "level" | "budget";
export type ProviderOptions = SharedV3ProviderOptions;

export const GOOGLE_THINKING_BUDGETS = {
	none: 0,
	low: 1024,
	medium: 8192,
	high: 24576,
} as const;

const GOOGLE_LEVELS = {
	none: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
} as const;

const SUPPORTED = {
	anthropic: ["low", "medium", "high", "xhigh", "max"],
	openai: ["none", "low", "medium", "high", "xhigh"],
	google: ["none", "low", "medium", "high"],
} as const satisfies Record<ProviderName, readonly Effort[]>;

export function supportedEfforts(
	provider: ProviderName,
	_control: EffortControl = "level",
): readonly Effort[] {
	return SUPPORTED[provider];
}

export function anthropicOptions(
	effort: Effort | undefined,
	refusalFallback: boolean,
): { effort?: string; fallbacks?: "default" } | undefined {
	const options: { effort?: string; fallbacks?: "default" } = {};
	if (effort) options.effort = effort;
	if (refusalFallback) options.fallbacks = "default";
	return Object.keys(options).length > 0 ? options : undefined;
}

export function openaiOptions(
	effort: Effort | undefined,
): { reasoningEffort: string } | undefined {
	return effort ? { reasoningEffort: effort } : undefined;
}

export function googleOptions(
	effort: Effort | undefined,
	control: EffortControl = "level",
):
	| {
			thinkingConfig: {
				thinkingLevel?: "minimal" | "low" | "medium" | "high";
				thinkingBudget?: number;
				includeThoughts: false;
			};
	  }
	| undefined {
	if (!effort) return undefined;
	if (effort === "xhigh" || effort === "max") {
		throw new Error(`google models do not support effort "${effort}"`);
	}
	const thinkingConfig =
		control === "budget"
			? {
					thinkingBudget: GOOGLE_THINKING_BUDGETS[effort],
					includeThoughts: false as const,
				}
			: {
					thinkingLevel: GOOGLE_LEVELS[effort],
					includeThoughts: false as const,
				};
	return { thinkingConfig };
}

export function mergeProviderOptions(
	base: ProviderOptions | undefined,
	extra: ProviderOptions | undefined,
): ProviderOptions | undefined {
	if (!extra) return base;
	const merged: ProviderOptions = { ...base };
	for (const [provider, options] of Object.entries(extra)) {
		merged[provider] = { ...merged[provider], ...options };
	}
	return merged;
}
