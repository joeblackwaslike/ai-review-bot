import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildReview,
	buildReviewComments,
	collectRightSideLines,
} from "./review.js";
import {
	buildAnthropicToolUseResponse,
	buildInlineComment,
	buildModelReview,
	buildPullFile,
	reviewedCommitMarker,
	reviewsResponse,
	SIMPLE_PATCH,
	TWO_HUNK_PATCH,
} from "./testing.js";

const mockCreate = vi.fn();

vi.mock("./config.js", () => ({
	getConfig: () => ({
		appId: "1",
		privateKey: "pem",
		webhookSecret: "secret",
		reviewEnabled: true,
		reviewCommentPrefix: "claude-review-bot",
		reviewCommand: "/claude-review",
		anthropicModel: "claude-sonnet-4-6",
	}),
}));

vi.mock("./anthropic.js", () => ({
	getAnthropicClient: () => ({
		messages: {
			create: mockCreate,
		},
	}),
}));

vi.mock("./prompt.js", () => ({
	buildUserMessage: () => "user",
	buildAgentSystemPrompt: () => "system",
}));

// ---------------------------------------------------------------------------
// collectRightSideLines
// ---------------------------------------------------------------------------

describe("collectRightSideLines", () => {
	it("tracks right-side added and context lines from a patch", () => {
		const lines = collectRightSideLines(
			["@@ -10,2 +10,3 @@", " context", "+added", "-removed", " context2"].join(
				"\n",
			),
		);

		expect(Array.from(lines)).toEqual([10, 11, 12]);
	});

	it("handles multiple hunks", () => {
		const lines = collectRightSideLines(TWO_HUNK_PATCH);
		// First hunk: lines 1, 2, 3; second hunk: 9, 10, 11, 12
		expect(Array.from(lines).sort((a, b) => a - b)).toEqual([
			1, 2, 3, 9, 10, 11, 12,
		]);
	});

	it("never includes line 0", () => {
		const lines = collectRightSideLines(SIMPLE_PATCH);
		expect(lines.has(0)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildReviewComments — filtering logic
// ---------------------------------------------------------------------------

describe("buildReviewComments", () => {
	const files = [buildPullFile("src/file.ts", SIMPLE_PATCH)];

	it("keeps a single-line comment with start_line: null", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 2, start_line: null }),
		]);

		expect(comments).toHaveLength(1);
		expect(comments[0]).toMatchObject({
			path: "src/file.ts",
			line: 2,
			side: "RIGHT",
		});
		expect(comments[0].start_line).toBeUndefined();
	});

	it("drops comment when path is not in the diff", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ path: "src/other.ts", line: 2 }),
		]);

		expect(comments).toHaveLength(0);
	});

	it("drops comment when line is not in the right-side valid set", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 99 }),
		]);

		expect(comments).toHaveLength(0);
	});

	it("drops comment with backwards range (start_line >= line)", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 2, start_line: 3 }),
		]);

		expect(comments).toHaveLength(0);
	});

	it("drops comment with start_line equal to line (degenerate range)", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 2, start_line: 2 }),
		]);

		expect(comments).toHaveLength(0);
	});

	// Regression: model may return start_line: 0 instead of null when told to
	// "omit" the field but the schema requires it. Line 0 is never in any diff.
	it("regression: drops comment when model returns start_line: 0 instead of null", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 2, start_line: 0 }),
		]);

		expect(comments).toHaveLength(0);
	});

	it("keeps a valid multi-line comment (start_line < line, both in diff)", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 3, start_line: 1 }),
		]);

		expect(comments).toHaveLength(1);
		expect(comments[0]).toMatchObject({
			path: "src/file.ts",
			line: 3,
			side: "RIGHT",
			start_line: 1,
			start_side: "RIGHT",
		});
	});

	it("drops multi-line comment when start_line is not in the valid set", () => {
		const comments = buildReviewComments(files, [
			// Line 50 is not in the diff, so the range is invalid
			buildInlineComment({ line: 3, start_line: 50 }),
		]);

		expect(comments).toHaveLength(0);
	});

	it("keeps only comments with valid right-side anchors from a mixed set", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ title: "Valid", line: 2, start_line: null }),
			buildInlineComment({
				title: "Wrong path",
				path: "src/other.ts",
				line: 2,
			}),
			buildInlineComment({ title: "Wrong line", line: 99 }),
			buildInlineComment({
				title: "Backwards range",
				line: 2,
				start_line: 3,
			}),
		]);

		expect(comments).toHaveLength(1);
		expect(comments[0]).toMatchObject({ path: "src/file.ts", line: 2 });
	});

	it("returns empty array when no files have patches", () => {
		const comments = buildReviewComments(
			[{ filename: "src/file.ts", status: "renamed" }],
			[buildInlineComment({ line: 2 })],
		);

		expect(comments).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// buildReview — integration
// ---------------------------------------------------------------------------

describe("buildReview", () => {
	beforeEach(() => {
		mockCreate.mockReset();
	});

	function buildOctokit(overrides?: {
		existingReviews?: Array<{ body: string }>;
		files?: Array<{ filename: string; status: string; patch?: string }>;
	}) {
		return {
			request: vi
				.fn()
				.mockResolvedValue(reviewsResponse(overrides?.existingReviews)),
			paginate: vi
				.fn()
				.mockResolvedValue(
					overrides?.files ?? [buildPullFile("src/review.ts", SIMPLE_PATCH)],
				),
		};
	}

	const baseContext = {
		owner: "joeblackwaslike",
		repo: "claude-review-bot",
		pullNumber: 1,
		headSha: "1234567890abcdef",
		title: "Test PR",
		body: "Example",
		additions: 1,
		deletions: 0,
		changedFiles: 1,
		commentPrefix: "claude-review-bot",
		extraInstructions: "",
		force: false,
	};

	it("converts model output into a review with validated inline comments", async () => {
		mockCreate.mockResolvedValue(
			buildAnthropicToolUseResponse(
				buildModelReview({
					summary: "Two issues found.",
					event: "REQUEST_CHANGES",
					general_findings: [
						{
							title: "Missing test coverage",
							body: "This behavior change should be covered by a regression test.",
						},
					],
					inline_comments: [
						buildInlineComment({
							title: "Bad anchor",
							body: "Should be dropped.",
							path: "src/review.ts",
							line: 99,
						}),
						buildInlineComment({
							title: "Valid anchor",
							body: "This is correctly anchored.",
							path: "src/review.ts",
							line: 2,
						}),
					],
				}),
			),
		);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review).not.toBeNull();
		expect(review?.event).toBe("REQUEST_CHANGES");
		expect(review?.comments).toHaveLength(1);
		expect(review?.comments[0]).toMatchObject({
			path: "src/review.ts",
			line: 2,
		});
		expect(review?.body).toContain("Missing test coverage");
		expect(review?.body).toContain("Inline comments: 1");
	});

	// Regression: when ALL inline comments are dropped (e.g. model returned
	// start_line: 0 instead of null), the review should still post body-only.
	it("regression: posts body-only when all inline comments are filtered out", async () => {
		mockCreate.mockResolvedValue(
			buildAnthropicToolUseResponse(
				buildModelReview({
					summary: "Found issues.",
					event: "REQUEST_CHANGES",
					general_findings: [{ title: "Security risk", body: "Details here." }],
					inline_comments: [
						// start_line: 0 — the specific model bug, should be dropped
						buildInlineComment({
							path: "src/review.ts",
							line: 2,
							start_line: 0,
						}),
						// Wrong path — should be dropped
						buildInlineComment({
							path: "does/not/exist.ts",
							line: 2,
							start_line: null,
						}),
					],
				}),
			),
		);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review).not.toBeNull();
		expect(review?.comments).toHaveLength(0);
		expect(review?.body).toContain("Inline comments: none");
		expect(review?.body).toContain("Security risk");
	});

	it("skips duplicate reviews on the same commit unless forced", async () => {
		const headSha = "1234567890abcdef";
		const octokit = buildOctokit({
			existingReviews: [{ body: reviewedCommitMarker(headSha) }],
		});

		const review = await buildReview({
			octokit,
			...baseContext,
			headSha,
			force: false,
		});

		expect(review).toBeNull();
		expect(octokit.paginate).not.toHaveBeenCalled();
	});

	it("resubmits when force is true even if already reviewed", async () => {
		const headSha = "1234567890abcdef";

		mockCreate.mockResolvedValue(
			buildAnthropicToolUseResponse(
				buildModelReview({ summary: "Re-review." }),
			),
		);

		const octokit = buildOctokit({
			existingReviews: [{ body: reviewedCommitMarker(headSha) }],
		});

		const review = await buildReview({
			octokit,
			...baseContext,
			headSha,
			force: true,
		});

		expect(review).not.toBeNull();
		expect(octokit.paginate).toHaveBeenCalled();
	});
});
