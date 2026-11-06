export const TIER1_SKILL_FILES: readonly string[] = [
	"code-reviewer.md",
	"silent-failure-hunter.md",
	"pr-test-analyzer.md",
	"security-sast.md",
	"code-review-and-quality.md",
];

export const TIER2_SKILL_FILES: readonly string[] = [
	"type-design-analyzer.md",
	"comment-analyzer.md",
	"security-auditor.md",
	"architect-review.md",
];

export const SKILL_NAMES: ReadonlySet<string> = new Set(
	[...TIER1_SKILL_FILES, ...TIER2_SKILL_FILES].map((f) =>
		f.replace(/\.md$/, ""),
	),
);
