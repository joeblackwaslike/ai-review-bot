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

const SENSITIVE_PATH_PATTERNS = [
	"auth",
	"crypto",
	"jwt",
	"password",
	"secret",
	"/db/",
	"database",
	"migration",
	"schema",
];

const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst", ".mdx"]);

function isSensitivePath(path: string): boolean {
	const lower = path.toLowerCase();
	return SENSITIVE_PATH_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isDocFile(path: string): boolean {
	const ext = path.slice(path.lastIndexOf("."));
	return DOC_EXTENSIONS.has(ext);
}

export function classifyTier(context: RouterContext): ReviewTier {
	const { additions, deletions, filePaths, labels } = context;

	if (labels.includes("deep-review")) {
		return "deep";
	}

	if (filePaths.some(isSensitivePath)) {
		return "complex";
	}

	if (additions + deletions > 500) {
		return "complex";
	}

	const totalLines = additions + deletions;
	if (totalLines < 20 && filePaths.every(isDocFile)) {
		return "trivial";
	}

	return "normal";
}

const CLAUDE_TIER_MAP: Record<
	ReviewTier,
	Pick<ModelSelection, "model" | "effort">
> = {
	trivial: { model: "claude-haiku-5-5", effort: "low" },
	normal: { model: "claude-sonnet-5-5", effort: "medium" },
	complex: { model: "claude-sonnet-5-5", effort: "high" },
	deep: { model: "claude-opus-5-5", effort: "xhigh" },
};

// GPT-6.1 Sol ($2/$10) undercuts the old GPT-5.6 Terra and Sol tiers, so it
// covers normal through deep, separated by effort alone. GPT-6 Astra
// ($10/$50) is deliberately unused. Luna is the only GPT-6 tier that accepts
// effort "none". All IDs verified live on both the API-key and the
// Codex/ChatGPT-OAuth backends on 2026-10-25, so there is no auth-mode split.
const OPENAI_TIER_MAP: Record<
	ReviewTier,
	Pick<ModelSelection, "model" | "effort">
> = {
	trivial: { model: "gpt-6-luna", effort: "none" },
	normal: { model: "gpt-6.1-sol", effort: "low" },
	complex: { model: "gpt-6.1-sol", effort: "high" },
	deep: { model: "gpt-6.1-sol", effort: "xhigh" },
};

export function routeModel(
	context: RouterContext,
	provider: "anthropic" | "openai",
): ModelSelection {
	const tier = classifyTier(context);

	if (provider === "anthropic") {
		return { provider, ...CLAUDE_TIER_MAP[tier] };
	}

	return { provider, ...OPENAI_TIER_MAP[tier] };
}

/** Models whose safety classifiers can decline security-heavy diffs and that
 * support server-side refusal fallbacks (`fallbacks: "default"` reruns the
 * request on a model chosen by refusal category). Haiku 5.5 has no fallback. */
const REFUSAL_FALLBACK_MODELS = new Set([
	"claude-opus-5-5",
	"claude-sonnet-5-5",
]);

/** Maps the tier's effort onto the active provider's reasoning knob:
 *  OpenAI reads `reasoningEffort`, Anthropic reads `effort`, and Anthropic
 *  models in REFUSAL_FALLBACK_MODELS also get `fallbacks: "default"`. Returns
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
	if (REFUSAL_FALLBACK_MODELS.has(selection.model))
		anthropic.fallbacks = "default";
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
