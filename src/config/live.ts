export const LIVE_PATTERNS: readonly string[] = [
	"review.enabled",
	"review.delaySeconds",
	"review.resyncDelaySeconds",
	"review.agentConcurrency",
	"review.agentBudgetSeconds",
	"review.diffBudgetChars",
	"review.tier2Enabled",
	"reviewers.*.enabled",
	"reviewers.*.concurrency",
	"roles.verifier.enabled",
];

const SPLIT_PATTERNS = LIVE_PATTERNS.map((p) => p.split("."));

export function isLivePath(path: readonly string[]): boolean {
	return SPLIT_PATTERNS.some(
		(pattern) =>
			pattern.length === path.length &&
			pattern.every((seg, i) => seg === "*" || seg === path[i]),
	);
}
