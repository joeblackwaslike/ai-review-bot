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
import { isProviderName, type ProviderName } from "./providers/names.js";
import type { LegacyProvider, ReviewerId } from "./reviewer-id.js";

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

const PROSE_EXTENSIONS = new Set([".md", ".mdx", ".rst"]);

function extensionOf(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function isDocFile(path: string, extensions: readonly string[]): boolean {
	const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	if (/^(requirements|constraints)[^/]*\.txt$/.test(base)) {
		return false;
	}
	return extensions.some((ext) => ext.toLowerCase() === extensionOf(path));
}

function isTrivialDoc(path: string, routing: Config["routing"]): boolean {
	if (!isDocFile(path, routing.docExtensions)) {
		return false;
	}
	return (
		PROSE_EXTENSIONS.has(extensionOf(path)) ||
		!isSensitivePath(path, routing.sensitivePathPatterns)
	);
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

	const totalLines = additions + deletions;
	if (
		totalLines < routing.trivialDocLines &&
		filePaths.every((p) => isTrivialDoc(p, routing))
	) {
		return "trivial";
	}

	if (
		filePaths.some((p) => isSensitivePath(p, routing.sensitivePathPatterns))
	) {
		return "complex";
	}

	if (totalLines > routing.complexLines) {
		return "complex";
	}

	return "normal";
}

function splitChoice(
	reviewerId: string,
	where: string,
	choice: { model: string; effort?: Effort },
): { provider: ProviderName; model: string; effort?: Effort } {
	const slash = choice.model.indexOf("/");
	const provider = choice.model.slice(0, slash);
	if (slash <= 0 || !isProviderName(provider)) {
		throw new Error(
			`reviewer "${reviewerId}" ${where} model "${choice.model}" must be in "provider/model" form`,
		);
	}
	return {
		provider,
		model: choice.model.slice(slash + 1),
		...(choice.effort ? { effort: choice.effort } : {}),
	};
}

const TIER_ORDER: readonly ReviewTier[] = [
	"trivial",
	"normal",
	"complex",
	"deep",
];

export function legacyTierMap(
	reviewerId: string,
	config: Config = getConfigTree(),
): Record<ReviewTier, Pick<ModelSelection, "model" | "effort">> | undefined {
	const reviewer = config.reviewers[reviewerId];
	if (!reviewer) return undefined;
	const entries = TIER_ORDER.flatMap((tier) => {
		const choice = reviewer.tiers[tier];
		if (!choice) return [];
		const { model, effort } = splitChoice(reviewerId, `tier "${tier}"`, choice);
		return [[tier, { model, effort }] as const];
	});
	return Object.fromEntries(entries) as Record<
		ReviewTier,
		Pick<ModelSelection, "model" | "effort">
	>;
}

function requireReviewer(config: Config, reviewerId: string) {
	const reviewer = config.reviewers[reviewerId];
	if (!reviewer) throw new Error(`unknown reviewer "${reviewerId}"`);
	return reviewer;
}

export function resolveSkillModel(
	config: Config,
	reviewerId: string,
	skill: string,
	tier: ReviewTier,
): { provider: ProviderName; model: string; effort?: Effort } {
	const reviewer = requireReviewer(config, reviewerId);
	const override = reviewer.skills?.[skill];
	const choice =
		override?.[tier] ??
		(override?.model
			? { model: override.model, effort: override.effort }
			: undefined) ??
		reviewer.tiers[tier];
	if (!choice)
		throw new Error(
			`reviewer "${reviewerId}" has no model configured for tier "${tier}"`,
		);
	return splitChoice(reviewerId, `tier "${tier}"`, choice);
}

export function resolveFinderModel(
	config: Config,
	reviewerId: string,
	tier: ReviewTier,
): { provider: ProviderName; model: string; effort?: Effort } {
	const reviewer = requireReviewer(config, reviewerId);
	const choice = reviewer.tiers[tier];
	if (!choice)
		throw new Error(
			`reviewer "${reviewerId}" has no model configured for tier "${tier}"`,
		);
	return splitChoice(reviewerId, `tier "${tier}"`, choice);
}

export function shouldRunOnTier(
	config: Config,
	reviewerId: string,
	tier: ReviewTier,
	repoRunOn?: readonly ReviewTier[],
): boolean {
	const { runOn } = requireReviewer(config, reviewerId);
	if (repoRunOn && !repoRunOn.includes(tier)) return false;
	return runOn === undefined || runOn.includes(tier);
}

export function routeReviewerModel(
	context: RouterContext,
	reviewerId: ReviewerId,
	routing: Config["routing"] = getConfigTree().routing,
): { selection: ModelSelection; tier: ReviewTier } {
	const config = getConfigTree();
	const tier = classifyTier(context, routing);
	const { provider, model, effort } = resolveFinderModel(
		config,
		reviewerId,
		tier,
	);
	return { selection: { provider, model, effort }, tier };
}

const REVIEWER_ID_BY_PROVIDER = {
	anthropic: "claude",
	openai: "codex",
} as const;

export function routeModel(
	context: RouterContext,
	provider: LegacyProvider,
): ModelSelection {
	const reviewerId = REVIEWER_ID_BY_PROVIDER[provider];
	const { selection, tier } = routeReviewerModel(context, reviewerId);
	if (selection.provider !== provider) {
		throw new Error(
			`reviewer "${reviewerId}" tier "${tier}" model "${selection.provider}/${selection.model}" must use provider "${provider}"`,
		);
	}
	return selection;
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
