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
	/** Reasoning depth, applied per provider in review.ts:
	 *  - OpenAI → `reasoningEffort` (none | low | medium | high | xhigh)
	 *  - Anthropic → `effort` (low | medium | high | xhigh | max)
	 *  Undefined means the provider default (e.g. Haiku, which has no effort knob). */
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
	trivial: { model: "claude-haiku-4-5" }, // Haiku has no effort control
	normal: { model: "claude-sonnet-4-6", effort: "medium" },
	complex: { model: "claude-sonnet-4-6", effort: "high" },
	deep: { model: "claude-opus-4-8", effort: "xhigh" },
};

// API-key backend (hosted webhook bots, `ai-review audit`, and any caller with
// no auth context). This is the model known to already be working in
// production; the gpt-5.1 rejection below was confirmed only against the
// ChatGPT/Codex-account subscription backend, not this one, so it must not
// regress a path that was never shown to be broken.
const OPENAI_TIER_MAP_API_KEY: Record<
	ReviewTier,
	Pick<ModelSelection, "model" | "effort">
> = {
	trivial: { model: "gpt-5.1", effort: "none" },
	normal: { model: "gpt-5.1", effort: "low" },
	complex: { model: "gpt-5.1", effort: "high" },
	// gpt-5.5 caps reasoning at "high"; "xhigh" is unverified on the OpenAI API,
	// so deep stays at "high" until support is confirmed.
	deep: { model: "gpt-5.5", effort: "high" },
};

// OAuth/subscription backend (`ai-review watch`, local CLI usage under a
// logged-in codex session). gpt-5.1 retired from the ChatGPT/Codex-account
// backend (confirmed live: "not supported when using Codex with a ChatGPT
// account") — moved to gpt-5.4, the next tier down from gpt-5.5 that's still
// served. This is scoped to OAuth only: the rejection was never confirmed
// against the raw API-key backend.
const OPENAI_TIER_MAP_OAUTH: Record<
	ReviewTier,
	Pick<ModelSelection, "model" | "effort">
> = {
	trivial: { model: "gpt-5.4", effort: "none" },
	normal: { model: "gpt-5.4", effort: "low" },
	complex: { model: "gpt-5.4", effort: "high" },
	// gpt-5.5 caps reasoning at "high"; "xhigh" is unverified on the OpenAI API,
	// so deep stays at "high" until support is confirmed. The model bump
	// (gpt-5.4 → gpt-5.5) is what distinguishes deep from complex here.
	deep: { model: "gpt-5.5", effort: "high" },
};

export function routeModel(
	context: RouterContext,
	provider: "anthropic" | "openai",
	authMode?: "api-key" | "oauth",
): ModelSelection {
	const tier = classifyTier(context);

	if (provider === "anthropic") {
		return { provider, ...CLAUDE_TIER_MAP[tier] };
	}

	const map =
		authMode === "oauth" ? OPENAI_TIER_MAP_OAUTH : OPENAI_TIER_MAP_API_KEY;
	return { provider, ...map[tier] };
}
