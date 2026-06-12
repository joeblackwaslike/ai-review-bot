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
	thinkingBudget?: number;
	reasoningEffort?: "low" | "medium" | "high";
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
	Pick<ModelSelection, "model" | "thinkingBudget">
> = {
	trivial: { model: "claude-haiku-4-5" },
	normal: { model: "claude-sonnet-4-6" },
	complex: { model: "claude-sonnet-4-6", thinkingBudget: 8000 },
	deep: { model: "claude-opus-4-7", thinkingBudget: 16000 },
};

const OPENAI_TIER_MAP: Record<
	ReviewTier,
	Pick<ModelSelection, "model" | "reasoningEffort">
> = {
	trivial: { model: "gpt-5" },
	normal: { model: "gpt-5" },
	complex: { model: "o4-mini", reasoningEffort: "medium" },
	deep: { model: "o3", reasoningEffort: "high" },
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
