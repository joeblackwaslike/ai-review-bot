import type { JSONObject } from "@ai-sdk/provider";
import { getConfigTree } from "./config/load.js";
import type { Config } from "./config/schema.js";
import {
	anthropicOptions,
	googleOptions,
	mergeProviderOptions,
	openaiOptions,
	type ProviderOptions,
} from "./providers/effort.js";
import type { ProviderName } from "./providers/names.js";

type Effort = NonNullable<ModelSelection["effort"]>;

export type ReviewTier = "trivial" | "normal" | "complex" | "deep";

export interface RouterContext {
	additions: number;
	deletions: number;
	filePaths: string[];
	labels: string[];
}

export interface ModelSelection {
	provider: ProviderName;
	model: string;
	/** Reasoning depth, applied per provider by reasoningProviderOptions below:
	 *  - OpenAI → `reasoningEffort` (none | low | medium | high | xhigh)
	 *  - Anthropic → `effort` (low | medium | high | xhigh | max)
	 *  Undefined means the provider default — which still thinks on every current
	 *  Claude model, so the tier maps always set it explicitly. */
	effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
}

function isSensitivePath(path: string, patterns: readonly string[]): boolean {
	const lower = path.toLowerCase();
	return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

function isDocFile(path: string, extensions: readonly string[]): boolean {
	return extensions.includes(path.slice(path.lastIndexOf(".")));
}

export function cheapSelection(base: ModelSelection): ModelSelection {
	if (base.provider === "openai")
		return { provider: "openai", model: "gpt-6-luna", effort: "low" };
	if (base.provider === "anthropic")
		return { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" };
	return { provider: base.provider, model: base.model, effort: "low" };
}

export function classifyTier(
	context: RouterContext,
	routing: Config["routing"] = getConfigTree().routing,
): ReviewTier {
	const { additions, deletions, filePaths, labels } = context;

	if (labels.includes(routing.deepLabel)) {
		return "deep";
	}

	if (
		filePaths.some((p) => isSensitivePath(p, routing.sensitivePathPatterns))
	) {
		return "complex";
	}

	const totalLines = additions + deletions;
	if (totalLines > routing.complexLines) {
		return "complex";
	}

	if (
		totalLines < routing.trivialDocLines &&
		filePaths.every((p) => isDocFile(p, routing.docExtensions))
	) {
		return "trivial";
	}

	return "normal";
}

export function resolveFinderModel(
	config: Config,
	reviewerId: string,
	tier: ReviewTier,
): { provider: string; model: string; effort?: Effort } {
	const reviewer = config.reviewers[reviewerId];
	if (!reviewer) throw new Error(`unknown reviewer "${reviewerId}"`);
	const choice = reviewer.tiers[tier];
	if (!choice)
		throw new Error(
			`reviewer "${reviewerId}" has no model configured for tier "${tier}"`,
		);
	const slash = choice.model.indexOf("/");
	if (slash <= 0) {
		throw new Error(
			`reviewer "${reviewerId}" tier "${tier}" model "${choice.model}" must be in "provider/model" form`,
		);
	}
	return {
		provider: choice.model.slice(0, slash),
		model: choice.model.slice(slash + 1),
		...(choice.effort ? { effort: choice.effort } : {}),
	};
}

const REVIEWER_ID_BY_PROVIDER = {
	anthropic: "claude",
	openai: "codex",
} as const;

export function routeModel(
	context: RouterContext,
	provider: "anthropic" | "openai",
): ModelSelection {
	const config = getConfigTree();
	const reviewerId = REVIEWER_ID_BY_PROVIDER[provider];
	const tier = classifyTier(context, config.routing);
	const resolved = resolveFinderModel(config, reviewerId, tier);
	if (resolved.provider !== provider) {
		throw new Error(
			`reviewer "${reviewerId}" tier "${tier}" model "${resolved.provider}/${resolved.model}" must use provider "${provider}"`,
		);
	}
	return { provider, model: resolved.model, effort: resolved.effort };
}

/** Maps the tier's effort onto the active provider's reasoning knob through
 *  the per-provider translators, then merges the model entry's
 *  `providerOptions` over the result. Returns undefined when there is nothing
 *  to send, so the provider default applies. */
export function reasoningProviderOptions(
	selection: ModelSelection,
): ProviderOptions | undefined {
	const entry =
		getConfigTree().models[`${selection.provider}/${selection.model}`];
	let computed: JSONObject | undefined;
	if (selection.provider === "openai") {
		computed = openaiOptions(selection.effort);
	} else if (selection.provider === "google") {
		computed = googleOptions(selection.effort, entry?.effortControl);
	} else {
		computed = anthropicOptions(
			selection.effort,
			entry?.refusalFallback ?? false,
		);
	}
	return mergeProviderOptions(
		computed ? { [selection.provider]: computed } : undefined,
		entry?.providerOptions,
	);
}

/** Output-token budget for a generateObject call. Reasoning/thinking tokens are
 * billed against this budget, so once a reasoning level is engaged the cap must
 * cover reasoning + the structured object — too small and the model returns no
 * object at all (AI_NoObjectGeneratedError). Only an explicit `"none"` (OpenAI's
 * non-reasoning mode) keeps the base cap: an unset effort still thinks on every
 * current Claude model. You pay for actual tokens, not the cap. */
export function outputBudget(selection: ModelSelection, base: number): number {
	return selection.effort === "none" ? base : Math.max(base * 8, 16000);
}
