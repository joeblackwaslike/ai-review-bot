import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildReview,
	buildReviewComments,
	collectRightSideLines,
} from "./review.js";
import {
	buildGenerateObjectResponse,
	buildInlineComment,
	buildModelReview,
	buildPullFile,
	reviewedCommitMarker,
	reviewsResponse,
	SIMPLE_PATCH,
	TWO_HUNK_PATCH,
} from "./testing.js";

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockBuildUserMessage = vi.hoisted(() => vi.fn().mockReturnValue("user"));

vi.mock("ai", () => ({
	generateObject: mockGenerateObject,
}));

vi.mock("./models.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./models.js")>();
	return { ...actual, createAIModel: vi.fn().mockReturnValue("mocked-model") };
});

vi.mock("./config.js", () => ({
	getConfig: () => ({
		appId: "1",
		privateKey: "pem",
		webhookSecret: "secret",
		reviewEnabled: true,
		reviewCommentPrefix: "ai-review-bot",
		reviewCommand: "/ai-review",
	}),
}));

vi.mock("./prompt.js", () => ({
	buildUserMessage: mockBuildUserMessage,
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

function buildOctokit(overrides?: {
	existingReviews?: Array<{ body: string }>;
	files?: Array<{ filename: string; status: string; patch?: string }>;
	checkRuns?: Array<{
		name: string;
		status: string;
		conclusion: string | null;
	}>;
}) {
	const requestMock = vi.fn().mockImplementation((route: string) => {
		if (route.includes("/check-runs")) {
			return { data: { check_runs: overrides?.checkRuns ?? [] } };
		}
		return reviewsResponse(overrides?.existingReviews);
	});
	return {
		request: requestMock,
		paginate: vi
			.fn()
			.mockResolvedValue(
				overrides?.files ?? [buildPullFile("src/review.ts", SIMPLE_PATCH)],
			),
	};
}

const baseContext = {
	owner: "joeblackwaslike",
	repo: "ai-review-bot",
	pullNumber: 1,
	headSha: "1234567890abcdef",
	title: "Test PR",
	body: "Example",
	additions: 1,
	deletions: 0,
	changedFiles: 1,
	labels: [],
	commentPrefix: "ai-review-bot",
	extraInstructions: "",
	force: false,
	provider: "anthropic" as const,
	feedbackEnabled: false,
};

describe("buildReview", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	it("converts model output into a review with validated inline comments", async () => {
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [
					{
						title: "Missing test coverage",
						body: "This behavior change should be covered by a regression test.",
						severity: "high",
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
		);
		const summaryResponse = {
			object: { summary: "Two issues found." },
			usage: { inputTokens: 50, outputTokens: 20 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(summaryResponse);

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
		expect(review?.body).toContain("Two issues found.");
	});

	// Regression: when ALL inline comments are dropped (e.g. model returned
	// start_line: 0 instead of null), the review should still post body-only.
	it("regression: posts body-only when all inline comments are filtered out", async () => {
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [
					{ title: "Security risk", body: "Details here.", severity: "high" },
				],
				inline_comments: [
					buildInlineComment({
						path: "src/review.ts",
						line: 2,
						start_line: 0,
					}),
					buildInlineComment({
						path: "does/not/exist.ts",
						line: 2,
						start_line: null,
					}),
				],
			}),
		);
		const summaryResponse = {
			object: { summary: "Found issues." },
			usage: { inputTokens: 50, outputTokens: 20 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(summaryResponse);

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
			existingReviews: [
				{
					body: `### ai-review-bot\n\nPrior review.\n\n${reviewedCommitMarker(headSha)}`,
				},
			],
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

		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(buildModelReview()),
		);

		const octokit = buildOctokit({
			existingReviews: [
				{
					body: `### ai-review-bot\n\nPrior review.\n\n${reviewedCommitMarker(headSha)}`,
				},
			],
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

	it("renders severity emoji table for general findings", async () => {
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				general_findings: [
					{ title: "Critical bug", body: "Details.", severity: "high" },
					{ title: "Minor style nit", body: "Details.", severity: "low" },
				],
			}),
		);
		const summaryResponse = {
			object: { summary: "Found two issues." },
			usage: { inputTokens: 50, outputTokens: 20 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(summaryResponse);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review?.body).toMatch(/🔴|🟡|🟢/);
		expect(review?.body).toContain("Critical bug");
		expect(review?.body).toContain("Minor style nit");
	});

	it("emits APPROVE when all agents find no issues", async () => {
		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(
				buildModelReview({
					event: "COMMENT",
					general_findings: [],
					inline_comments: [],
				}),
			),
		);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review?.event).toBe("APPROVE");
		expect(review?.body).toContain("No issues found.");
		expect(review?.body).toContain("PR approved for merge.");
	});

	it("APPROVE on re-review acknowledges resolved issues", async () => {
		const headSha = "newcommit12345678";
		const priorBody = `### ai-review-bot\n\nFound bugs.\n\nReviewed commit: \`oldsha1234567\``;

		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(buildModelReview()),
		);

		const review = await buildReview({
			octokit: buildOctokit({ existingReviews: [{ body: priorBody }] }),
			...baseContext,
			headSha,
		});

		expect(review?.event).toBe("APPROVE");
		expect(review?.body).toContain(
			"All issues from the previous review have been resolved.",
		);
		expect(review?.body).toContain("PR approved for merge.");
	});

	it("APPROVE mentions outstanding CI checks", async () => {
		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(buildModelReview()),
		);

		const review = await buildReview({
			octokit: buildOctokit({
				checkRuns: [
					{ name: "tests", status: "completed", conclusion: "success" },
					{ name: "lint", status: "in_progress", conclusion: null },
					{ name: "deploy", status: "completed", conclusion: "failure" },
				],
			}),
			...baseContext,
		});

		expect(review?.event).toBe("APPROVE");
		expect(review?.body).toContain("PR approved for merge.");
		expect(review?.body).toContain("2 CI check(s) still outstanding");
		expect(review?.body).toContain("lint (in_progress)");
		expect(review?.body).toContain("deploy (failed)");
	});

	it("does not APPROVE when there are general findings", async () => {
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [
					{ title: "Minor nit", body: "Fix this.", severity: "low" },
				],
			}),
		);
		const summaryResponse = {
			object: { summary: "One minor nit." },
			usage: { inputTokens: 50, outputTokens: 20 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(summaryResponse);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review?.event).toBe("COMMENT");
	});

	it("includes cost footer with GitHub project link", async () => {
		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(buildModelReview()),
		);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review?.body).toContain("$");
		expect(review?.body).toContain("github.com/joeblackwaslike/ai-review-bot");
	});

	it("passes prior bot reviews from other bots to buildUserMessage", async () => {
		const headSha = "1234567890abcdef";
		const otherBotBody = `### codex-review-bot\n\nFound a security issue.\n\n${reviewedCommitMarker(headSha)}`;

		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(buildModelReview()),
		);

		await buildReview({
			octokit: buildOctokit({ existingReviews: [{ body: otherBotBody }] }),
			...baseContext,
			headSha,
		});

		expect(mockBuildUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({ priorBotReviews: [otherBotBody] }),
		);
	});

	it("does not include own review in priorBotReviews", async () => {
		const headSha = "1234567890abcdef";
		const ownBotBody = `### ai-review-bot\n\nFound issues.\n\n${reviewedCommitMarker(headSha)}`;

		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(buildModelReview()),
		);

		await buildReview({
			octokit: buildOctokit({ existingReviews: [{ body: ownBotBody }] }),
			...baseContext,
			headSha,
			force: true,
		});

		expect(mockBuildUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({ priorBotReviews: [] }),
		);
	});

	it("ignores sister bot reviews for a different commit SHA", async () => {
		const headSha = "1234567890abcdef";
		const staleBody = `### codex-review-bot\n\nOld finding.\n\n${reviewedCommitMarker("oldsha111222")}`;

		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(buildModelReview()),
		);

		await buildReview({
			octokit: buildOctokit({ existingReviews: [{ body: staleBody }] }),
			...baseContext,
			headSha,
		});

		expect(mockBuildUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({ priorBotReviews: [] }),
		);
	});

	it("includes external bot reviews regardless of SHA", async () => {
		const headSha = "1234567890abcdef";
		const externalBotBody =
			"**CodeRabbit Review**\n\nFound a potential null dereference on line 42.";

		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(buildModelReview()),
		);

		await buildReview({
			octokit: buildOctokit({ existingReviews: [{ body: externalBotBody }] }),
			...baseContext,
			headSha,
		});

		expect(mockBuildUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({ priorBotReviews: [externalBotBody] }),
		);
	});
});

// ---------------------------------------------------------------------------
// buildReview — comment provenance
// ---------------------------------------------------------------------------

// Patch where lines 1..20 are all valid right-side lines.
const TWENTY_LINE_PATCH = [
	"@@ -0,0 +1,20 @@",
	...Array.from({ length: 20 }, (_, i) => `+line${i + 1}`),
].join("\n");

async function buildReviewWithTwoAgentsFlagging(
	path: string,
	line: number,
	options?: { feedbackEnabled?: boolean },
) {
	const feedbackEnabled = options?.feedbackEnabled ?? true;

	// Agent 1 (code-reviewer.md): returns one inline comment at path:line
	const agent1Response = buildGenerateObjectResponse(
		buildModelReview({
			event: "COMMENT",
			general_findings: [],
			inline_comments: [
				buildInlineComment({
					title: "Issue",
					body: "b",
					path,
					line,
					start_line: null,
					suggestion: null,
				}),
			],
		}),
	);
	// Agent 2 (silent-failure-hunter.md): returns one inline comment at the same path:line
	const agent2Response = buildGenerateObjectResponse(
		buildModelReview({
			event: "COMMENT",
			general_findings: [],
			inline_comments: [
				buildInlineComment({
					title: "Issue",
					body: "b",
					path,
					line,
					start_line: null,
					suggestion: null,
				}),
			],
		}),
	);
	// Agents 3-5: no findings
	const emptyAgentResponse = buildGenerateObjectResponse(
		buildModelReview({
			event: "COMMENT",
			general_findings: [],
			inline_comments: [],
		}),
	);
	// Summary call
	const summaryResponse = {
		object: { summary: "Two agents flagged an issue." },
		usage: { inputTokens: 50, outputTokens: 20 },
	};

	mockGenerateObject
		.mockResolvedValueOnce(agent1Response)
		.mockResolvedValueOnce(agent2Response)
		.mockResolvedValueOnce(emptyAgentResponse)
		.mockResolvedValueOnce(emptyAgentResponse)
		.mockResolvedValueOnce(emptyAgentResponse)
		.mockResolvedValueOnce(summaryResponse);

	return buildReview({
		octokit: buildOctokit({
			files: [buildPullFile(path, TWENTY_LINE_PATCH)],
		}),
		...baseContext,
		feedbackEnabled,
	});
}

describe("buildReview comment provenance", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	it("attaches the set of skills that flagged each posted inline comment", async () => {
		const decision = await buildReviewWithTwoAgentsFlagging("src/x.ts", 10);
		expect(decision?.commentProvenance).toBeDefined();
		const prov = decision?.commentProvenance?.get("src/x.ts:10");
		expect(prov?.skills.sort()).toEqual([
			"code-reviewer.md",
			"silent-failure-hunter.md",
		]);
		expect(prov?.title.length).toBeGreaterThan(0);
	});

	it("omits provenance when feedbackEnabled is false", async () => {
		const decision = await buildReviewWithTwoAgentsFlagging("src/x.ts", 10, {
			feedbackEnabled: false,
		});
		expect(decision?.commentProvenance).toBeUndefined();
	});

	it("includes the 👍/👎 invitation in the body when feedbackEnabled and there are inline comments", async () => {
		const decision = await buildReviewWithTwoAgentsFlagging("src/x.ts", 10);
		expect(decision?.body).toContain("React 👍");
	});

	it("omits the invitation when feedbackEnabled is false", async () => {
		const decision = await buildReviewWithTwoAgentsFlagging("src/x.ts", 10, {
			feedbackEnabled: false,
		});
		expect(decision?.body ?? "").not.toContain("React 👍");
	});
});
