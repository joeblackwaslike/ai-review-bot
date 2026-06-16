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

const OPENAI_TIER_MAP: Record<
	ReviewTier,
	Pick<ModelSelection, "model" | "effort">
> = {
	trivial: { model: "gpt-5.1", effort: "none" },
	normal: { model: "gpt-5.1", effort: "low" },
	complex: { model: "gpt-5.1", effort: "high" },
	deep: { model: "gpt-5.5", effort: "xhigh" },
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
