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
	normal: { model: "claude-sonnet-5", effort: "medium" },
	complex: { model: "claude-sonnet-5", effort: "high" },
	deep: { model: "claude-opus-5", effort: "xhigh" },
};

// GPT-5.6's three durable capability tiers (Sol/Terra/Luna) replace the old
// single-model-plus-effort scheme, and are used identically across both the
// API-key backend (hosted webhook bots, `ai-review audit`) and the
// OAuth/subscription backend (`ai-review watch`, local CLI under a logged-in
// codex session). Live-tested end-to-end on the OAuth backend on 2026-08-19:
// gpt-5.6-terra (normal/complex) via `ai-review review`, and gpt-5.6-sol at
// effort "xhigh" (deep) directly against createAIModel — the old tier map
// capped deep-tier effort at "high" specifically because "xhigh" was
// unverified; that caveat no longer applies. The API-key backend was down
// during this change (see PR verification section) so all three tiers are
// confirmed there via developers.openai.com/api/docs/models/gpt-5.6-{sol,terra,luna}
// only, not a live run — re-verify live once the outage clears. This
// collapses the previous api-key/oauth split, which existed only because
// gpt-5.1 was rejected on the OAuth backend specifically; gpt-5.4 (its
// replacement there) itself retires from the Codex/ChatGPT-OAuth backend on
// 2026-08-31.
const OPENAI_TIER_MAP: Record<
	ReviewTier,
	Pick<ModelSelection, "model" | "effort">
> = {
	trivial: { model: "gpt-5.6-luna", effort: "none" },
	normal: { model: "gpt-5.6-terra", effort: "low" },
	complex: { model: "gpt-5.6-terra", effort: "high" },
	deep: { model: "gpt-5.6-sol", effort: "xhigh" },
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
