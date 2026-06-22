import type { FindingInsert, RawFeedbackInsert } from "./repo.js";

/** Shared repo-write fixtures used by both the pg-mem unit test and the
 * real-Postgres integration test so the two exercise identical inputs. */
export const baseRaw: RawFeedbackInsert = {
	source: "inline_reaction",
	provider: "anthropic",
	owner: "joeblackwaslike",
	repo: "ai-review-bot",
	pr: 7,
	commentId: 111,
	reviewId: null,
	inReplyToId: null,
	path: "src/a.ts",
	line: 4,
	skills: ["code-reviewer.md"],
	title: "Null deref",
	verdict: "down",
	actor: "octocat",
	body: null,
	eventAt: new Date("2026-06-21T00:00:00Z"),
	dedupKey: "react:inline_reaction:111:octocat:down",
};

export const baseFinding: FindingInsert = {
	provider: "anthropic",
	owner: "joeblackwaslike",
	repo: "ai-review-bot",
	pr: 7,
	commentId: 111,
	reviewId: null,
	path: "src/a.ts",
	line: 4,
	skills: ["code-reviewer.md"],
	title: "Null deref",
	severity: "high",
	headSha: "abc123",
	postedAt: new Date("2026-06-21T00:00:00Z"),
	naturalKey: "anthropic:joeblackwaslike/ai-review-bot#7:src/a.ts:4:deadbeef",
};
