import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KvClient } from "./feedback/kv.js";
import { createAIModel } from "./models.js";
import {
	buildReview,
	buildReviewComments,
	classifyRefusal,
	collectRightSideLines,
	computePaceDelayMs,
	generateSummary,
	mergeReviews,
	runAgent,
	TIER1_SKILLS,
} from "./review.js";
import type { PersistedFinding } from "./review-state.js";
import { findingId, loadReviewState, saveReviewState } from "./review-state.js";
import type { ModelSelection } from "./router.js";
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
const mockBuildAgentSystemPrompt = vi.hoisted(() => vi.fn());

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
	// Tagged with the skill path so a test can route a mocked model response to a
	// specific agent by what it was asked to review, rather than by the position
	// of the agent in TIER1_SKILLS. Ordering assumptions pass silently when the
	// list is reordered, while attributing findings to the wrong skill.
	buildAgentSystemPrompt: (...args: unknown[]) => {
		mockBuildAgentSystemPrompt(...args);
		return `system:${args[0]}`;
	},
}));

const mockTriageReReview = vi.hoisted(() => vi.fn());
const mockFetchDeltaMeta = vi.hoisted(() =>
	vi.fn(async () => ({ files: [], diff: "delta", truncated: false })),
);
vi.mock("./triage.js", () => ({
	triageReReview: mockTriageReReview,
	fetchDeltaMeta: mockFetchDeltaMeta,
	// Legacy exports kept so any direct import of fetchDelta/fetchDeltaFiles in
	// tests continues to resolve (unused by review.ts after the refactor).
	fetchDelta: vi.fn(async () => "delta"),
	fetchDeltaFiles: vi.fn(async () => []),
}));

// ---------------------------------------------------------------------------
// mergeReviews resolved handling
// ---------------------------------------------------------------------------

describe("mergeReviews resolved handling", () => {
	const reqChanges = {
		event: "REQUEST_CHANGES" as const,
		general_findings: [
			{ title: "Unvalidated input", body: "x", severity: "high" as const },
		],
		inline_comments: [buildInlineComment({ path: "src/a.ts", line: 5 })],
	};

	it("drops a resolved finding and clears the event when nothing unresolved remains", () => {
		const resolved = new Set([
			"general:unvalidated input",
			"inline:src/a.ts:5",
		]);
		const merged = mergeReviews([reqChanges], resolved);
		expect(merged.general_findings).toHaveLength(0);
		expect(merged.inline_comments).toHaveLength(0);
		expect(merged.event).toBe("COMMENT");
	});

	it("keeps REQUEST_CHANGES when an unresolved finding remains", () => {
		const merged = mergeReviews([reqChanges], new Set());
		expect(merged.event).toBe("REQUEST_CHANGES");
	});
});

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

	it("prepends a severity badge to the comment body", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 2, severity: "high", title: "Race" }),
		]);

		expect(comments[0].body.startsWith("🔴 **High**\n\n")).toBe(true);
		expect(comments[0].body).toContain("**Race**");
	});

	it("renders a low-severity badge for a comment without a suggestion", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 2, severity: "low", suggestion: null }),
		]);

		expect(comments[0].body.startsWith("🟢 **Low**\n\n")).toBe(true);
		expect(comments[0].body).not.toContain("*Suggested fix:*");
	});

	it("falls back to an Unknown badge for an unrecognized severity (defensive — Zod bypassed)", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 2, severity: "critical" as never }),
		]);

		expect(comments[0].body.startsWith("⚪ **Unknown**\n\n")).toBe(true);
		expect(comments[0].body).not.toContain("undefined");
	});

	it("labels and separates the suggestion block", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 2, suggestion: "const x = 1;" }),
		]);

		expect(comments[0].body).toContain(
			"*Suggested fix:*\n\n```suggestion\nconst x = 1;\n```",
		);
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
	checkRunsError?: Error;
}) {
	const requestMock = vi.fn().mockImplementation((route: string) => {
		if (route.includes("GET") && route.includes("/check-runs")) {
			if (overrides?.checkRunsError) {
				throw overrides.checkRunsError;
			}
			return { data: { check_runs: overrides?.checkRuns ?? [] } };
		}
		if (route.includes("/check-runs")) {
			return { data: {} };
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
	agentConcurrency: 1,
	agentBudgetMs: 600_000,
	tier2Enabled: false,
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

	it("falls back to a default summary (and logs) when the model returns an empty summary", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [
					{ title: "Something", body: "needs work", severity: "high" },
				],
				inline_comments: [],
			}),
		);
		const emptySummaryResponse = {
			object: { summary: "   " },
			usage: { inputTokens: 50, outputTokens: 20 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(emptySummaryResponse);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review?.body).toContain(
			"Requesting changes — see the findings and inline comments below.",
		);
		expect(warn).toHaveBeenCalledWith(
			"summary model returned an empty summary; using fallback",
			expect.objectContaining({ finalEvent: "REQUEST_CHANGES" }),
		);
		warn.mockRestore();
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

	// Before this test, a failed check-runs fetch (auth blip, rate limit,
	// network) rendered *identically* to "CI genuinely has nothing
	// outstanding" — the approval message must say it couldn't verify, not
	// silently claim a clean bill of health it never confirmed.
	it("says checks could not be verified when the check-runs fetch fails, instead of claiming none are outstanding", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mockGenerateObject.mockResolvedValue(
			buildGenerateObjectResponse(buildModelReview()),
		);

		const review = await buildReview({
			octokit: buildOctokit({
				checkRunsError: new Error("GitHub API unavailable"),
			}),
			...baseContext,
		});

		expect(review?.event).toBe("APPROVE");
		expect(review?.body).toContain("PR approved for merge.");
		expect(review?.body).toContain("could not verify outstanding CI checks");
		expect(review?.body).not.toContain("CI check(s) still outstanding");
		expect(warn).toHaveBeenCalledWith(
			"failed to fetch outstanding checks",
			expect.objectContaining({ err: expect.any(Error) }),
		);
		warn.mockRestore();
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
// buildReview — Tier 2 gate
// ---------------------------------------------------------------------------

// A patch that introduces a TypeScript interface — triggers shouldRunTypeDesign
const TYPE_DEFINITION_PATCH = [
	"@@ -1,2 +1,4 @@",
	" line1",
	"+interface Foo {",
	"+  bar: string;",
	" line3",
].join("\n");

describe("buildReview Tier 2 gate", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	it("runs only Tier 1 agents when tier2Enabled is false", async () => {
		// 5 Tier 1 agents; summary is skipped because all agents return no findings (APPROVE path)
		const emptyAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		mockGenerateObject
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent);

		const decision = await buildReview({
			octokit: buildOctokit({
				files: [buildPullFile("src/types.ts", TYPE_DEFINITION_PATCH)],
			}),
			...baseContext,
			tier2Enabled: false,
		});

		expect(decision?.metadata.tier2Skills).toEqual([]);
		// Only 5 generateObject calls: 5 Tier 1 agents, no summary (APPROVE skips it), no Tier 2
		expect(mockGenerateObject).toHaveBeenCalledTimes(5);
	});

	it("runs Tier 2 agents when tier2Enabled is true and the PR triggers them", async () => {
		// With tier2Enabled: true and a .ts file containing an interface definition,
		// shouldRunTypeDesign fires → 1 extra Tier 2 agent; all return no findings so
		// APPROVE is emitted and the summary call is skipped (6 total calls).
		const emptyAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		mockGenerateObject
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent); // Tier 2 agent

		const decision = await buildReview({
			octokit: buildOctokit({
				files: [buildPullFile("src/types.ts", TYPE_DEFINITION_PATCH)],
			}),
			...baseContext,
			tier2Enabled: true,
		});

		expect(decision?.metadata.tier2Skills.length).toBeGreaterThan(0);
		// 5 Tier 1 + 1 Tier 2 agent, no summary (APPROVE skips it)
		expect(mockGenerateObject).toHaveBeenCalledTimes(6);
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

	it("invites all three reactions when feedbackEnabled and there are inline comments", async () => {
		const decision = await buildReviewWithTwoAgentsFlagging("src/x.ts", 10);
		expect(decision?.body).toContain("💬 React");
		for (const reaction of ["👍", "👎", "😕"]) {
			expect(decision?.body).toContain(reaction);
		}
	});

	it("asks for a written reason alongside 😕, since the reply carries the intent", async () => {
		const decision = await buildReviewWithTwoAgentsFlagging("src/x.ts", 10);
		expect(decision?.body).toContain("please also reply");
	});

	it("omits the invitation when feedbackEnabled is false", async () => {
		const decision = await buildReviewWithTwoAgentsFlagging("src/x.ts", 10, {
			feedbackEnabled: false,
		});
		expect(decision?.body ?? "").not.toContain("💬 React");
	});
});

// ---------------------------------------------------------------------------
// runAgent — caching + telemetry
// ---------------------------------------------------------------------------

const sel = {
	provider: "anthropic",
	model: "claude-sonnet-4-6",
	tier: 1,
} as ModelSelection;

describe("runAgent caching + telemetry", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
	});

	it("sends the shared block first with ephemeral cacheControl and the skill block second", async () => {
		mockGenerateObject.mockResolvedValue({
			object: buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			usage: { inputTokens: 10, outputTokens: 5 },
			providerMetadata: {
				anthropic: { cacheCreationInputTokens: 2000, cacheReadInputTokens: 0 },
			},
			response: {
				headers: { "anthropic-ratelimit-input-tokens-remaining": "28000" },
			},
		});

		const out = await runAgent(
			"code-reviewer.md",
			"SHARED_DIFF_CONTEXT",
			sel,
			"custom",
		);

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		const parts = call.messages[0].content;
		expect(call.messages[0].role).toBe("user");
		expect(parts[0].text).toBe("SHARED_DIFF_CONTEXT");
		expect(parts[0].providerOptions.anthropic.cacheControl).toEqual({
			type: "ephemeral",
		});
		expect(parts[1].text).toBe("system:code-reviewer.md"); // skill block from mocked buildAgentSystemPrompt
		expect(out?.status).toBe("ok");
	});

	it("gives OpenAI reasoning models a large output budget and low reasoning effort", async () => {
		mockGenerateObject.mockResolvedValue({
			object: buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			usage: { inputTokens: 10, outputTokens: 5 },
			providerMetadata: {},
			response: { headers: {} },
		});
		const openaiSel = {
			provider: "openai",
			model: "gpt-5.1",
			tier: 1,
			effort: "low",
		} as ModelSelection;

		await runAgent("code-reviewer.md", "SHARED", openaiSel, "");

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		// gpt-5.1 spends reasoning tokens from this budget — it must dwarf the 4096
		// base, and the tier's effort is forwarded so it can't starve the output.
		expect(call.maxOutputTokens).toBe(32768);
		expect(call.providerOptions.openai.reasoningEffort).toBe("low");
	});

	it("forwards effort and budget headroom for Anthropic reasoning tiers", async () => {
		mockGenerateObject.mockResolvedValue({
			object: buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			usage: { inputTokens: 10, outputTokens: 5 },
			providerMetadata: { anthropic: {} },
			response: { headers: {} },
		});
		const opusSel = {
			provider: "anthropic",
			model: "claude-opus-4-8",
			tier: 4,
			effort: "xhigh",
		} as ModelSelection;

		await runAgent("code-reviewer.md", "SHARED", opusSel, "");

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(call.providerOptions.anthropic.effort).toBe("xhigh");
		expect(call.maxOutputTokens).toBe(32768);
	});

	it("leaves the output budget at the base for non-reasoning providers", async () => {
		mockGenerateObject.mockResolvedValue({
			object: buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			usage: { inputTokens: 10, outputTokens: 5 },
			providerMetadata: { anthropic: {} },
			response: { headers: {} },
		});

		await runAgent("code-reviewer.md", "SHARED", sel, "");

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(call.maxOutputTokens).toBe(4096);
	});

	it("keeps the base budget for the OpenAI trivial tier (effort 'none') and forwards reasoningEffort 'none'", async () => {
		mockGenerateObject.mockResolvedValue({
			object: buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			usage: { inputTokens: 10, outputTokens: 5 },
			providerMetadata: { openai: {} },
			response: { headers: {} },
		});
		const trivialOpenAiSel = {
			provider: "openai",
			model: "gpt-5.1",
			tier: 1,
			effort: "none",
		} as ModelSelection;

		await runAgent("code-reviewer.md", "SHARED", trivialOpenAiSel, "");

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		// "none" is a truthy string but disables reasoning — the budget must stay
		// at the base (no inflation), and "none" is forwarded as a valid gpt-5.1
		// non-reasoning value rather than being dropped.
		expect(call.maxOutputTokens).toBe(4096);
		expect(call.providerOptions.openai.reasoningEffort).toBe("none");
	});

	it("scales the generateSummary budget for reasoning tiers and forwards effort", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { summary: "Looks good." },
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		const openaiReasoningSel = {
			provider: "openai",
			model: "gpt-5.1",
			tier: 3,
			effort: "high",
		} as ModelSelection;

		await generateSummary(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			openaiReasoningSel,
			{ title: "t", body: null, additions: 1, deletions: 0, changedFiles: 1 },
			null,
		);

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		// Summary base is 256; a reasoning tier floors to 16000 so reasoning tokens
		// can't starve the structured summary object (AI_NoObjectGeneratedError).
		expect(call.maxOutputTokens).toBe(16000);
		expect(call.providerOptions.openai.reasoningEffort).toBe("high");
	});

	it("keeps the generateSummary budget at the base and omits providerOptions for non-reasoning tiers", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { summary: "No findings." },
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		const haikuSel = {
			provider: "anthropic",
			model: "claude-haiku-4-5",
			tier: 1,
		} as ModelSelection;

		await generateSummary(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			haikuSel,
			{ title: "t", body: null, additions: 1, deletions: 0, changedFiles: 1 },
			null,
		);

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(call.maxOutputTokens).toBe(256);
		expect(call.providerOptions).toBeUndefined();
	});

	it("returns status rate_limited with retryAfter on a 429", async () => {
		const err = Object.assign(new Error("429"), {
			statusCode: 429,
			responseHeaders: {
				"retry-after": "42",
				"anthropic-ratelimit-input-tokens-reset": "2026-06-09T07:21:30Z",
			},
		});
		mockGenerateObject.mockRejectedValue(err);

		const out = await runAgent("code-reviewer.md", "SHARED", sel, "");
		expect(out?.status).toBe("rate_limited");
		if (out?.status === "rate_limited") {
			expect(out.rateLimit.retryAfterSeconds).toBe(42);
			expect(out.rateLimit.inputTokensResetAt).toBe("2026-06-09T07:21:30Z");
		}
	});
});

// ---------------------------------------------------------------------------
// generateSummary carry-forward grounding
// ---------------------------------------------------------------------------

describe("generateSummary carry-forward grounding", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
	});

	it("grounds the prompt in survivingPrior and resolvedTombstones instead of only free-text prior-review prose", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { summary: "Summary." },
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		const sel = {
			provider: "anthropic",
			model: "claude-haiku-4-5",
		} as ModelSelection;
		const survivingPrior: PersistedFinding[] = [
			{
				id: "f1",
				path: "hooks/ensure-built.sh",
				line: 40,
				title:
					"pnpm build failure is silently swallowed, leaving a stale stamp",
				severity: "critical",
				status: "open",
			},
		];
		const resolvedTombstones: PersistedFinding[] = [
			{
				id: "f2",
				path: "hooks/ensure-built.sh",
				line: 12,
				title: "LOG_FILE referenced before assignment",
				severity: "medium",
				status: "resolved",
			},
		];

		await generateSummary(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			sel,
			{ title: "t", body: null, additions: 1, deletions: 0, changedFiles: 1 },
			"Some prior free-text review body.",
			survivingPrior,
			resolvedTombstones,
		);

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		const prompt = call.messages[0].content as string;
		expect(prompt).toContain(
			"pnpm build failure is silently swallowed, leaving a stale stamp",
		);
		expect(prompt).toContain("LOG_FILE referenced before assignment");
		// The instruction telling the model these lists are ground truth belongs
		// in the system prompt, not buried in free text it can rationalize past.
		expect(call.system).toContain("ground truth");
	});
});

// ---------------------------------------------------------------------------
// buildReview rate-limit decision
// ---------------------------------------------------------------------------

describe("buildReview rate-limit decision", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a RATE_LIMITED decision with the reset time when every agent 429s", async () => {
		vi.useFakeTimers();
		const err = Object.assign(new Error("429"), {
			statusCode: 429,
			responseHeaders: {
				"retry-after": "42",
				"anthropic-ratelimit-input-tokens-reset": "2026-06-09T07:21:30Z",
			},
		});
		mockGenerateObject.mockRejectedValue(err);

		const octokit = {
			request: vi.fn(async (route: string) =>
				route.includes("/reviews") ? { data: [] } : { data: {} },
			),
			paginate: vi.fn(async () => []),
		};

		const promise = buildReview({
			octokit: octokit as never,
			owner: "o",
			repo: "r",
			pullNumber: 1,
			headSha: "sha",
			title: "t",
			body: null,
			additions: 0,
			deletions: 0,
			changedFiles: 0,
			labels: [],
			commentPrefix: "ai-review-bot",
			extraInstructions: "",
			force: true,
			provider: "anthropic",
			feedbackEnabled: false,
			agentConcurrency: 1,
			agentBudgetMs: 600_000,
			tier2Enabled: false,
		});
		await vi.runAllTimersAsync();
		const decision = await promise;

		expect(decision?.event).toBe("RATE_LIMITED");
		expect(decision?.rateLimitResetAt).toBe("2026-06-09T07:21:30Z");
	});

	function quotaContext(provider: "anthropic" | "openai") {
		const octokit = {
			request: vi.fn(async (route: string) =>
				route.includes("/reviews") ? { data: [] } : { data: {} },
			),
			paginate: vi.fn(async () => []),
		};
		return {
			octokit: octokit as never,
			owner: "o",
			repo: "r",
			pullNumber: 1,
			headSha: "sha",
			title: "t",
			body: null,
			additions: 0,
			deletions: 0,
			changedFiles: 0,
			labels: [],
			commentPrefix: "ai-review-bot",
			extraInstructions: "",
			force: true,
			provider,
			feedbackEnabled: false,
			agentConcurrency: 1,
			agentBudgetMs: 600_000,
			tier2Enabled: false,
		};
	}

	it("returns QUOTA_EXHAUSTED naming the provider when every agent is out of credits", async () => {
		vi.useFakeTimers();
		mockGenerateObject.mockRejectedValue(
			Object.assign(new Error("You have no credits remaining"), {
				statusCode: 429,
			}),
		);

		const promise = buildReview(quotaContext("openai"));
		await vi.runAllTimersAsync();
		const decision = await promise;

		expect(decision?.event).toBe("QUOTA_EXHAUSTED");
		expect(decision?.quotaProvider).toBe("openai");
	});

	// Both conditions arrive as 429, so precedence is the whole point: reporting
	// a spent balance as a rate limit tells someone to wait for something that
	// will never happen.
	it("prefers QUOTA_EXHAUSTED over RATE_LIMITED when both appear in one run", async () => {
		vi.useFakeTimers();
		mockGenerateObject
			.mockRejectedValueOnce(
				Object.assign(new Error("rate limit exceeded"), {
					statusCode: 429,
					responseHeaders: { "retry-after": "42" },
				}),
			)
			.mockRejectedValue(
				Object.assign(new Error("insufficient_quota"), { statusCode: 429 }),
			);

		const promise = buildReview(quotaContext("anthropic"));
		await vi.runAllTimersAsync();
		const decision = await promise;

		expect(decision?.event).toBe("QUOTA_EXHAUSTED");
		expect(decision?.quotaProvider).toBe("anthropic");
	});

	it("stays COMMENT (not APPROVE) when some agents succeed with zero findings but at least one is rate-limited", async () => {
		vi.useFakeTimers();
		// First agent call resolves ok with zero findings; the remaining 4
		// Tier-1 agents get 429s with empty headers so computePaceDelayMs
		// returns 0 and no real sleep occurs.
		// The summary call (6th) also gets a mocked response so it doesn't throw.
		const err = Object.assign(new Error("429"), {
			statusCode: 429,
			responseHeaders: {},
		});
		const summaryResponse = {
			object: { summary: "Partial review — some agents were rate-limited." },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(
				buildGenerateObjectResponse(
					buildModelReview({
						event: "COMMENT",
						general_findings: [],
						inline_comments: [],
					}),
				),
			)
			// Agents 2–5 all 429
			.mockRejectedValueOnce(err)
			.mockRejectedValueOnce(err)
			.mockRejectedValueOnce(err)
			.mockRejectedValueOnce(err)
			// Summary call
			.mockResolvedValueOnce(summaryResponse);

		const octokit = {
			request: vi.fn(async (route: string) =>
				route.includes("/reviews") ? { data: [] } : { data: {} },
			),
			paginate: vi.fn(async () => []),
		};

		const promise = buildReview({
			octokit: octokit as never,
			owner: "o",
			repo: "r",
			pullNumber: 1,
			headSha: "sha",
			title: "t",
			body: null,
			additions: 0,
			deletions: 0,
			changedFiles: 0,
			labels: [],
			commentPrefix: "ai-review-bot",
			extraInstructions: "",
			force: true,
			provider: "anthropic",
			feedbackEnabled: false,
			agentConcurrency: 1,
			agentBudgetMs: 600_000,
			tier2Enabled: false,
		});
		await vi.runAllTimersAsync();
		const decision = await promise;

		// A partial review (some agents rate-limited) must NOT be APPROVE even if
		// the succeeded agents found nothing.
		expect(decision?.event).not.toBe("APPROVE");
		expect(decision?.event).toBe("COMMENT");
	});
});

describe("computePaceDelayMs", () => {
	const now = Date.parse("2026-06-09T07:20:00Z");
	it("returns 0 when plenty of tokens remain", () => {
		expect(computePaceDelayMs({ inputTokensRemaining: 25000 }, now)).toBe(0);
	});
	it("waits until reset when remaining is below the floor", () => {
		const d = computePaceDelayMs(
			{ inputTokensRemaining: 500, inputTokensResetAt: "2026-06-09T07:20:08Z" },
			now,
		);
		expect(d).toBeGreaterThan(0);
		expect(d).toBeLessThanOrEqual(8000);
	});
	it("honors retry-after and caps the wait", () => {
		expect(computePaceDelayMs({ retryAfterSeconds: 9999 }, now)).toBe(60000); // capped
	});
	it("returns 0 for undefined info", () => {
		expect(computePaceDelayMs(undefined, now)).toBe(0);
	});
	it("clamps to 0 when the reset time is in the past", () => {
		expect(
			computePaceDelayMs(
				{
					inputTokensRemaining: 500,
					inputTokensResetAt: "2026-06-09T07:19:00Z",
				},
				now,
			),
		).toBe(0);
	});
	it("falls back (no NaN) when the reset timestamp is malformed", () => {
		expect(
			computePaceDelayMs(
				{ inputTokensRemaining: 500, inputTokensResetAt: "not-a-date" },
				now,
			),
		).toBe(1000);
	});
});

// ---------------------------------------------------------------------------
// buildReview — triage gate (SKIP path)
// ---------------------------------------------------------------------------

function fakeKv() {
	const store = new Map<string, string>();
	return {
		store,
		client: {
			get: async (k: string) => store.get(k) ?? null,
			set: async (k: string, v: string) => void store.set(k, v),
			setNx: async () => true,
			del: async (...ks: string[]) => {
				for (const k of ks) store.delete(k);
			},
		} as unknown as KvClient,
	};
}

describe("buildReview triage gate — SKIP", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		mockTriageReReview.mockReset();
	});

	it("posts nothing, resolves the matched finding, and APPROVEs when triage says SKIP", async () => {
		// Triage forces SKIP and reports the seeded finding's id as resolved.
		mockTriageReReview.mockResolvedValue({
			recommendation: "SKIP",
			resolved: ["src/a.ts:5:bug"],
			newRisk: false,
		});

		const headSha = "newsha0987654321";
		const { client, store } = fakeKv();

		// Seed prior state with an open finding at an OLDER head SHA. id must equal
		// findingId(path,line,title) so the gate's resolve-key derivation matches.
		await saveReviewState(
			client,
			"anthropic",
			"joeblackwaslike",
			"ai-review-bot",
			1,
			{
				lastReviewedSha: "oldsha1234567",
				event: "REQUEST_CHANGES",
				findings: [
					{
						id: findingId("src/a.ts", 5, "bug"),
						path: "src/a.ts",
						line: 5,
						title: "bug",
						severity: "high",
						status: "open",
					},
				],
				reviewedAt: "2026-06-16T00:00:00Z",
			},
		);

		// A prior own review body so priorOwnReview is populated (the gate also
		// works off KV state, but this mirrors a real re-review).
		const priorOwnBody = `### ai-review-bot\n\nFound a bug.\n\nReviewed commit: \`oldsha1234567\``;

		const decision = await buildReview({
			octokit: buildOctokit({ existingReviews: [{ body: priorOwnBody }] }),
			...baseContext,
			headSha,
			kv: client,
		});

		// SKIP posts nothing.
		expect(decision).toBeNull();
		// No agents ran — generateObject was never invoked.
		expect(mockGenerateObject).not.toHaveBeenCalled();

		// Persisted state: finding resolved, event upgraded to APPROVE, SHA advanced.
		const persisted = await loadReviewState(
			client,
			"anthropic",
			"joeblackwaslike",
			"ai-review-bot",
			1,
			null,
		);
		expect(persisted?.lastReviewedSha).toBe(headSha);
		expect(persisted?.event).toBe("APPROVE");
		expect(persisted?.findings[0].status).toBe("resolved");
		// The state KV entry exists.
		expect(store.size).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// buildReview — end-to-end multi-bot flow: review@sha1 → SKIP@sha2 → INCREMENTAL→APPROVE@sha3
// ---------------------------------------------------------------------------

describe("buildReview triage gate — end-to-end multi-bot flow", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		mockTriageReReview.mockReset();
	});

	it("review@sha1 (REQUEST_CHANGES) → push sha2 (SKIP) → push sha3 (INCREMENTAL → APPROVE) against one shared KV", async () => {
		const { client } = fakeKv();
		const provider = "anthropic";
		const owner = baseContext.owner;
		const repo = baseContext.repo;
		const pull = baseContext.pullNumber;

		// src/a.ts spans right-side lines 1..20, so the Bug at line 5 anchors.
		const aFile = buildPullFile("src/a.ts", TWENTY_LINE_PATCH);
		const loadState = () =>
			loadReviewState(client, provider, owner, repo, pull, null);

		// The exact id Task-7 persistence writes for an inline finding is
		// findingId(path, line, title) with title = the model's inline title.
		const bugId = findingId("src/a.ts", 5, "Bug");

		// --- sha1: first review, cold KV ------------------------------------
		const sha1 = "aaaaaaaaaaaa1111";
		const bugAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [],
				inline_comments: [
					buildInlineComment({
						title: "Bug",
						body: "Off-by-one here.",
						path: "src/a.ts",
						line: 5,
						start_line: null,
						suggestion: null,
						severity: "high",
					}),
				],
			}),
		);
		const summaryResponse = {
			object: { summary: "One bug found." },
			usage: { inputTokens: 50, outputTokens: 20 },
		};
		// 5 Tier-1 agents (all flag the same Bug; mergeReviews dedups to one) + summary.
		mockGenerateObject
			.mockResolvedValueOnce(bugAgent)
			.mockResolvedValueOnce(bugAgent)
			.mockResolvedValueOnce(bugAgent)
			.mockResolvedValueOnce(bugAgent)
			.mockResolvedValueOnce(bugAgent)
			.mockResolvedValueOnce(summaryResponse);

		const r1 = await buildReview({
			octokit: buildOctokit({ files: [aFile] }),
			...baseContext,
			headSha: sha1,
			kv: client,
		});

		expect(r1?.event).toBe("REQUEST_CHANGES");
		// Triage is never consulted on the cold (no-prior-state) first review.
		expect(mockTriageReReview).not.toHaveBeenCalled();
		const stateAfterSha1 = await loadState();
		expect(stateAfterSha1?.lastReviewedSha).toBe(sha1);
		const openAfterSha1 = stateAfterSha1?.findings.filter(
			(f) => f.status === "open",
		);
		expect(openAfterSha1?.some((f) => f.id === bugId)).toBe(true);
		// Persisted inline finding keeps the model's severity (not a hardcoded
		// "medium") so re-review triage sees the real priority.
		expect(openAfterSha1?.find((f) => f.id === bugId)?.severity).toBe("high");

		// --- sha2: another bot's fix; my Bug untouched → SKIP ----------------
		mockGenerateObject.mockReset();
		const sha2 = "bbbbbbbbbbbb2222";
		vi.mocked(mockTriageReReview).mockResolvedValueOnce({
			recommendation: "SKIP",
			resolved: [],
			newRisk: false,
		});

		const r2 = await buildReview({
			octokit: buildOctokit({ files: [aFile] }),
			...baseContext,
			headSha: sha2,
			kv: client,
		});

		// SKIP posts nothing and runs no agents.
		expect(r2).toBeNull();
		expect(mockGenerateObject).not.toHaveBeenCalled();
		const stateAfterSha2 = await loadState();
		expect(stateAfterSha2?.lastReviewedSha).toBe(sha2);
		// My finding is still open (nothing resolved it), so the verdict stands.
		expect(stateAfterSha2?.findings.find((f) => f.id === bugId)?.status).toBe(
			"open",
		);
		expect(stateAfterSha2?.event).toBe("REQUEST_CHANGES");

		// --- sha3: resolves my Bug, nothing new → INCREMENTAL → APPROVE ------
		mockGenerateObject.mockReset();
		const sha3 = "cccccccccccc3333";
		vi.mocked(mockTriageReReview).mockResolvedValueOnce({
			recommendation: "INCREMENTAL",
			resolved: [bugId],
			newRisk: false,
		});
		// Agents find nothing new on the delta.
		const emptyAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		mockGenerateObject
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent);

		const r3 = await buildReview({
			octokit: buildOctokit({ files: [aFile] }),
			...baseContext,
			headSha: sha3,
			kv: client,
		});

		// All prior findings resolved + nothing new → APPROVE on the posted path.
		expect(r3?.event).toBe("APPROVE");
		// APPROVE skips the summary call, so only the 5 agents ran.
		expect(mockGenerateObject).toHaveBeenCalledTimes(5);
		const stateAfterSha3 = await loadState();
		expect(stateAfterSha3?.lastReviewedSha).toBe(sha3);
		expect(stateAfterSha3?.event).toBe("APPROVE");
		// No open findings remain after the resolving push.
		expect(stateAfterSha3?.findings.every((f) => f.status !== "open")).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// buildReview — truncated compare API (>= 300 files): gate must force FULL.
// ---------------------------------------------------------------------------

describe("buildReview triage gate — truncated compare forces FULL", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		mockTriageReReview.mockReset();
		mockFetchDeltaMeta.mockReset();
	});

	it("ignores SKIP from triage and runs a FULL review when compare is truncated", async () => {
		const { client } = fakeKv();
		const sha1 = "aaaaaaaaaaaa1111";
		const sha2 = "bbbbbbbbbbbb2222";

		await saveReviewState(
			client,
			"anthropic",
			baseContext.owner,
			baseContext.repo,
			baseContext.pullNumber,
			{
				lastReviewedSha: sha1,
				event: "REQUEST_CHANGES",
				findings: [],
				reviewedAt: "2026-06-17T00:00:00Z",
			},
		);

		// Triage says SKIP but the compare result is truncated — gate must ignore SKIP and run FULL.
		mockFetchDeltaMeta.mockResolvedValueOnce({
			files: [],
			diff: "big delta",
			truncated: true,
		});
		mockTriageReReview.mockResolvedValueOnce({
			recommendation: "SKIP",
			resolved: [],
			newRisk: false,
		});

		// Agents run (FULL review, not SKIP).
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "Looks good." },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		// 5 Tier 1 agents + 1 summary call
		for (let i = 0; i < 5; i++)
			mockGenerateObject.mockResolvedValueOnce(agentResponse);
		mockGenerateObject.mockResolvedValueOnce(summaryResponse);

		const result = await buildReview({
			octokit: buildOctokit({
				files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
			}),
			...baseContext,
			headSha: sha2,
			kv: client,
		});

		// Must NOT return null (which SKIP would cause); a full review was posted.
		expect(result).not.toBeNull();
	});

	it("ignores INCREMENTAL from triage and runs a FULL review when compare is truncated", async () => {
		const { client } = fakeKv();
		const sha1 = "aaaaaaaaaaaa1111";
		const sha2 = "bbbbbbbbbbbb2222";

		await saveReviewState(
			client,
			"anthropic",
			baseContext.owner,
			baseContext.repo,
			baseContext.pullNumber,
			{
				lastReviewedSha: sha1,
				event: "REQUEST_CHANGES",
				findings: [],
				reviewedAt: "2026-06-17T00:00:00Z",
			},
		);

		// Triage says INCREMENTAL but compare is truncated — gate must run FULL instead.
		mockFetchDeltaMeta.mockResolvedValueOnce({
			files: [], // truncated partial list — should NOT become scopedFiles
			diff: "big delta",
			truncated: true,
		});
		mockTriageReReview.mockResolvedValueOnce({
			recommendation: "INCREMENTAL",
			resolved: [],
			newRisk: true,
		});

		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "Looks good." },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		for (let i = 0; i < 5; i++)
			mockGenerateObject.mockResolvedValueOnce(agentResponse);
		mockGenerateObject.mockResolvedValueOnce(summaryResponse);

		// The octokit paginate returns the full file list (not the truncated delta).
		const fullFile = buildPullFile("src/a.ts", SIMPLE_PATCH);
		const result = await buildReview({
			octokit: buildOctokit({ files: [fullFile] }),
			...baseContext,
			headSha: sha2,
			kv: client,
		});

		// A real review (not null) was posted — INCREMENTAL was not taken.
		expect(result).not.toBeNull();
		// survivingPrior is empty (we didn't carry INCREMENTAL state), so APPROVE is possible.
		// The agents returned no findings, so the final event should be APPROVE (not REQUEST_CHANGES
		// that an INCREMENTAL carry-forward would force).
		expect(result?.event).toBe("APPROVE");
	});
});

// ---------------------------------------------------------------------------
// buildReview — C1 regression: INCREMENTAL must carry forward still-open prior
// findings (a clean delta on an unrelated file must NOT false-APPROVE).
// ---------------------------------------------------------------------------

describe("buildReview triage gate — INCREMENTAL carries forward open prior findings", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		mockTriageReReview.mockReset();
	});

	it("does NOT APPROVE and keeps F open when the delta touches an unrelated file and resolves nothing", async () => {
		const { client } = fakeKv();
		const provider = "anthropic";
		const owner = baseContext.owner;
		const repo = baseContext.repo;
		const pull = baseContext.pullNumber;
		const loadState = () =>
			loadReviewState(client, provider, owner, repo, pull, null);

		// Prior open finding F on file A, persisted at sha1.
		const sha1 = "aaaaaaaaaaaa1111";
		const fId = findingId("src/a.ts", 5, "Bug");
		await saveReviewState(client, provider, owner, repo, pull, {
			lastReviewedSha: sha1,
			event: "REQUEST_CHANGES",
			findings: [
				{
					id: fId,
					path: "src/a.ts",
					line: 5,
					title: "Bug",
					severity: "high",
					status: "open",
				},
			],
			reviewedAt: "2026-06-17T00:00:00Z",
		});

		// Push sha2: triage INCREMENTAL, resolves nothing; the delta is only file B.
		const sha2 = "bbbbbbbbbbbb2222";
		vi.mocked(mockTriageReReview).mockResolvedValueOnce({
			recommendation: "INCREMENTAL",
			resolved: [],
			newRisk: false,
		});
		// fetchDeltaFiles is mocked (returns []) — so scopedFiles is empty and the
		// agents never see file A. Agents return nothing new.
		const emptyAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		// 5 agents return nothing; the forced REQUEST_CHANGES (survivingPrior) means
		// generateSummary IS called (APPROVE is the only path that skips it).
		const summaryResponse = {
			object: { summary: "Prior unresolved findings remain." },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(summaryResponse);

		const r2 = await buildReview({
			octokit: buildOctokit({
				files: [buildPullFile("src/b.ts", SIMPLE_PATCH)],
			}),
			...baseContext,
			headSha: sha2,
			kv: client,
		});

		// (a) An unresolved prior blocking finding remains → must NOT be APPROVE.
		expect(r2?.event).not.toBe("APPROVE");
		expect(r2?.event).toBe("REQUEST_CHANGES");

		// (b) State still contains F (open) and the SHA advanced.
		const stateAfterSha2 = await loadState();
		expect(stateAfterSha2?.lastReviewedSha).toBe(sha2);
		const carried = stateAfterSha2?.findings.find((f) => f.id === fId);
		expect(carried?.status).toBe("open");
		expect(stateAfterSha2?.event).toBe("REQUEST_CHANGES");
	});
});

// ---------------------------------------------------------------------------
// buildReview — FULL must ALSO carry forward still-open prior findings.
// showPriorOwnFindings (REVIEWER_TUNING, unified ai-review-bot-5zu) tells
// agents on every pass, FULL included, not to re-file a finding already on
// the record as open. Before this fix only INCREMENTAL fed that promise back
// into survivingPrior/persisted state — a FULL pass silently dropped an
// unfixed finding from tracked state and could false-APPROVE past it.
// Flagged by chatgpt-codex-connector on PR #54.
// ---------------------------------------------------------------------------

describe("buildReview triage gate — FULL carries forward open prior findings", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		mockTriageReReview.mockReset();
	});

	it("does NOT APPROVE and keeps F open when triage recommends FULL and resolves nothing", async () => {
		const { client } = fakeKv();
		const provider = "anthropic";
		const owner = baseContext.owner;
		const repo = baseContext.repo;
		const pull = baseContext.pullNumber;
		const loadState = () =>
			loadReviewState(client, provider, owner, repo, pull, null);

		// Prior open finding F, persisted at sha1.
		const sha1 = "aaaaaaaaaaaa1111";
		const fId = findingId("src/a.ts", 5, "Bug");
		await saveReviewState(client, provider, owner, repo, pull, {
			lastReviewedSha: sha1,
			event: "REQUEST_CHANGES",
			findings: [
				{
					id: fId,
					path: "src/a.ts",
					line: 5,
					title: "Bug",
					severity: "high",
					status: "open",
				},
			],
			reviewedAt: "2026-06-17T00:00:00Z",
		});

		// Push sha2: triage recommends FULL (a structural change), resolves nothing.
		const sha2 = "bbbbbbbbbbbb2222";
		vi.mocked(mockTriageReReview).mockResolvedValueOnce({
			recommendation: "FULL",
			resolved: [],
			newRisk: true,
		});
		// FULL reviews the whole file set; agents are told (priorOwnFindings) not
		// to re-file F, and — this is the bug — return nothing new either.
		const emptyAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "Prior unresolved findings remain." },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(summaryResponse);

		const r2 = await buildReview({
			octokit: buildOctokit({
				files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
			}),
			...baseContext,
			headSha: sha2,
			kv: client,
		});

		// (a) An unresolved prior blocking finding remains → must NOT be APPROVE.
		expect(r2?.event).not.toBe("APPROVE");
		expect(r2?.event).toBe("REQUEST_CHANGES");

		// (b) The body uses the FULL-pass wording, not the INCREMENTAL one — proves
		// this went through the "agents saw it and were told not to restate it"
		// path, not a swapped/broken string that happened to still read fine.
		expect(r2?.body).toContain("flagged in a previous review");
		expect(r2?.body).not.toContain("reviewed only what changed since");

		// (c) State still contains F (open) and the SHA advanced.
		const stateAfterSha2 = await loadState();
		expect(stateAfterSha2?.lastReviewedSha).toBe(sha2);
		const carried = stateAfterSha2?.findings.find((f) => f.id === fId);
		expect(carried?.status).toBe("open");
		expect(stateAfterSha2?.event).toBe("REQUEST_CHANGES");

		// (d) The summary-writing call was grounded in the still-open finding F —
		// reproduces the PR #57 round-2 failure mode, where a summary model with
		// no access to survivingPrior independently declared a still-open
		// blocker "addressed" while the table right below it kept blocking on
		// the same finding. Found by system prompt content, not call index —
		// an index breaks silently if an earlier generateObject call is added
		// or removed.
		const summaryCall = (
			mockGenerateObject as ReturnType<typeof vi.fn>
		).mock.calls.find((c) =>
			(c[0].system as string | undefined)?.includes("ground truth"),
		)?.[0];
		expect(summaryCall).toBeDefined();
		const summaryPrompt = summaryCall.messages[0].content as string;
		expect(summaryPrompt).toContain("CONFIRMED still open");
		expect(summaryPrompt).toContain("Bug");
	});

	// Flagged independently by chatgpt-codex-connector and coderabbitai on PR
	// #61: resolvedTombstones (used for state persistence) accumulates every
	// finding ever resolved across all past rounds, not just this round's. If
	// that full list were fed to generateSummary as "confirmed resolved this
	// round", a finding resolved two rounds ago and then reintroduced would be
	// declared freshly fixed even while this round's own findings re-flag it.
	it("excludes historical tombstones from THIS round's 'confirmed resolved' grounding", async () => {
		const { client } = fakeKv();
		const provider = "anthropic";
		const owner = baseContext.owner;
		const repo = baseContext.repo;
		const pull = baseContext.pullNumber;

		const sha1 = "cccccccccccc3333";
		const openId = findingId("src/a.ts", 5, "Bug");
		const historicalTombstoneId = findingId(
			"src/a.ts",
			9,
			"Old bug fixed two rounds ago",
		);
		await saveReviewState(client, provider, owner, repo, pull, {
			lastReviewedSha: sha1,
			event: "REQUEST_CHANGES",
			findings: [
				{
					id: openId,
					path: "src/a.ts",
					line: 5,
					title: "Bug",
					severity: "high",
					status: "open",
				},
				{
					id: historicalTombstoneId,
					path: "src/a.ts",
					line: 9,
					title: "Old bug fixed two rounds ago",
					severity: "medium",
					status: "resolved",
				},
			],
			reviewedAt: "2026-06-17T00:00:00Z",
		});

		const sha2 = "dddddddddddd4444";
		vi.mocked(mockTriageReReview).mockResolvedValueOnce({
			recommendation: "FULL",
			resolved: [], // resolves nothing new this round
			newRisk: true,
		});
		const emptyAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "Prior unresolved findings remain." },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(emptyAgent)
			.mockResolvedValueOnce(summaryResponse);

		await buildReview({
			octokit: buildOctokit({
				files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
			}),
			...baseContext,
			headSha: sha2,
			kv: client,
		});

		const summaryCall = (
			mockGenerateObject as ReturnType<typeof vi.fn>
		).mock.calls.find((c) =>
			(c[0].system as string | undefined)?.includes("ground truth"),
		)?.[0];
		expect(summaryCall).toBeDefined();
		const summaryPrompt = summaryCall.messages[0].content as string;
		expect(summaryPrompt).not.toContain("Old bug fixed two rounds ago");
		expect(summaryPrompt).not.toContain("CONFIRMED resolved this round");
	});
});

describe("classifyRefusal", () => {
	// Both conditions arrive as HTTP 429 and need opposite responses from a
	// human, so quota must win over rate limit whenever both could match.
	it("reads OpenAI's spent balance as quota, not a rate limit", () => {
		expect(
			classifyRefusal({
				statusCode: 429,
				message: "You have no credits remaining. Add credits to continue",
			}),
		).toBe("quota_exhausted");
	});

	it("reads OpenAI's insufficient_quota code as quota", () => {
		expect(
			classifyRefusal({
				statusCode: 429,
				responseBody: '{"code":"insufficient_quota"}',
			}),
		).toBe("quota_exhausted");
	});

	it("reads Anthropic's low balance as quota", () => {
		expect(
			classifyRefusal({
				statusCode: 400,
				message: "Your credit balance is too low to access the Claude API",
			}),
		).toBe("quota_exhausted");
	});

	it("still reads a genuine 429 as a rate limit", () => {
		expect(
			classifyRefusal({ statusCode: 429, message: "rate limit exceeded" }),
		).toBe("rate_limit");
	});

	it("unwraps a RetryError to find the real cause", () => {
		expect(
			classifyRefusal({
				name: "AI_RetryError",
				lastError: {
					statusCode: 429,
					message: "You have no credits remaining",
				},
			}),
		).toBe("quota_exhausted");
	});

	it("finds quota inside an errors array even when a sibling is a plain 429", () => {
		expect(
			classifyRefusal({
				errors: [
					{ statusCode: 429, message: "rate limit" },
					{ statusCode: 429, message: "insufficient_quota" },
				],
			}),
		).toBe("quota_exhausted");
	});

	it("returns null for an unrelated error", () => {
		expect(classifyRefusal(new Error("socket hang up"))).toBeNull();
		expect(classifyRefusal({ statusCode: 500 })).toBeNull();
	});
});

describe("agent time budget", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	// The platform kills the function at maxDuration with nothing posted. Five
	// agents' worth of findings beats a 504 that loses all of them.
	it("submits what completed instead of losing the review to the timeout", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [
					{ title: "Found by agent one", body: "real", severity: "high" },
				],
				inline_comments: [],
			}),
		);
		// Each agent burns 400s of the 600s budget, so the second one exhausts it
		// and every agent after that is skipped without a model call.
		let now = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		mockGenerateObject.mockImplementation(async () => {
			calls += 1;
			// Calls 1-2 are agents; the third is the summary, which must not
			// advance the clock or return an agent-shaped object.
			if (calls > 2) {
				return {
					object: { summary: "Partial pass." },
					usage: { inputTokens: 10, outputTokens: 5 },
				};
			}
			now += 400_000;
			return agentResponse;
		});

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			agentBudgetMs: 600_000,
		});

		clock.mockRestore();
		expect(review).not.toBeNull();
		// Two agents ran; the summary call is not one of the five agents.
		expect(review?.body).toContain("Found by agent one");
		expect(review?.body).toContain("Partial review");
		expect(review?.body).toContain("3 of 5 agents did not run");
		expect(warn).toHaveBeenCalledWith(
			"review ran out of time budget",
			expect.objectContaining({ completed: 2 }),
		);
		warn.mockRestore();
	});

	it("runs every agent and says nothing about the budget when there is room", async () => {
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [{ title: "Found", body: "real", severity: "high" }],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "One issue." },
			usage: { inputTokens: 10, outputTokens: 5 },
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

		expect(mockGenerateObject).toHaveBeenCalledTimes(6);
		expect(review?.body).not.toContain("Partial review");
	});
});

describe("partial runs cannot approve", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	// The agents that DO run return a clean COMMENT with nothing flagged — the
	// one shape that is eligible for the APPROVE upgrade. Only `allAgentsSucceeded`
	// stands between that and an approval, so this fails the moment a skipped
	// agent is treated as neutral. Asserting on a REQUEST_CHANGES fixture would
	// pass whether or not the gate exists.
	it("stays at COMMENT when the completed agents found nothing but others were skipped", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const cleanAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		let now = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		mockGenerateObject.mockImplementation(async () => {
			calls += 1;
			if (calls > 2) {
				return {
					object: { summary: "Nothing found in what ran." },
					usage: { inputTokens: 10, outputTokens: 5 },
				};
			}
			now += 400_000;
			return cleanAgent;
		});

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			agentBudgetMs: 600_000,
		});

		clock.mockRestore();
		warn.mockRestore();
		expect(review?.event).not.toBe("APPROVE");
		expect(review?.body).toContain("Partial review");
	});

	// The control: same clean agents, enough budget for all five. Without this,
	// the test above could pass because the fixture never approves at all.
	it("does approve the same clean result when every agent ran", async () => {
		const cleanAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		mockGenerateObject.mockResolvedValue(cleanAgent);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review?.event).toBe("APPROVE");
	});
});

describe("agent errors surface on the review", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	// A crashed agent (schema failure, transient network error — anything that
	// isn't a 429) must not read as "nothing to say": before this test, only
	// `skipped` (budget-exhausted) agents earned a body notice, so a thrown
	// agent vanished with zero trace on the PR even though allAgentsSucceeded
	// already (correctly) blocked APPROVE.
	it("names the failed skill and stays partial when an agent throws a non-refusal error", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const cleanAgent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "Nothing found in what ran." },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(cleanAgent)
			.mockRejectedValueOnce(new Error("schema validation failed"))
			.mockResolvedValueOnce(cleanAgent)
			.mockResolvedValueOnce(cleanAgent)
			.mockResolvedValueOnce(cleanAgent)
			.mockResolvedValueOnce(summaryResponse);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review?.event).not.toBe("APPROVE");
		expect(review?.body).toContain("Partial review");
		expect(review?.body).toContain(
			(TIER1_SKILLS[1] ?? "").replace(/\.md$/, ""),
		);
		expect(warn).toHaveBeenCalledWith(
			"review agents failed and were excluded from this pass",
			expect.objectContaining({ errored: [TIER1_SKILLS[1]] }),
		);
		warn.mockRestore();
	});
});

describe("reviewer tuning wiring", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildAgentSystemPrompt.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	// Two agents reporting one claim on adjacent lines of the same expression —
	// the shape that arrived eight times on #43.
	function restatementResponses() {
		const first = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [],
				inline_comments: [
					buildInlineComment({
						title:
							"`body: f.title` duplicates the title instead of the description",
						body: "the fuller explanation",
						path: "src/review.ts",
						line: 2,
					}),
				],
			}),
		);
		const second = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [],
				inline_comments: [
					buildInlineComment({
						title:
							"body field set to f.title — finding body duplicates the title",
						body: "short",
						path: "src/review.ts",
						line: 3,
					}),
				],
			}),
		);
		return { first, second };
	}

	it("collapses restatements for anthropic", async () => {
		const { first, second } = restatementResponses();
		// Keyed off the prompt rather than a fixed-length chain: a change to the
		// tier-1 agent count would silently shift a chained mock onto the summary
		// call and pass for the wrong reason.
		mockGenerateObject.mockImplementation(async () =>
			mockGenerateObject.mock.calls.length === 1
				? first
				: mockGenerateObject.mock.calls.length <= TIER1_SKILLS.length
					? second
					: {
							object: { summary: "One issue." },
							usage: { inputTokens: 10, outputTokens: 5 },
						},
		);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			provider: "anthropic" as const,
		});

		expect(review?.comments).toHaveLength(1);
	});

	// REVIEWER_TUNING is unified across providers (ai-review-bot-5zu, 2026-08-09
	// — PR #44 showed codexreviewbot producing the same class of unfounded
	// findings anthropicreviewbot was fixed for), so openai now collapses
	// restated claims exactly like anthropic does above.
	it("collapses openai's restated claims the same as anthropic's", async () => {
		const { first, second } = restatementResponses();
		mockGenerateObject.mockImplementation(async () =>
			mockGenerateObject.mock.calls.length === 1
				? first
				: mockGenerateObject.mock.calls.length <= TIER1_SKILLS.length
					? second
					: {
							object: { summary: "One issue." },
							usage: { inputTokens: 10, outputTokens: 5 },
						},
		);

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			provider: "openai" as const,
		});

		expect(review?.comments).toHaveLength(1);
	});
});

describe("strict evidence rules propagation", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildAgentSystemPrompt.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	function cleanRun() {
		mockGenerateObject.mockImplementation(async () =>
			mockGenerateObject.mock.calls.length <= TIER1_SKILLS.length
				? buildGenerateObjectResponse(
						buildModelReview({
							event: "COMMENT",
							general_findings: [],
							inline_comments: [],
						}),
					)
				: {
						object: { summary: "Nothing." },
						usage: { inputTokens: 10, outputTokens: 5 },
					},
		);
	}

	// The gate is only worth having if it reaches the prompt builder. Asserting
	// on REVIEWER_TUNING alone would pass with the wiring cut. Both providers
	// get strictEvidenceRules=true since ai-review-bot-5zu unified the tuning
	// (PR #44 showed codexreviewbot needs the same protection anthropicreviewbot
	// does — see src/reviewer-tuning.ts).
	it.each([
		{ provider: "anthropic" as const },
		{ provider: "openai" as const },
	])("passes strictEvidenceRules=true for $provider", async ({ provider }) => {
		cleanRun();

		await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			provider,
		});

		for (const call of mockBuildAgentSystemPrompt.mock.calls) {
			expect(call[2]).toEqual({ strictEvidenceRules: true });
		}
		expect(mockBuildAgentSystemPrompt).toHaveBeenCalled();
	});
});

describe("prior own findings propagation", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildAgentSystemPrompt.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	async function seededKv(provider: "anthropic" | "openai" = "anthropic") {
		// A FULL recommendation keeps the agents running so the prompt is built;
		// the gate is not what this test is about.
		mockTriageReReview.mockResolvedValue({
			recommendation: "FULL",
			resolved: [],
			newRisk: true,
		});
		const { client } = fakeKv();
		await saveReviewState(
			client,
			provider,
			"joeblackwaslike",
			"ai-review-bot",
			1,
			{
				lastReviewedSha: "oldsha1234567",
				event: "REQUEST_CHANGES",
				findings: [
					{
						id: findingId("src/a.ts", 5, "bug"),
						path: "src/a.ts",
						line: 5,
						title: "bug",
						severity: "high",
						status: "open",
					},
				],
				reviewedAt: "2026-06-16T00:00:00Z",
			},
		);
		return client;
	}

	function cleanRun() {
		mockGenerateObject.mockImplementation(async () =>
			mockGenerateObject.mock.calls.length <= TIER1_SKILLS.length
				? buildGenerateObjectResponse(
						buildModelReview({
							event: "COMMENT",
							general_findings: [],
							inline_comments: [],
						}),
					)
				: {
						object: { summary: "Nothing." },
						usage: { inputTokens: 10, outputTokens: 5 },
					},
		);
	}

	// The third leg of the gate. Without this, the memory could be disconnected
	// from buildReview and both the buildUserMessage unit test and
	// REVIEWER_TUNING would still pass.
	it("gives a tuned reviewer its own prior findings", async () => {
		cleanRun();
		const client = await seededKv();

		await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			provider: "anthropic" as const,
			kv: client,
		});

		expect(mockBuildUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				priorOwnFindings: [
					expect.objectContaining({ path: "src/a.ts", line: 5, title: "bug" }),
				],
			}),
		);
	});

	// Seeded under "openai" deliberately: review state is namespaced by provider,
	// so seeding it under "anthropic" would leave this reviewer with no state at
	// all and the assertion would hold whether or not the gate existed. Both
	// providers get this now — REVIEWER_TUNING is unified (ai-review-bot-5zu) —
	// so this mirrors the anthropic case above rather than asserting withholding.
	it("gives openai the same treatment since tuning was unified", async () => {
		cleanRun();
		const client = await seededKv("openai");

		await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			provider: "openai" as const,
			kv: client,
		});

		expect(mockBuildUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				priorOwnFindings: [
					expect.objectContaining({ path: "src/a.ts", line: 5, title: "bug" }),
				],
			}),
		);
	});
});

describe("provenance across collapsed claims", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	// Two agents report one claim on different nearby lines. The dedupe keeps
	// one, and the skill recorded against the collapsed anchor has to travel to
	// the survivor — otherwise a bug found by two agents is credited to one, and
	// the per-skill trends undercount exactly what they exist to measure.
	it("credits every agent that found a claim to the surviving comment", async () => {
		const at = (line: number, title: string) =>
			buildGenerateObjectResponse(
				buildModelReview({
					event: "REQUEST_CHANGES",
					general_findings: [],
					inline_comments: [
						buildInlineComment({
							title,
							body: "why it matters",
							path: "src/x.ts",
							line,
						}),
					],
				}),
			);
		const empty = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);

		// Routed by skill path, not by call order: which agent reported which line
		// is the whole assertion, so a reordering of TIER1_SKILLS must not be able
		// to quietly swap the two and leave the test green.
		// Seeded from TIER1_SKILLS so the map cannot drift out of sync with the
		// production list, and an unrecognised skill is a routing failure rather
		// than a silent fall-through to `empty` — which would leave the test green
		// while exercising nothing.
		const bySkill: Record<string, ReturnType<typeof at>> = Object.fromEntries(
			TIER1_SKILLS.map((skillPath) => [skillPath, empty]),
		);
		bySkill["code-reviewer.md"] = at(
			10,
			"`body: f.title` duplicates the title instead of the finding body",
		);
		bySkill["silent-failure-hunter.md"] = at(
			12,
			"body field set to f.title — finding body duplicates the title",
		);
		mockGenerateObject.mockImplementation(
			async (call: {
				system?: string;
				messages: [{ content: string | [unknown, { text: string }] }];
			}) => {
				// generateSummary is the only call passing a `system` string. An agent
				// call instead carries the mocked buildAgentSystemPrompt return value
				// — tagged `system:<skillPath>` — as the second part of its user
				// message content (src/review.ts, runAgent).
				if (typeof call.system === "string") {
					return {
						object: { summary: "One issue." },
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				}
				const content = call.messages[0].content;
				const skill =
					typeof content === "string"
						? content
						: content[1].text.replace(/^system:/, "");
				const response = bySkill[skill];
				if (!response) {
					throw new Error(
						`agent call could not be routed to a skill: ${JSON.stringify(skill)}`,
					);
				}
				return response;
			},
		);

		const decision = await buildReview({
			octokit: buildOctokit({
				files: [buildPullFile("src/x.ts", TWENTY_LINE_PATCH)],
			}),
			...baseContext,
			provider: "anthropic" as const,
			feedbackEnabled: true,
		});

		expect(decision?.comments).toHaveLength(1);
		const survivor = decision?.comments[0];
		const prov = decision?.commentProvenance?.get(
			`${survivor?.path}:${survivor?.line}`,
		);
		expect(prov?.skills.sort()).toEqual([
			"code-reviewer.md",
			"silent-failure-hunter.md",
		]);
	});
});

describe("review body markdown", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		mockTriageReReview.mockReset();
	});

	// GitHub reads a paragraph followed by `---` as a setext H2 underline, not a
	// horizontal rule. The cost footer opens with `---`, so any section glued to
	// it renders the whole preceding paragraph at heading size — which is what
	// the reviews were doing: every line from the summary down to the review
	// marker was one <h2>.
	function setextUnderlinedLines(body: string): string[] {
		const lines = body.split("\n");
		return lines.filter(
			(line, i) => /^(-{3,}|={3,})\s*$/.test(lines[i + 1] ?? "") && line !== "",
		);
	}

	const emptyAgent = () =>
		buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);

	it("separates every section with a blank line so nothing renders as a heading", async () => {
		const agent = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [
					{ title: "Unvalidated input", body: "x", severity: "high" },
				],
				inline_comments: [
					buildInlineComment({ path: "src/review.ts", line: 2 }),
				],
			}),
		);
		mockGenerateObject
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce({
				object: { summary: "One issue." },
				usage: { inputTokens: 10, outputTokens: 5 },
			});

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(setextUnderlinedLines(review?.body ?? "")).toEqual([]);
	});

	// The regression case, and the only way to reach it: mergeReviews downgrades
	// REQUEST_CHANGES to COMMENT when nothing survived, so a blocking review with
	// an empty body comes solely from a prior finding carried across an
	// INCREMENTAL pass. Nothing then sits between the summary and the cost
	// footer, and the summary, inline count and review marker become one <h2>.
	async function incrementalWithOpenPrior() {
		const { client } = fakeKv();
		await saveReviewState(
			client,
			baseContext.provider,
			baseContext.owner,
			baseContext.repo,
			baseContext.pullNumber,
			{
				lastReviewedSha: "aaaaaaaaaaaa1111",
				event: "REQUEST_CHANGES",
				findings: [
					{
						id: findingId("src/a.ts", 5, "Unvalidated input"),
						path: "src/a.ts",
						line: 5,
						title: "Unvalidated input",
						severity: "high",
						status: "open",
					},
				],
				reviewedAt: "2026-06-17T00:00:00Z",
			},
		);
		vi.mocked(mockTriageReReview).mockResolvedValueOnce({
			recommendation: "INCREMENTAL",
			resolved: [],
			newRisk: false,
		});
		mockGenerateObject
			.mockResolvedValueOnce(emptyAgent())
			.mockResolvedValueOnce(emptyAgent())
			.mockResolvedValueOnce(emptyAgent())
			.mockResolvedValueOnce(emptyAgent())
			.mockResolvedValueOnce(emptyAgent())
			.mockResolvedValueOnce({
				object: { summary: "Nothing new since the last review." },
				usage: { inputTokens: 10, outputTokens: 5 },
			});

		return buildReview({
			octokit: buildOctokit({
				files: [buildPullFile("src/b.ts", SIMPLE_PATCH)],
			}),
			...baseContext,
			headSha: "bbbbbbbbbbbb2222",
			kv: client,
		});
	}

	// The activated-skills notice is a bullet list, and Markdown lazily continues
	// a list item across a bare newline. Without a blank line after it, the inline
	// count, the reaction instructions and the review marker were all absorbed
	// into the bullet — GitHub rendered them <br>-separated inside one <li>,
	// indented under "Additional skills activated" (ai-review-bot#47, reviews
	// 4834930088 and 4834932040).
	it("closes the activated-skills list before the sections that follow it", async () => {
		const agent = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [],
				inline_comments: [
					buildInlineComment({ path: "src/types.ts", line: 2 }),
				],
			}),
		);
		mockGenerateObject
			.mockResolvedValue(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce({
				object: { summary: "One issue." },
				usage: { inputTokens: 10, outputTokens: 5 },
			});

		const decision = await buildReview({
			octokit: buildOctokit({
				files: [buildPullFile("src/types.ts", TYPE_DEFINITION_PATCH)],
			}),
			...baseContext,
			tier2Enabled: true,
		});

		expect(decision?.metadata.tier2Skills.length).toBeGreaterThan(0);
		const lines = (decision?.body ?? "").split("\n");
		const lastBullet = lines.reduce(
			(last, line, i) => (line.startsWith("- `") ? i : last),
			-1,
		);
		expect(lastBullet).toBeGreaterThan(-1);
		expect(lines[lastBullet + 1]).toBe("");
	});

	// A count alone tells the author something was lost but not what, and an
	// unanchorable comment can still be the thing holding the review at
	// REQUEST_CHANGES. Naming the findings is the difference between a dead end
	// and something actionable.
	it("names the findings it could not anchor, not just how many", async () => {
		const agent = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [],
				inline_comments: [
					buildInlineComment({
						title: "Unvalidated path segment",
						severity: "high",
						path: "does/not/exist.ts",
						line: 2,
						start_line: null,
					}),
				],
			}),
		);
		mockGenerateObject
			.mockResolvedValue(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce({
				object: { summary: "One issue." },
				usage: { inputTokens: 10, outputTokens: 5 },
			});

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review?.comments).toHaveLength(0);
		expect(review?.body).toContain("Unvalidated path segment");
		expect(review?.body).toContain("`does/not/exist.ts:2`");
		expect(review?.body).toContain("🔴");
	});

	// Dropping every inline finding used to leave reviewComments empty, which is
	// what cleanDelta measured — so a COMMENT-level review whose only finding
	// could not be anchored approved the PR while printing that finding in the
	// body. What the agents found decides the verdict; what GitHub would accept
	// decides only where it is shown.
	it("does not approve when the only findings were the ones it could not anchor", async () => {
		const agent = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [
					buildInlineComment({
						title: "Unvalidated path segment",
						severity: "high",
						path: "does/not/exist.ts",
						line: 2,
						start_line: null,
					}),
				],
			}),
		);
		mockGenerateObject
			.mockResolvedValue(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce({
				object: { summary: "One issue." },
				usage: { inputTokens: 10, outputTokens: 5 },
			});

		const review = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
		});

		expect(review?.comments).toHaveLength(0);
		expect(review?.event).not.toBe("APPROVE");
	});

	// The carrier comment repeats this beneath the review, so whatever the review
	// wraps around the prose must not come with it. Handing it the whole body
	// gave the carrier two headings, a stray setext <h2>, and the reaction
	// instructions twice (#47, issue comment 5151948120).
	it("exposes the prose without the wrapper the body adds around it", async () => {
		const agent = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [
					{ title: "Unvalidated input", body: "x", severity: "high" },
				],
				inline_comments: [
					buildInlineComment({ path: "src/review.ts", line: 2 }),
				],
			}),
		);
		mockGenerateObject
			.mockResolvedValue(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce(agent)
			.mockResolvedValueOnce({
				object: { summary: "One issue worth a look." },
				usage: { inputTokens: 10, outputTokens: 5 },
			});

		const decision = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			feedbackEnabled: true,
		});

		expect(decision?.summary).toBe("One issue worth a look.");
		for (const wrapper of [
			"###",
			"*Model:",
			"Reviewed commit:",
			"React on any inline comment",
			"| Sev | Finding |",
		]) {
			expect(decision?.summary).not.toContain(wrapper);
		}
		// The body still carries all of it — only the carrier's copy is trimmed.
		expect(decision?.body).toContain("*Model:");
	});

	it("keeps the summary out of the heading when there is nothing to report", async () => {
		const review = await incrementalWithOpenPrior();

		expect(review?.event).toBe("REQUEST_CHANGES");
		expect(review?.body).toContain("Inline comments: none");
		expect(setextUnderlinedLines(review?.body ?? "")).toEqual([]);
	});

	// Blocking with no stated reason reads as a bot shouting for nothing. The
	// carried-over finding is why the review requests changes, so it has to be
	// on the review — the agents never saw its file this pass, so nothing else
	// puts it there.
	it("names the prior findings it is blocking on", async () => {
		const review = await incrementalWithOpenPrior();

		expect(review?.event).toBe("REQUEST_CHANGES");
		expect(review?.body).toContain("Unvalidated input");
		expect(review?.body).toContain("src/a.ts");
	});
});

describe("buildReview auth threading", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		vi.mocked(createAIModel).mockClear();
	});

	it("threads context.auth through to createAIModel for every Tier 1 agent and the summary model", async () => {
		const auth = {
			mode: "oauth" as const,
			provider: "anthropic" as const,
			token: "tok",
			baseURL: "https://api.example.test",
			headers: {},
			fetch: vi.fn() as unknown as typeof fetch,
		};
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [
					{ title: "Something", body: "needs work", severity: "high" },
				],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "Found an issue." },
			usage: { inputTokens: 50, outputTokens: 20 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(summaryResponse);

		await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			auth,
		});

		// 5 Tier 1 agent calls + 1 summary call, every one threaded with the same auth.
		expect(createAIModel).toHaveBeenCalledTimes(6);
		for (const call of vi.mocked(createAIModel).mock.calls) {
			expect(call[1]).toBe(auth);
		}
	});
});
