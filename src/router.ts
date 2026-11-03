import { getConfigTree } from "./config/load.js";
import type { Config } from "./config/schema.js";

type Effort = NonNullable<ModelSelection["effort"]>;

export type ReviewTier = "trivial" | "normal" | "complex" | "deep";

export interface RouterContext {
	additions: number;
	deletions: number;
	filePaths: string[];
	labels: string[];
}

export interface ModelSelection {
	provider: "anthropic" | "openai";
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
	return patterns.some((pattern) => lower.includes(pattern));
}

function isDocFile(path: string, extensions: readonly string[]): boolean {
	return extensions.includes(path.slice(path.lastIndexOf(".")));
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
	const resolved = resolveFinderModel(
		config,
		REVIEWER_ID_BY_PROVIDER[provider],
		classifyTier(context, config.routing),
	);
	return { provider, model: resolved.model, effort: resolved.effort };
}

/** Maps the tier's effort onto the active provider's reasoning knob:
 *  OpenAI reads `reasoningEffort`, Anthropic reads `effort`, and models whose
 *  config sets `refusalFallback` (server-side reruns on a model chosen by
 *  refusal category) also get `fallbacks: "default"`. Returns
 *  undefined when there is nothing to send, so the provider default applies.
 *  `"none"` is a valid OpenAI `reasoningEffort` value (gpt-6-luna's explicit
 *  non-reasoning mode) and is forwarded as-is; the Anthropic tiers never emit it. */
export function reasoningProviderOptions(
	selection: ModelSelection,
): Record<string, Record<string, string>> | undefined {
	if (selection.provider === "openai") {
		return selection.effort
			? { openai: { reasoningEffort: selection.effort } }
			: undefined;
	}
	const anthropic: Record<string, string> = {};
	if (selection.effort) anthropic.effort = selection.effort;
	const entry =
		getConfigTree().models[`${selection.provider}/${selection.model}`];
	if (entry?.refusalFallback) anthropic.fallbacks = "default";
	return Object.keys(anthropic).length > 0 ? { anthropic } : undefined;
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
