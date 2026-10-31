import { NoObjectGeneratedError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentRecord, parseAgentsMarker } from "./agent-log.js";
import { deriveBaseline } from "./baseline.js";
import type { KvClient } from "./feedback/kv.js";
import { computeCost, createAIModel } from "./models.js";
import {
	buildReview,
	buildReviewComments,
	buildValidLinesByPath,
	capPaceToDeadline,
	classifyRefusal,
	collectRightSideLines,
	computePaceDelayMs,
	computeReadinessScore,
	formatFindings,
	formatReviewBody,
	generateSummary,
	KNOWN_SKILLS,
	ModelReviewSchema,
	mergeReviews,
	mergeReviewsDetailed,
	parseRawDiff,
	parseReviewMetadata,
	renderReadinessBar,
	runAgent,
	SEVERITY_LEVELS,
	sanitizeInlineComments,
	severityBadge,
	TIER1_SKILLS,
} from "./review.js";
import type { PersistedFinding } from "./review-state.js";
import { findingId } from "./review-state.js";
import { type ModelSelection, reasoningProviderOptions } from "./router.js";
import {
	buildGenerateObjectResponse,
	buildInlineComment,
	buildModelReview,
	buildOwnReviewBody,
	buildPullFile,
	buildStrictOctokit,
	reviewedCommitMarker,
	reviewsResponse,
	SIMPLE_PATCH,
	TWO_HUNK_PATCH,
} from "./testing.js";

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockBuildUserMessage = vi.hoisted(() => vi.fn().mockReturnValue("user"));
const mockBuildAgentSystemPrompt = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
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

vi.mock("./prompt.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./prompt.js")>()),
	buildUserMessage: mockBuildUserMessage,
	trimPatch: (patch: string) => patch,
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
const mockRevalidateFindings = vi.hoisted(() =>
	vi.fn(async () => [] as string[]),
);
vi.mock("./triage.js", () => ({
	triageReReview: mockTriageReReview,
	fetchDeltaMeta: mockFetchDeltaMeta,
	revalidateFindings: mockRevalidateFindings,
	// Legacy exports kept so any direct import of fetchDelta/fetchDeltaFiles in
	// tests continues to resolve (unused by review.ts after the refactor).
	fetchDelta: vi.fn(async () => "delta"),
	fetchDeltaFiles: vi.fn(async () => []),
}));

// ---------------------------------------------------------------------------
// mergeReviews resolved handling
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SEVERITY_LEVELS / severityBadge
// ---------------------------------------------------------------------------

describe("severity scale", () => {
	it("SEVERITY_LEVELS tuple is P0–P3", () => {
		expect(SEVERITY_LEVELS).toEqual(["P0", "P1", "P2", "P3"]);
	});

	it("severityBadge maps P0 to 🔴 **P0**", () => {
		expect(severityBadge("P0")).toBe("🔴 **P0**");
	});

	it("severityBadge maps P1 to 🟠 **P1**", () => {
		expect(severityBadge("P1")).toBe("🟠 **P1**");
	});
});

describe("ModelReviewSchema validation", () => {
	it("ModelReviewSchema requires evidence to be non-empty", () => {
		const result = ModelReviewSchema.safeParse({
			event: "COMMENT",
			general_findings: [
				{
					title: "t",
					body: "b",
					severity: "P2",
					category: "bug",
					confidence: 0.9,
					evidence: "",
					suppressible: false,
				},
			],
			inline_comments: [],
		});
		expect(result.success).toBe(false);
	});

	it("ModelReviewSchema accepts a valid P0 finding", () => {
		const result = ModelReviewSchema.safeParse({
			event: "REQUEST_CHANGES",
			general_findings: [
				{
					title: "RCE",
					body: "details",
					severity: "P0",
					category: "security",
					confidence: 0.99,
					evidence: "src/auth.ts:42 — unsanitized input passed to exec()",
					suppressible: false,
				},
			],
			inline_comments: [],
		});
		expect(result.success).toBe(true);
	});
});

describe("mergeReviews resolved handling", () => {
	const reqChanges = {
		event: "REQUEST_CHANGES" as const,
		general_findings: [
			{
				title: "Unvalidated input",
				body: "x",
				severity: "P1" as const,
				category: "style" as const,
				confidence: 0.8,
				evidence: "See diff.",
				suppressible: true,
			},
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
			buildInlineComment({ line: 2, severity: "P1", title: "Race" }),
		]);

		expect(comments[0].body.startsWith("🟠 **P1**\n\n")).toBe(true);
		expect(comments[0].body).toContain("**Race**");
	});

	it("renders a low-severity badge for a comment without a suggestion", () => {
		const comments = buildReviewComments(files, [
			buildInlineComment({ line: 2, severity: "P3", suggestion: null }),
		]);

		expect(comments[0].body.startsWith("🟢 **P3**\n\n")).toBe(true);
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
	existingReviews?: Array<{ body: string; state?: string }>;
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
			.mockImplementation(async (route: string) =>
				route.endsWith("/reviews")
					? (overrides?.existingReviews ?? [])
					: (overrides?.files ?? [
							buildPullFile("src/review.ts", SIMPLE_PATCH),
						]),
			),
	};
}

const FILES_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/files";

/** The default PR file list plus src/a.ts: a carried finding on a file the PR
 * no longer contains is retired, so its file must be in the list. */
const filesWithA = () => [
	buildPullFile("src/review.ts", SIMPLE_PATCH),
	buildPullFile("src/a.ts", SIMPLE_PATCH),
];

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
						severity: "P1",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
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
					{
						title: "Something",
						body: "needs work",
						severity: "P1",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
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

	// Regression: sanitizeInlineComments clears an invalid start_line (0 or any
	// value not in the diff) and keeps the comment rather than dropping it.
	// The comment on a path not in the diff (condition 1) is still dropped.
	it("regression: salvages comment with bad start_line; drops comment on unknown path", async () => {
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [
					{
						title: "Security risk",
						body: "Details here.",
						severity: "P1",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
				],
				inline_comments: [
					buildInlineComment({
						path: "src/review.ts",
						line: 2,
						start_line: 0, // sanitizer clears → null; comment is kept
					}),
					buildInlineComment({
						path: "does/not/exist.ts",
						line: 2,
						start_line: null, // path not in diff → still dropped
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
		// src/review.ts:2 is valid; start_line:0 was sanitized away → 1 comment posted
		expect(review?.comments).toHaveLength(1);
		expect(review?.body).toContain("Inline comments: 1");
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
		expect(octokit.paginate).not.toHaveBeenCalledWith(
			FILES_ROUTE,
			expect.anything(),
		);
	});

	it("alreadyReviewed ignores a quoted sha and reads the real block", async () => {
		const headSha = "1234567890abcdef";
		const priorBody = [
			"### ai-review-bot",
			`> <!-- ai-review:sha=${headSha} -->`,
			"",
			"Prior review.",
			"",
			"<!-- ai-review:sha=ffffffffffff -->",
			"<!-- ai-review:review=1 -->",
			"<!-- ai-review:readiness=4 -->",
			"<!-- ai-review:provider=anthropic -->",
			"<!-- ai-review:model=m -->",
			"<!-- ai-review:findings=0 -->",
			"<!-- ai-review:cost=0.000100 -->",
			"",
			"---",
			"*Model: m · 5 agents · $0.000100*",
		].join("\n");
		const octokit = buildOctokit({ existingReviews: [{ body: priorBody }] });

		// Not skipped as already reviewed: it proceeds to the (unmocked) agents.
		await expect(
			buildReview({
				octokit,
				...baseContext,
				headSha,
				force: false,
			}),
		).rejects.toThrow("All review agents failed");
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
		expect(octokit.paginate).toHaveBeenCalledWith(
			FILES_ROUTE,
			expect.anything(),
		);
	});

	it("renders severity emoji table for general findings", async () => {
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				general_findings: [
					{
						title: "Critical bug",
						body: "Details.",
						severity: "P1",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
					{
						title: "Minor style nit",
						body: "Details.",
						severity: "P3",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
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
			octokit: buildOctokit({
				existingReviews: [{ body: priorBody, state: "CHANGES_REQUESTED" }],
			}),
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
					{
						title: "Minor nit",
						body: "Fix this.",
						severity: "P3",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
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

	it("buildReview body includes the metadata block with sha and readiness", async () => {
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({ event: "REQUEST_CHANGES" }),
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
		expect(review?.body).toContain("<!-- ai-review:sha=");
		expect(review?.body).toContain("<!-- ai-review:readiness=");
		expect(review?.body).toContain("> Re-run: `/ai-review`");
		expect(review?.body).not.toContain("Reviewed commit: `");
	});

	it("readiness score is 1 when a prior P0 survives but no new P0 is emitted", async () => {
		mockTriageReReview.mockResolvedValueOnce({
			recommendation: "FULL",
			resolved: [],
			newRisk: false,
		});
		const oldSha = "0dd5a1111111";
		const newSha = "eee5a2222222";
		const priorBody = buildOwnReviewBody({
			sha: oldSha,
			count: 1,
			rows: ["| 🔴 | **critical bug** (`src/a.ts:10`) |"],
		});

		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "No new findings." },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		for (let i = 0; i < 5; i++)
			mockGenerateObject.mockResolvedValueOnce(agentResponse);
		mockGenerateObject.mockResolvedValueOnce(summaryResponse);

		const review = await buildReview({
			octokit: buildOctokit({
				existingReviews: [{ body: priorBody }],
				files: filesWithA(),
			}),
			...baseContext,
			headSha: newSha,
		});

		expect(review?.body).toContain("**critical bug** (`src/a.ts:10`)");
		expect(review?.body).toContain("<!-- ai-review:readiness=1 -->");
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
	model: "claude-sonnet-5-5",
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

	it("forwards the abort signal to generateObject", async () => {
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
		const abortSignal = new AbortController().signal;

		await runAgent("code-reviewer.md", "SHARED", sel, "", { abortSignal });

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(call.abortSignal).toBe(abortSignal);
	});

	it("reports an agent cut off by its abort signal as skipped, not errored", async () => {
		const controller = new AbortController();
		controller.abort();
		mockGenerateObject.mockRejectedValue(
			new DOMException("This operation was aborted", "AbortError"),
		);

		const out = await runAgent("code-reviewer.md", "SHARED", sel, "", {
			abortSignal: controller.signal,
		});

		expect(out).toEqual({ status: "skipped", skillPath: "code-reviewer.md" });
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
			model: "gpt-6.1-sol",
			effort: "low",
		} as ModelSelection;

		await runAgent("code-reviewer.md", "SHARED", openaiSel, "");

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		// gpt-6.1-sol spends reasoning tokens from this budget — it must dwarf the 4096
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
			model: "claude-opus-5-5",
			tier: 4,
			effort: "xhigh",
		} as ModelSelection;

		await runAgent("code-reviewer.md", "SHARED", opusSel, "");

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(call.providerOptions.anthropic).toEqual({
			effort: "xhigh",
			fallbacks: "default",
		});
		expect(call.maxOutputTokens).toBe(32768);
	});

	// Opus/Sonnet 5.5 safety classifiers can decline security-heavy diffs
	// (`cyber`); server-side fallbacks rerun the request instead of losing the
	// agent. Haiku 5.5 has no server-side fallback, so it must not send one.
	it("requests refusal fallbacks for Sonnet 5.5 but not Haiku 5.5", () => {
		expect(
			reasoningProviderOptions({
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				effort: "medium",
			}),
		).toEqual({ anthropic: { effort: "medium", fallbacks: "default" } });
		expect(
			reasoningProviderOptions({
				provider: "anthropic",
				model: "claude-haiku-5-5",
				effort: "low",
			}),
		).toEqual({ anthropic: { effort: "low" } });
	});

	// Every current Claude model thinks by default, so an unset effort still
	// bills thinking tokens against the cap — only an explicit "none" is safe.
	it("sizes the output budget for reasoning when effort is unset", async () => {
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
		expect(call.maxOutputTokens).toBe(32768);
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
			model: "gpt-6-luna",
			effort: "none",
		} as ModelSelection;

		await runAgent("code-reviewer.md", "SHARED", trivialOpenAiSel, "");

		const call = (mockGenerateObject as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		// "none" is a truthy string but disables reasoning — the budget must stay
		// at the base (no inflation), and "none" is forwarded as gpt-6-luna's
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
			model: "gpt-6.1-sol",
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

	it("floors the generateSummary budget for an unset effort and omits providerOptions for Haiku", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { summary: "No findings." },
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		const haikuSel = {
			provider: "anthropic",
			model: "claude-haiku-5-5",
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
		expect(call.maxOutputTokens).toBe(16000);
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
			model: "claude-haiku-5-5",
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
				severity: "P2",
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

describe("capPaceToDeadline", () => {
	it("leaves a delay that fits before the deadline alone", () => {
		expect(capPaceToDeadline(30_000, 1_000, 100_000)).toBe(30_000);
	});

	it("shortens a delay that would run past the deadline", () => {
		expect(capPaceToDeadline(60_000, 1_000, 21_000)).toBe(20_000);
	});

	it("returns 0 once the deadline has passed so no agent sleeps after it", () => {
		expect(capPaceToDeadline(60_000, 50_000, 50_000)).toBe(0);
		expect(capPaceToDeadline(60_000, 60_000, 50_000)).toBe(0);
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

/** The check-run POSTs a buildOctokit fake received. */
function postedCheckRuns(octokit: ReturnType<typeof buildOctokit>) {
	return octokit.request.mock.calls
		.filter(([route]) => route === "POST /repos/{owner}/{repo}/check-runs")
		.map(([, params]) => params as Record<string, unknown>);
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

		const headSha = "eee5a0987654321";

		// The prior own review at an OLDER head lists the open finding with its
		// anchor; deriveBaseline gives it id findingId(path, line, title), so the
		// gate's resolve-key derivation matches.
		const octokit = buildOctokit({
			existingReviews: [
				{
					body: buildOwnReviewBody({
						sha: "0dd5a1234567",
						count: 1,
						rows: ["| 🟠 | **bug** (`src/a.ts:5`) |"],
					}),
				},
			],
			files: filesWithA(),
		});
		const decision = await buildReview({ octokit, ...baseContext, headSha });

		// SKIP posts nothing.
		expect(decision).toBeNull();
		// No agents ran — generateObject was never invoked.
		expect(mockGenerateObject).not.toHaveBeenCalled();
		// The resolved finding no longer blocks, so the check-run carries APPROVE.
		expect(postedCheckRuns(octokit)).toEqual([
			expect.objectContaining({ head_sha: headSha, conclusion: "success" }),
		]);
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
		const sha1 = "aaaaaaaaaaaa1111";
		const sha2 = "bbbbbbbbbbbb2222";

		const existingReviews = [
			{
				state: "CHANGES_REQUESTED",
				body: buildOwnReviewBody({ sha: sha1, count: 1 }),
			},
		];

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
				existingReviews,
				files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
			}),
			...baseContext,
			headSha: sha2,
		});

		// Must NOT return null (which SKIP would cause); a full review was posted.
		expect(mockFetchDeltaMeta).toHaveBeenCalledTimes(1);
		expect(result).not.toBeNull();
		expect(result?.body).toContain("scope: full (compare truncated)");
	});

	it("ignores INCREMENTAL from triage and runs a FULL review when compare is truncated", async () => {
		const sha1 = "aaaaaaaaaaaa1111";
		const sha2 = "bbbbbbbbbbbb2222";

		const existingReviews = [
			{
				state: "CHANGES_REQUESTED",
				body: buildOwnReviewBody({ sha: sha1, count: 1 }),
			},
		];

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
			octokit: buildOctokit({ existingReviews, files: [fullFile] }),
			...baseContext,
			headSha: sha2,
		});

		// A real review (not null) was posted — INCREMENTAL was not taken.
		expect(mockFetchDeltaMeta).toHaveBeenCalledTimes(1);
		expect(result).not.toBeNull();
		expect(result?.body).toContain("scope: full (compare truncated)");
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
		// Prior open finding F on file A, listed by the own review at sha1.
		const sha1 = "aaaaaaaaaaaa1111";
		const priorBody = buildOwnReviewBody({
			sha: sha1,
			count: 1,
			rows: ["| 🟠 | **Bug** (`src/a.ts:5`) |"],
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
				existingReviews: [{ body: priorBody }],
				files: [
					buildPullFile("src/a.ts", SIMPLE_PATCH),
					buildPullFile("src/b.ts", SIMPLE_PATCH),
				],
			}),
			...baseContext,
			headSha: sha2,
		});

		// (a) An unresolved prior blocking finding remains → must NOT be APPROVE.
		expect(r2?.event).not.toBe("APPROVE");
		expect(r2?.event).toBe("REQUEST_CHANGES");

		// (b) The posted body still lists F as open and carries the new head, so
		// the next round's baseline reads it back.
		expect(r2?.body).toContain("reviewed only what changed since");
		expect(r2?.body).toContain("| 🟠 | **Bug** (`src/a.ts:5`) |");
		expect(r2?.body).toContain(`<!-- ai-review:sha=${sha2} -->`);
		expect(r2?.body).toContain("<!-- ai-review:review=2 -->");
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
		// Prior open finding F, listed by the own review at sha1.
		const sha1 = "aaaaaaaaaaaa1111";
		const priorBody = buildOwnReviewBody({
			sha: sha1,
			count: 1,
			rows: ["| 🟠 | **Bug** (`src/a.ts:5`) |"],
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
				existingReviews: [{ body: priorBody }],
				files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
			}),
			...baseContext,
			headSha: sha2,
		});

		// (a) An unresolved prior blocking finding remains → must NOT be APPROVE.
		expect(r2?.event).not.toBe("APPROVE");
		expect(r2?.event).toBe("REQUEST_CHANGES");

		// (b) The body uses the FULL-pass wording, not the INCREMENTAL one — proves
		// this went through the "agents saw it and were told not to restate it"
		// path, not a swapped/broken string that happened to still read fine.
		expect(r2?.body).toContain("flagged in a previous review");
		expect(r2?.body).not.toContain("reviewed only what changed since");

		// (c) The posted body still lists F as open and carries the new head.
		expect(r2?.body).toContain("| 🟠 | **Bug** (`src/a.ts:5`) |");
		expect(r2?.body).toContain(`<!-- ai-review:sha=${sha2} -->`);
		expect(r2?.body).toContain("<!-- ai-review:review=2 -->");

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
	// #61: a finding resolved in an earlier round must not be fed to
	// generateSummary as "confirmed resolved this round", or a finding resolved
	// two rounds ago and then reintroduced would be declared freshly fixed even
	// while this round's own findings re-flag it. On GitHub the older review
	// still lists it; the latest one, the baseline source, does not.
	it("excludes findings resolved in an earlier round from THIS round's 'confirmed resolved' grounding", async () => {
		const sha0 = "bbbbbbbbbbbb2222";
		const sha1 = "cccccccccccc3333";
		const existingReviews = [
			{
				body: buildOwnReviewBody({
					sha: sha0,
					count: 1,
					rows: [
						"| 🟠 | **Bug** (`src/a.ts:5`) |",
						"| 🟡 | **Old bug fixed two rounds ago** (`src/a.ts:9`) |",
					],
				}),
			},
			{
				body: buildOwnReviewBody({
					sha: sha1,
					count: 2,
					rows: ["| 🟠 | **Bug** (`src/a.ts:5`) |"],
				}),
			},
		];

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
				existingReviews,
				files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
			}),
			...baseContext,
			headSha: sha2,
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

// ---------------------------------------------------------------------------
// parseRawDiff
// ---------------------------------------------------------------------------

describe("parseRawDiff", () => {
	const RAW_DIFF = [
		"diff --git a/src/foo.ts b/src/foo.ts",
		"index abc..def 100644",
		"--- a/src/foo.ts",
		"+++ b/src/foo.ts",
		"@@ -1,3 +1,4 @@",
		" unchanged",
		"+added",
		" unchanged2",
		"-removed",
		"diff --git a/src/bar.ts b/src/bar.ts",
		"index 111..222 100644",
		"--- a/src/bar.ts",
		"+++ b/src/bar.ts",
		"@@ -5,2 +5,3 @@",
		" context",
		"+new line",
	].join("\n");

	it("parses patches for all files in a unified diff", () => {
		const map = parseRawDiff(RAW_DIFF);
		expect(map.size).toBe(2);
		expect(map.has("src/foo.ts")).toBe(true);
		expect(map.has("src/bar.ts")).toBe(true);
	});

	it("patch content starts at the first @@ hunk header", () => {
		const map = parseRawDiff(RAW_DIFF);
		const fooPatch = map.get("src/foo.ts");
		expect(fooPatch).toBeDefined();
		expect(fooPatch).toMatch(/^@@ -1,3/);
		expect(fooPatch).not.toContain("diff --git");
	});

	it("returns an empty map for an empty string", () => {
		expect(parseRawDiff("").size).toBe(0);
	});

	it("skips blocks with no @@ hunk (e.g. binary files)", () => {
		const binaryDiff = [
			"diff --git a/img.png b/img.png",
			"index abc..def 100644",
			"Binary files a/img.png and b/img.png differ",
		].join("\n");
		expect(parseRawDiff(binaryDiff).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// sanitizeInlineComments
// ---------------------------------------------------------------------------

describe("sanitizeInlineComments", () => {
	const patch = SIMPLE_PATCH; // has valid lines 1, 2, 3, 4 (etc.)
	const files = [buildPullFile("src/file.ts", patch)];

	it("leaves a valid comment unchanged", () => {
		const validLines = buildValidLinesByPath(files);
		const comment = buildInlineComment({
			path: "src/file.ts",
			line: 2,
			start_line: null,
		});
		const [out] = sanitizeInlineComments([comment], validLines);
		expect(out).toBe(comment); // same reference — no copy made
	});

	it("fuzzy-adjusts line to nearest valid line within ±5", () => {
		// Build a file where only line 3 is valid so we can test adjustment
		const sparsePatch = "@@ -10,1 +3,1 @@\n+only this line\n";
		const sparseFiles = [buildPullFile("src/file.ts", sparsePatch)];
		const validLines = buildValidLinesByPath(sparseFiles);
		const comment = buildInlineComment({
			path: "src/file.ts",
			line: 5,
			start_line: null,
		});
		const [out] = sanitizeInlineComments([comment], validLines);
		expect(out.line).toBe(3);
	});

	it("does not adjust line when the nearest valid line is beyond ±5", () => {
		const sparsePatch = "@@ -100,1 +100,1 @@\n+far away\n";
		const sparseFiles = [buildPullFile("src/file.ts", sparsePatch)];
		const validLines = buildValidLinesByPath(sparseFiles);
		const comment = buildInlineComment({
			path: "src/file.ts",
			line: 5,
			start_line: null,
		});
		const [out] = sanitizeInlineComments([comment], validLines);
		expect(out.line).toBe(5); // unchanged — no valid line within ±5
	});

	it("clears start_line when start_line >= line (backwards range)", () => {
		const validLines = buildValidLinesByPath(files);
		const comment = buildInlineComment({
			path: "src/file.ts",
			line: 2,
			start_line: 3,
		});
		const [out] = sanitizeInlineComments([comment], validLines);
		expect(out.start_line).toBeNull();
		expect(out.line).toBe(2);
	});

	it("clears start_line: 0 (not in diff, also backwards)", () => {
		const validLines = buildValidLinesByPath(files);
		const comment = buildInlineComment({
			path: "src/file.ts",
			line: 2,
			start_line: 0,
		});
		const [out] = sanitizeInlineComments([comment], validLines);
		expect(out.start_line).toBeNull();
		expect(out.line).toBe(2);
	});

	it("clears start_line when it is not in the valid set", () => {
		const validLines = buildValidLinesByPath(files);
		const comment = buildInlineComment({
			path: "src/file.ts",
			line: 3,
			start_line: 99,
		});
		const [out] = sanitizeInlineComments([comment], validLines);
		expect(out.start_line).toBeNull();
	});

	it("returns the original comment unchanged when the path is not in the diff", () => {
		const validLines = buildValidLinesByPath(files);
		const comment = buildInlineComment({
			path: "src/unknown.ts",
			line: 2,
			start_line: null,
		});
		const [out] = sanitizeInlineComments([comment], validLines);
		expect(out).toBe(comment);
	});
});

// ---------------------------------------------------------------------------
// mergeReviewsDetailed — key collision and cross-category dedup
// ---------------------------------------------------------------------------

describe("mergeReviewsDetailed — key collision", () => {
	it("concatenates distinct bodies from two agents at the same path:line", () => {
		const r1 = buildModelReview({
			event: "COMMENT",
			inline_comments: [
				buildInlineComment({
					path: "src/a.ts",
					line: 1,
					title: "Bug A",
					body: "First body.",
				}),
			],
		});
		const r2 = buildModelReview({
			event: "REQUEST_CHANGES",
			inline_comments: [
				buildInlineComment({
					path: "src/a.ts",
					line: 1,
					title: "Bug B",
					body: "Second body.",
				}),
			],
		});
		const { review } = mergeReviewsDetailed([r1, r2]);
		expect(review.inline_comments).toHaveLength(1);
		expect(review.inline_comments[0].body).toContain("First body.");
		expect(review.inline_comments[0].body).toContain("Second body.");
	});

	it("deduplicates near-duplicate bodies at the same path:line", () => {
		const r1 = buildModelReview({
			event: "COMMENT",
			inline_comments: [
				buildInlineComment({
					path: "src/a.ts",
					line: 1,
					title: "Missing null check",
					body: "Add null check.",
				}),
			],
		});
		const r2 = buildModelReview({
			event: "COMMENT",
			inline_comments: [
				buildInlineComment({
					path: "src/a.ts",
					line: 1,
					title: "Missing null check",
					body: "Add null check.",
				}),
			],
		});
		const { review } = mergeReviewsDetailed([r1, r2]);
		expect(review.inline_comments).toHaveLength(1);
		// Body should not be duplicated
		expect(review.inline_comments[0].body).not.toContain("---");
	});
});

describe("mergeReviewsDetailed — cross-category dedup", () => {
	it("drops a general_finding that is a near-duplicate of a surviving inline comment", () => {
		const r1 = buildModelReview({
			event: "REQUEST_CHANGES",
			general_findings: [
				{
					title: "Missing null check in parseUser",
					body: "Add null check.",
					severity: "P1",
					category: "style",
					confidence: 0.8,
					evidence: "See diff.",
					suppressible: true,
				},
			],
			inline_comments: [
				buildInlineComment({
					path: "src/a.ts",
					line: 1,
					title: "Missing null check in parseUser",
					body: "Add null check.",
				}),
			],
		});
		const { review } = mergeReviewsDetailed([r1], new Set(), {
			dedupeNearDuplicateClaims: true,
		});
		expect(review.inline_comments).toHaveLength(1);
		expect(review.general_findings).toHaveLength(0);
	});

	it("keeps a general_finding that is genuinely different from the inline comments", () => {
		const r1 = buildModelReview({
			event: "REQUEST_CHANGES",
			general_findings: [
				{
					title: "No integration tests for the auth flow",
					body: "Add tests.",
					severity: "P2",
					category: "style",
					confidence: 0.8,
					evidence: "See diff.",
					suppressible: true,
				},
			],
			inline_comments: [
				buildInlineComment({
					path: "src/a.ts",
					line: 1,
					title: "Missing null check",
					body: "Null guard needed.",
				}),
			],
		});
		const { review } = mergeReviewsDetailed([r1], new Set(), {
			dedupeNearDuplicateClaims: true,
		});
		expect(review.inline_comments).toHaveLength(1);
		expect(review.general_findings).toHaveLength(1);
	});
});

describe("mergeReviewsDetailed — findings that say there is no defect", () => {
	const finding = (title: string, body: string) => ({
		title,
		body,
		severity: "P3" as const,
		category: "style" as const,
		confidence: 0.8,
		evidence: "See diff.",
		suppressible: true,
	});
	const RETRACT = "The slot is held while waiting. No actionable defect found.";

	it("keeps a finding that ends with a retraction phrase and leaves the event alone", () => {
		const review = buildModelReview({
			event: "REQUEST_CHANGES",
			general_findings: [finding("Slot accounting", RETRACT)],
			inline_comments: [
				buildInlineComment({ title: "Boundary", body: RETRACT }),
			],
		});
		const out = mergeReviewsDetailed([review], new Set(), {
			dedupeNearDuplicateClaims: true,
		});
		expect(out.review.event).toBe("REQUEST_CHANGES");
		expect(out.review.general_findings.map((f) => f.title)).toEqual([
			"Slot accounting",
		]);
		expect(out.review.inline_comments.map((c) => c.title)).toEqual([
			"Boundary",
		]);
	});

	it("keeps REQUEST_CHANGES from an agent that filed no findings", () => {
		const blocker = buildModelReview({ event: "REQUEST_CHANGES" });
		const other = buildModelReview({
			event: "COMMENT",
			general_findings: [
				finding("Real general issue", "A 429 aborts the run."),
			],
		});
		const out = mergeReviewsDetailed([blocker, other]);
		expect(out.review.event).toBe("REQUEST_CHANGES");
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
					{
						title: "Found by agent one",
						body: "real",
						severity: "P1",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
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
				general_findings: [
					{
						title: "Found",
						body: "real",
						severity: "P1",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
				],
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

describe("retraction phrases are not filtered", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildAgentSystemPrompt.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	it("posts a finding that ends with a retraction phrase through buildReview", async () => {
		mockGenerateObject.mockImplementation(async () =>
			mockGenerateObject.mock.calls.length <= TIER1_SKILLS.length
				? buildGenerateObjectResponse(
						buildModelReview({
							event: "COMMENT",
							general_findings: [
								{
									title: "Slot accounting",
									body: "The slot is held while waiting. No actionable defect found.",
									severity: "P3",
									category: "style",
									confidence: 0.8,
									evidence: "See diff.",
									suppressible: true,
								},
							],
						}),
					)
				: {
						object: { summary: "Nothing." },
						usage: { inputTokens: 10, outputTokens: 5 },
					},
		);

		const result = await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			provider: "anthropic" as const,
		});

		expect(result?.event).toBe("COMMENT");
		expect(result?.body ?? "").toContain("Slot accounting");
	});
});

describe("prior own findings propagation", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildAgentSystemPrompt.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	/** The latest own review (under `prefix`) lists one open finding at an older
	 * head. A FULL recommendation keeps the agents running so the prompt is
	 * built; the gate is not what this test is about. */
	function priorOwnReviews(prefix = "ai-review-bot") {
		mockTriageReReview.mockResolvedValue({
			recommendation: "FULL",
			resolved: [],
			newRisk: true,
		});
		return [
			{
				body: buildOwnReviewBody({
					prefix,
					sha: "0dd5a1234567",
					count: 1,
					rows: ["| 🟠 | **bug** (`src/a.ts:5`) |"],
				}),
			},
		];
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

		await buildReview({
			octokit: buildOctokit({
				existingReviews: priorOwnReviews(),
				files: filesWithA(),
			}),
			...baseContext,
			provider: "anthropic" as const,
		});

		expect(mockBuildUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				priorOwnFindings: [
					expect.objectContaining({ path: "src/a.ts", line: 5, title: "bug" }),
				],
			}),
		);
	});

	// Seeded under the openai bot's own heading deliberately: a bot's review
	// state is its own reviews, so a review under the anthropic heading would
	// leave this reviewer with no baseline at all and the assertion would hold
	// whether or not the gate existed. Both providers get this now —
	// REVIEWER_TUNING is unified (ai-review-bot-5zu) — so this mirrors the
	// anthropic case above rather than asserting withholding.
	it("gives openai the same treatment since tuning was unified", async () => {
		cleanRun();

		await buildReview({
			octokit: buildOctokit({
				existingReviews: priorOwnReviews("codex-review-bot"),
				files: filesWithA(),
			}),
			...baseContext,
			commentPrefix: "codex-review-bot",
			provider: "openai" as const,
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
					{
						title: "Unvalidated input",
						body: "x",
						severity: "P1",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
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
		const priorBody = buildOwnReviewBody({
			sha: "aaaaaaaaaaaa1111",
			count: 1,
			rows: ["| 🟠 | **Unvalidated input** (`src/a.ts:5`) |"],
		});
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
				existingReviews: [{ body: priorBody }],
				files: [
					buildPullFile("src/a.ts", SIMPLE_PATCH),
					buildPullFile("src/b.ts", SIMPLE_PATCH),
				],
			}),
			...baseContext,
			headSha: "bbbbbbbbbbbb2222",
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
						severity: "P1",
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
		expect(review?.body).toContain("🟠");
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
						severity: "P1",
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
					{
						title: "Unvalidated input",
						body: "x",
						severity: "P1",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
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
					{
						title: "Something",
						body: "needs work",
						severity: "P1",
						category: "style",
						confidence: 0.8,
						evidence: "See diff.",
						suppressible: true,
					},
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

	// ai-review watch resolves real OAuth auth and calls maybeSubmitReview with
	// it, which flows into buildReview's context.auth. GPT-5.6 is confirmed
	// available on both the OAuth/subscription and API-key backends, so this
	// must resolve to the same model as the no-auth (hosted webhook) case
	// below — unlike the retired gpt-5.1/gpt-5.4 split this replaced.
	it("routes openai agent calls to gpt-6.1-sol when context.auth.mode is oauth", async () => {
		const auth = {
			mode: "oauth" as const,
			provider: "openai" as const,
			token: "tok",
			baseURL: "https://api.example.test",
			headers: {},
			fetch: vi.fn() as unknown as typeof fetch,
		};
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "Looks good." },
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
			provider: "openai",
			auth,
		});

		const agentCalls = vi
			.mocked(createAIModel)
			.mock.calls.filter((call) => call[0].provider === "openai");
		expect(agentCalls.length).toBeGreaterThan(0);
		for (const call of agentCalls) {
			expect(call[0].model).toBe("gpt-6.1-sol");
		}
	});

	// The hosted webhook path never sets context.auth, and `ai-review audit`'s
	// runAuditPass callers likewise have no auth in scope — both resolve to
	// the same GPT-5.6 tier as the OAuth case above, since auth mode no longer
	// changes model selection.
	it("routes openai agent calls to gpt-6.1-sol when context.auth is absent (hosted webhook default)", async () => {
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "Looks good." },
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
			provider: "openai",
		});

		const agentCalls = vi
			.mocked(createAIModel)
			.mock.calls.filter((call) => call[0].provider === "openai");
		expect(agentCalls.length).toBeGreaterThan(0);
		for (const call of agentCalls) {
			expect(call[0].model).toBe("gpt-6.1-sol");
		}
	});
});

describe("formatFindings", () => {
	it("returns empty string when no findings", () => {
		expect(formatFindings([])).toBe("");
	});

	it("renders a three-column table with Category column", () => {
		const findings = [
			{
				title: "Unsanitized input",
				body: "Details.",
				severity: "P1" as const,
				category: "security" as const,
				confidence: 0.9,
				evidence: "src/api.ts:5",
				suppressible: false,
			},
			{
				title: "Long variable name",
				body: "Rename it.",
				severity: "P3" as const,
				category: "style" as const,
				confidence: 0.7,
				evidence: "src/utils.ts:10",
				suppressible: true,
			},
		];
		const result = formatFindings(findings);
		expect(result).toContain("| Sev | Category | Finding |");
		expect(result).toContain("|---|---|---|");
		expect(result).toContain("security");
		expect(result).toContain("style");
		expect(result).toContain("🟠");
		expect(result).toContain("🟢");
		expect(result).toContain("**Unsanitized input**");
		expect(result).toContain("**Long variable name**");
	});
});

describe("computeReadinessScore", () => {
	it("returns 5 for APPROVE event", () => {
		expect(
			computeReadinessScore({
				event: "APPROVE",
				hasP0: false,
				survivingPrior: [],
				partial: false,
			}),
		).toBe(5);
	});

	it("returns 1 when P0 finding present", () => {
		expect(
			computeReadinessScore({
				event: "REQUEST_CHANGES",
				hasP0: true,
				survivingPrior: [],
				partial: false,
			}),
		).toBe(1);
	});

	it("returns 2 when surviving prior findings exist", () => {
		expect(
			computeReadinessScore({
				event: "REQUEST_CHANGES",
				hasP0: false,
				survivingPrior: ["finding-1"],
				partial: false,
			}),
		).toBe(2);
	});

	it("returns 3 for REQUEST_CHANGES with no P0 and no prior", () => {
		expect(
			computeReadinessScore({
				event: "REQUEST_CHANGES",
				hasP0: false,
				survivingPrior: [],
				partial: false,
			}),
		).toBe(3);
	});

	it("returns 4 for COMMENT with all agents completing", () => {
		expect(
			computeReadinessScore({
				event: "COMMENT",
				hasP0: false,
				survivingPrior: [],
				partial: false,
			}),
		).toBe(4);
	});

	it("returns 3 for COMMENT with partial review", () => {
		expect(
			computeReadinessScore({
				event: "COMMENT",
				hasP0: false,
				survivingPrior: [],
				partial: true,
			}),
		).toBe(3);
	});
});

describe("renderReadinessBar", () => {
	it("renders 5 filled for score 5", () => {
		expect(renderReadinessBar(5)).toBe("🟩🟩🟩🟩🟩 **5/5**");
	});

	it("renders 1 filled 4 empty for score 1", () => {
		expect(renderReadinessBar(1)).toBe("🟩⬜⬜⬜⬜ **1/5**");
	});

	it("renders 3 filled 2 empty for score 3", () => {
		expect(renderReadinessBar(3)).toBe("🟩🟩🟩⬜⬜ **3/5**");
	});
});

describe("parseReviewMetadata", () => {
	it("returns null for body with no metadata comment", () => {
		expect(parseReviewMetadata("No metadata here")).toBeNull();
	});

	it("returns null if any required field is missing", () => {
		const body = [
			"<!-- ai-review:sha=abc123 -->",
			"<!-- ai-review:review=1 -->",
			"<!-- ai-review:readiness=4 -->",
			"<!-- ai-review:provider=anthropic -->",
			"<!-- ai-review:model=claude-sonnet-4-6 -->",
			"<!-- ai-review:findings=3 -->",
		].join("\n");
		expect(parseReviewMetadata(body)).toBeNull();
	});

	it("parses all required fields when present", () => {
		const body = [
			"<!-- ai-review:sha=abc1234567890 -->",
			"<!-- ai-review:review=2 -->",
			"<!-- ai-review:readiness=4 -->",
			"<!-- ai-review:provider=anthropic -->",
			"<!-- ai-review:model=claude-sonnet-4-6 -->",
			"<!-- ai-review:findings=5 -->",
			"<!-- ai-review:cost=0.0123 -->",
		].join("\n");
		const result = parseReviewMetadata(body);
		expect(result).not.toBeNull();
		expect(result?.sha).toBe("abc1234567890");
		expect(result?.review).toBe(2);
		expect(result?.readiness).toBe(4);
		expect(result?.provider).toBe("anthropic");
		expect(result?.model).toBe("claude-sonnet-4-6");
		expect(result?.findings).toBe(5);
		expect(result?.cost).toBeCloseTo(0.0123);
	});
});

describe("formatReviewBody", () => {
	const baseOpts = {
		commentPrefix: "Claude Review",
		finalEvent: "REQUEST_CHANGES" as const,
		summary: "Two issues found.",
		approvalMessage: "",
		readiness: 3,
		tier2Matches: [] as { skillPath: string; reason: string }[],
		skipped: [] as string[],
		agentRecords: [] as AgentRecord[],
		pending: [] as string[],
		retrySkipped: [] as string[],
		allSkillsCount: 5,
		generalFindings: [] as Parameters<
			typeof formatReviewBody
		>[0]["generalFindings"],
		reviewComments: [] as Parameters<
			typeof formatReviewBody
		>[0]["reviewComments"],
		dropped: [] as Parameters<typeof formatReviewBody>[0]["dropped"],
		overflowCount: 0,
		maxInlineComments: 50,
		feedbackEnabled: false,
		survivingPrior: [] as Parameters<
			typeof formatReviewBody
		>[0]["survivingPrior"],
		incrementalPass: false,
		priorSha: "",
		headSha: "abc123def456",
		reviewCount: 2,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		cost: 0.000042,
	};

	it("starts with the commentPrefix heading", () => {
		const body = formatReviewBody(baseOpts);
		expect(body.startsWith("### Claude Review")).toBe(true);
	});

	it("includes the readiness bar", () => {
		const body = formatReviewBody(baseOpts);
		expect(body).toContain("🟩🟩🟩⬜⬜ **3/5**");
	});

	it("includes command hints", () => {
		const body = formatReviewBody(baseOpts);
		expect(body).toContain("/ai-review");
		expect(body).toContain("/ai-review --full");
	});

	it("includes hidden metadata block with sha and reviewCount", () => {
		const body = formatReviewBody(baseOpts);
		expect(body).toContain("<!-- ai-review:sha=abc123def456 -->");
		expect(body).toContain("<!-- ai-review:review=2 -->");
		expect(body).toContain("<!-- ai-review:readiness=3 -->");
		expect(body).toContain("<!-- ai-review:provider=anthropic -->");
	});

	it("roundtrips through parseReviewMetadata", () => {
		const body = formatReviewBody(baseOpts);
		const meta = parseReviewMetadata(body);
		expect(meta?.sha).toBe("abc123def456");
		expect(meta?.review).toBe(2);
		expect(meta?.readiness).toBe(3);
		expect(meta?.model).toBe("claude-sonnet-5-5");
	});

	it("shows approvalMessage instead of summary on APPROVE", () => {
		const body = formatReviewBody({
			...baseOpts,
			finalEvent: "APPROVE",
			approvalMessage: "✅ No issues found. PR approved for merge.",
			readiness: 5,
		});
		expect(body).toContain("✅ No issues found.");
		expect(body).not.toContain("Two issues found.");
	});

	it("includes partial review notice when agents were skipped", () => {
		const body = formatReviewBody({
			...baseOpts,
			skipped: ["security-sast.md"],
		});
		expect(body).toContain("Partial review");
		expect(body).toContain("security-sast");
	});

	describe("failed-agent notice and agents marker", () => {
		const ok = (skill: string, attempt: 1 | 2 = 1): AgentRecord => ({
			skill,
			attempt,
			status: "ok",
		});
		const err = (
			skill: string,
			cls: NonNullable<AgentRecord["class"]>,
			retryable: boolean,
			attempt: 1 | 2 = 1,
		): AgentRecord => ({
			skill,
			attempt,
			status: "error",
			class: cls,
			retryable,
		});
		const groupsOf = (body: string, skill: string) =>
			body
				.split("\n")
				.filter((l) => l.startsWith(">") && l.includes(`\`${skill}\``));

		it("renders no notice for an all-ok round", () => {
			const body = formatReviewBody({
				...baseOpts,
				agentRecords: [ok("code-reviewer.md"), ok("security-sast.md")],
			});
			expect(body).not.toMatch(/Partial review|recovered on retry/);
		});

		it("renders recovered agents as one informational line without a warning", () => {
			const body = formatReviewBody({
				...baseOpts,
				agentRecords: [
					err("code-reviewer.md", "no_output", true),
					ok("code-reviewer.md", 2),
				],
			});
			const lines = groupsOf(body, "code-reviewer");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("failed, then recovered on retry");
			expect(lines[0]).not.toContain("⚠️");
			expect(body).not.toContain("Partial review");
		});

		it("puts each skill in exactly one group with class names", () => {
			const body = formatReviewBody({
				...baseOpts,
				skipped: ["pr-test-analyzer.md"],
				retrySkipped: ["silent-failure-hunter.md"],
				agentRecords: [
					err("code-reviewer.md", "no_output", true),
					err("code-reviewer.md", "schema_mismatch", true, 2),
					err("security-sast.md", "output_truncated", false),
					err("silent-failure-hunter.md", "transient_http", true),
					{ skill: "pr-test-analyzer.md", attempt: 1, status: "skipped" },
				],
			});
			const one = (skill: string, phrase: string, cls?: string) => {
				const lines = groupsOf(body, skill);
				expect(lines).toHaveLength(1);
				expect(lines[0]).toContain(phrase);
				if (cls) expect(lines[0]).toContain(cls);
			};
			one("code-reviewer", "failed after retry", "schema_mismatch");
			one("security-sast", "failed, not retried", "output_truncated");
			one(
				"silent-failure-hunter",
				"retry skipped, out of time",
				"transient_http",
			);
			one("pr-test-analyzer", "did not run");
		});

		it.each([
			["rate_limited", "rate limited"],
			["quota_exhausted", "quota"],
		] as const)("lists a %s final outcome in the notice", (status, phrase) => {
			const body = formatReviewBody({
				...baseOpts,
				agentRecords: [
					err("code-reviewer.md", "no_output", true),
					{ skill: "code-reviewer.md", attempt: 2, status },
				],
			});
			const lines = groupsOf(body, "code-reviewer");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("Partial review");
			expect(lines[0]).toContain(phrase);
		});

		it("writes an agents marker inside the contiguous block above the footer", () => {
			const records = [
				err("code-reviewer.md", "no_output", true),
				err("code-reviewer.md", "schema_mismatch", true, 2),
				ok("security-sast.md"),
			];
			const body = formatReviewBody({
				...baseOpts,
				agentRecords: records,
				pending: ["code-reviewer.md"],
			});
			expect(parseAgentsMarker(body, KNOWN_SKILLS)).toEqual({
				records,
				pending: ["code-reviewer.md"],
			});
			const lines = body.split("\n");
			const i = lines.findIndex((l) => l.startsWith("<!-- ai-review:agents="));
			expect(lines[i - 1]).toMatch(/^<!-- ai-review:cost=/);
			expect(lines[i + 1]).toBe("");
			expect(lines[i + 2]).toBe("---");
			expect(parseReviewMetadata(body)?.sha).toBe("abc123def456");
		});

		it("carries the marker on an approval body too", () => {
			const body = formatReviewBody({
				...baseOpts,
				finalEvent: "APPROVE",
				approvalMessage: "ok",
				readiness: 5,
				agentRecords: [ok("code-reviewer.md")],
			});
			expect(parseAgentsMarker(body, KNOWN_SKILLS)?.records).toEqual([
				ok("code-reviewer.md"),
			]);
		});

		it("reads the real block, not markers quoted in the summary", () => {
			const quoted = `<!-- ai-review:agents={"r":[],"p":["security-sast.md"]} -->`;
			const body = formatReviewBody({
				...baseOpts,
				summary: `Earlier review said:\n${quoted}\nend`,
				agentRecords: [ok("code-reviewer.md")],
			});
			expect(parseAgentsMarker(body, KNOWN_SKILLS)).toEqual({
				records: [ok("code-reviewer.md")],
				pending: [],
			});
		});
	});
});

describe("buildReview ledger suppression", () => {
	const OLD_SHA = "0000000000000000";
	const REPEAT_TITLE = "Token cache never expires";
	const DECLINE = "This is intentional, the token is short-lived";
	const ownReview = {
		id: 100,
		state: "CHANGES_REQUESTED",
		submitted_at: "2026-10-01T00:00:00Z",
		body: `### ai-review-bot\n\nOne issue.\n\n${reviewedCommitMarker(OLD_SHA)}`,
	};
	/** The own review, carrying a finding in its body table the way a later
	 * round lists one still open, while the finding's thread is declined. */
	const carriedRow = `| 🟠 | **${REPEAT_TITLE}** (\`src/review.ts:2\`) |`;
	const carrying = (
		row = carriedRow,
		o: { id?: number; state?: string } = {},
	) => ({
		...ownReview,
		...o,
		body: buildOwnReviewBody({
			sha: OLD_SHA,
			count: 1,
			inline: "Inline comments: 1",
			rows: [row],
		}),
	});
	const ownComment = {
		id: 11,
		pull_request_review_id: 100,
		path: "src/review.ts",
		line: 2,
		body: `**P1** **${REPEAT_TITLE}**\n\nEntries in \`tokenCache\` are never evicted.`,
	};
	const threads = {
		data: {
			repository: {
				pullRequest: {
					author: { login: "joe" },
					reviewThreads: {
						nodes: [
							{
								isResolved: false,
								resolvedBy: null,
								comments: {
									pageInfo: { hasNextPage: false },
									nodes: [
										{
											databaseId: 11,
											author: { login: "ai-review-bot", __typename: "Bot" },
											authorAssociation: "NONE",
											body: ownComment.body,
											createdAt: "2026-10-01T00:00:00Z",
										},
										{
											databaseId: 12,
											author: { login: "joe", __typename: "User" },
											authorAssociation: "OWNER",
											body: DECLINE,
											createdAt: "2026-10-02T00:00:00Z",
										},
									],
								},
							},
						],
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				},
			},
		},
	};

	function ledgerOctokit(
		o: {
			graphqlError?: Error;
			reviews?: unknown[];
			comments?: unknown[];
			threadNodes?: unknown[];
		} = {},
	) {
		const request = vi
			.fn()
			.mockImplementation(
				async (route: string, params?: Record<string, unknown>) => {
					if (route === "POST /graphql") {
						if (o.graphqlError) throw o.graphqlError;
						const v = params?.variables as Record<string, unknown> | undefined;
						// GitHub answers a query whose $variables are missing with an
						// errors array, not data.
						if (
							v?.owner !== baseContext.owner ||
							v?.repo !== baseContext.repo ||
							v?.pr !== baseContext.pullNumber
						)
							return {
								data: {
									errors: [{ message: "Variable $owner was not provided" }],
								},
							};
						if (!o.threadNodes) return { data: threads };
						const pr = threads.data.repository.pullRequest;
						return {
							data: {
								data: {
									repository: {
										pullRequest: {
											...pr,
											reviewThreads: {
												...pr.reviewThreads,
												nodes: o.threadNodes,
											},
										},
									},
								},
							},
						};
					}
					if (route.endsWith("/reviews")) {
						// One page at a time, as GitHub does: 30 per page by default.
						const perPage = Number(params?.per_page ?? 30);
						const page = Number(params?.page ?? 1);
						return {
							data: allReviews.slice((page - 1) * perPage, page * perPage),
						};
					}
					if (route.endsWith("/comments"))
						return { data: o.comments ?? [ownComment] };
					if (route.includes("GET") && route.includes("/check-runs"))
						return { data: { check_runs: [] } };
					return { data: {} };
				},
			);
		const allReviews = o.reviews ?? [ownReview];
		return {
			request,
			paginate: vi
				.fn()
				.mockImplementation(async (route: string) =>
					route.endsWith("/reviews")
						? allReviews
						: [buildPullFile("src/review.ts", SIMPLE_PATCH)],
				),
		};
	}

	const repeat = buildInlineComment({
		title: REPEAT_TITLE,
		body: "Entries in `tokenCache` are never evicted.",
		path: "src/review.ts",
		line: 2,
	});
	const fresh = {
		title: "Handler swallows parse errors",
		body: "The catch block returns an empty object.",
		severity: "P2" as const,
		category: "bug" as const,
		confidence: 0.9,
		evidence: "See diff.",
		suppressible: false,
	};

	type Fixture = ReturnType<typeof buildModelReview>;

	function routeAgents(bySkill: Record<string, Fixture>, fallback: Fixture) {
		mockGenerateObject.mockImplementation(
			async (call: {
				system?: string;
				messages: [{ content: string | [unknown, { text: string }] }];
			}) => {
				if (typeof call.system === "string")
					return {
						object: { summary: "Summary." },
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				const content = call.messages[0].content;
				const skill =
					typeof content === "string"
						? content
						: content[1].text.replace(/^system:/, "");
				return buildGenerateObjectResponse(bySkill[skill] ?? fallback);
			},
		);
	}

	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		mockTriageReReview.mockReset();
		// Own reviews at an older head now give a GitHub-derived baseline, so
		// the gate runs without KV. FULL keeps these tests on the whole PR.
		mockTriageReReview.mockResolvedValue({
			recommendation: "FULL",
			resolved: [],
			newRisk: true,
		});
	});

	it("logs one line per suppressed finding without its body", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		routeAgents(
			{},
			buildModelReview({
				event: "COMMENT",
				general_findings: [fresh],
				inline_comments: [repeat],
			}),
		);

		await buildReview({ octokit: ledgerOctokit(), ...baseContext });

		const lines = log.mock.calls.filter(
			([msg]) => msg === "suppressed settled repeat",
		);
		expect(lines).toHaveLength(5);
		expect(lines[0]?.[1]).toEqual({
			title: REPEAT_TITLE,
			path: "src/review.ts",
			line: 2,
			severity: repeat.severity,
			entryId: "r0:c11:0",
			entryStatus: "rejected",
		});
		log.mockRestore();
	});

	it("counts distinct settled entries, not per-agent hits, in the footer", async () => {
		const SECOND_TITLE = "Retry loop never backs off on 429";
		const SECOND_BODY =
			"The `retryRequest` loop retries immediately with no delay.";
		const secondComment = {
			...ownComment,
			id: 21,
			line: 3,
			body: `**P2** **${SECOND_TITLE}**\n\n${SECOND_BODY}`,
		};
		const [firstNode] = threads.data.repository.pullRequest.reviewThreads.nodes;
		const secondNode = {
			...firstNode,
			comments: {
				...firstNode.comments,
				nodes: [
					{ ...firstNode.comments.nodes[0], databaseId: 21 },
					{ ...firstNode.comments.nodes[1], databaseId: 22, body: "won't fix" },
				],
			},
		};
		const second = buildInlineComment({
			title: SECOND_TITLE,
			body: SECOND_BODY,
			path: "src/review.ts",
			line: 3,
		});
		const only = (c: typeof repeat) =>
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [c],
			});
		routeAgents(
			{
				"code-reviewer.md": only(repeat),
				"silent-failure-hunter.md": only(repeat),
				"pr-test-analyzer.md": only(second),
				"security-sast.md": only(second),
			},
			buildModelReview({
				event: "COMMENT",
				general_findings: [fresh],
				inline_comments: [],
			}),
		);

		const review = await buildReview({
			octokit: ledgerOctokit({
				comments: [ownComment, secondComment],
				threadNodes: [firstNode, secondNode],
			}),
			...baseContext,
		});

		expect(review?.comments).toEqual([]);
		expect(review?.body).toContain("ledger: warm, 2 suppressed");
	});

	it("drops a settled repeat from the posted review and tells the agents why", async () => {
		routeAgents(
			{},
			buildModelReview({
				event: "COMMENT",
				general_findings: [fresh],
				inline_comments: [repeat],
			}),
		);

		const review = await buildReview({
			octokit: ledgerOctokit(),
			...baseContext,
		});

		expect(review?.comments).toEqual([]);
		expect(review?.body).not.toContain(REPEAT_TITLE);
		expect(review?.body).toContain(fresh.title);
		expect(review?.body).toContain("ledger: warm, 1 suppressed");
		expect(mockBuildUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				priorOwnFindings: [
					expect.objectContaining({
						title: REPEAT_TITLE,
						status: "rejected",
						reason: DECLINE,
					}),
				],
			}),
		);
	});

	it("does not request changes when an agent's only findings were suppressed", async () => {
		routeAgents(
			{
				"code-reviewer.md": buildModelReview({
					event: "REQUEST_CHANGES",
					general_findings: [],
					inline_comments: [repeat],
				}),
			},
			buildModelReview({
				event: "COMMENT",
				general_findings: [fresh],
				inline_comments: [],
			}),
		);

		const review = await buildReview({
			octokit: ledgerOctokit(),
			...baseContext,
		});

		expect(review?.event).toBe("COMMENT");
	});

	it("does not let a carried prior finding the ledger shows settled force REQUEST_CHANGES", async () => {
		mockTriageReReview.mockResolvedValue({
			recommendation: "FULL",
			resolved: [],
			newRisk: true,
		});
		routeAgents(
			{},
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);

		const review = await buildReview({
			octokit: ledgerOctokit({ reviews: [carrying()] }),
			...baseContext,
		});

		expect(review?.event).toBe("APPROVE");
		expect(review?.body).not.toContain("Still open from the previous review");
		const prompt = mockBuildUserMessage.mock.calls[0]?.[0] as {
			priorOwnFindings: unknown[];
		};
		expect(prompt.priorOwnFindings).toEqual([
			expect.objectContaining({
				title: REPEAT_TITLE,
				status: "rejected",
				decidedBy: "author",
				reason: DECLINE,
			}),
		]);
	});

	it("keeps the review intact with a cold ledger when the GraphQL call fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		routeAgents(
			{},
			buildModelReview({
				event: "COMMENT",
				general_findings: [fresh],
				inline_comments: [repeat],
			}),
		);

		const review = await buildReview({
			octokit: ledgerOctokit({ graphqlError: new Error("graphql down") }),
			...baseContext,
		});

		expect(review?.comments).toEqual([
			expect.objectContaining({ path: "src/review.ts", line: 2 }),
		]);
		expect(review?.body).toContain("ledger: cold");
		warn.mockRestore();
	});

	it("makes no ledger calls and renders no ledger note on a first review", async () => {
		routeAgents(
			{},
			buildModelReview({
				event: "COMMENT",
				general_findings: [fresh],
				inline_comments: [repeat],
			}),
		);
		const octokit = ledgerOctokit({ reviews: [] });

		const review = await buildReview({ octokit, ...baseContext });

		expect(octokit.request).not.toHaveBeenCalledWith(
			"POST /graphql",
			expect.anything(),
		);
		expect(review?.comments).toHaveLength(1);
		expect(review?.body).not.toContain("ledger:");
	});

	function restampedConclusion(octokit: ReturnType<typeof ledgerOctokit>) {
		const call = octokit.request.mock.calls.find(
			([route]) => route === "POST /repos/{owner}/{repo}/check-runs",
		);
		return (call?.[1] as { conclusion?: string } | undefined)?.conclusion;
	}

	describe("on a triage SKIP", () => {
		beforeEach(() => {
			mockTriageReReview.mockResolvedValue({
				recommendation: "SKIP",
				resolved: [],
				newRisk: false,
			});
		});

		it("approves via the check-run when the ledger settles every carried finding after a COMMENTED review", async () => {
			const octokit = ledgerOctokit({
				reviews: [carrying(carriedRow, { state: "COMMENTED" })],
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision).toBeNull();
			expect(restampedConclusion(octokit)).toBe("success");
		});

		it("posts an APPROVE instead of skipping when the ledger settles everything and the latest own review requested changes", async () => {
			routeAgents(
				{},
				buildModelReview({
					event: "COMMENT",
					general_findings: [],
					inline_comments: [],
				}),
			);
			const octokit = ledgerOctokit({ reviews: [carrying()] });

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("APPROVE");
			expect(restampedConclusion(octokit)).toBeUndefined();
		});

		it("still requests changes when the ledger does not settle the carried finding", async () => {
			// On a PR file, or it would retire instead of blocking.
			const octokit = ledgerOctokit({
				reviews: [
					carrying(
						"| 🟠 | **Retry loop never backs off** (`src/review.ts:40`) |",
					),
				],
			});

			await buildReview({ octokit, ...baseContext });

			expect(restampedConclusion(octokit)).toBe("action_required");
		});

		// A cold ledger cannot vouch for the review's inline comments, so the round
		// runs in full instead of skipping, and the carried finding still blocks.
		it("keeps blocking on the carried finding when the ledger cannot be fetched", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			routeAgents(
				{},
				buildModelReview({
					event: "COMMENT",
					general_findings: [],
					inline_comments: [],
				}),
			);
			const octokit = ledgerOctokit({
				reviews: [carrying()],
				graphqlError: new Error("graphql down"),
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("REQUEST_CHANGES");
			expect(decision?.body).toContain(
				`**${REPEAT_TITLE}** (\`src/review.ts:2\`)`,
			);
			expect(decision?.body).toContain("scope: full (baseline incomplete)");
			expect(restampedConclusion(octokit)).toBeUndefined();
			warn.mockRestore();
		});

		// The baseline is derived from the ledger, so it is fetched once; the SKIP
		// gate reuses that load instead of asking again.
		it("fetches the ledger once, for the baseline, when nothing is open", async () => {
			const octokit = ledgerOctokit({
				reviews: [
					{
						...ownReview,
						state: "COMMENTED",
						body: buildOwnReviewBody({ sha: OLD_SHA, count: 1 }),
					},
				],
				comments: [],
			});

			await buildReview({ octokit, ...baseContext });

			expect(
				octokit.request.mock.calls.filter(([r]) => r === "POST /graphql"),
			).toHaveLength(1);
			expect(restampedConclusion(octokit)).toBe("success");
		});

		const cleanAgents = () =>
			routeAgents(
				{},
				buildModelReview({
					event: "COMMENT",
					general_findings: [],
					inline_comments: [],
				}),
			);

		it("posts an APPROVE when a COMMENTED review followed the standing change request", async () => {
			cleanAgents();
			const octokit = ledgerOctokit({
				reviews: [
					carrying(carriedRow, { state: "CHANGES_REQUESTED" }),
					carrying(carriedRow, { id: 101, state: "COMMENTED" }),
				],
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("APPROVE");
		});

		it("posts an APPROVE when the standing approval was dismissed", async () => {
			cleanAgents();
			const octokit = ledgerOctokit({
				reviews: [carrying(carriedRow, { state: "DISMISSED" })],
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("APPROVE");
		});

		it("re-stamps instead of posting when an approval stands under a later comment", async () => {
			const octokit = ledgerOctokit({
				reviews: [
					carrying(carriedRow, { state: "APPROVED" }),
					carrying(carriedRow, { id: 101, state: "COMMENTED" }),
				],
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision).toBeNull();
			expect(restampedConclusion(octokit)).toBe("success");
		});
	});

	describe("when a re-review round has nothing new", () => {
		const onlyRepeat = buildModelReview({
			event: "COMMENT",
			general_findings: [],
			inline_comments: [repeat],
		});
		const priorOwn = (state: string, id = ownReview.id) => ({
			...ownReview,
			id,
			state,
		});

		it("posts nothing and re-stamps the check-run after a COMMENTED review", async () => {
			mockTriageReReview.mockResolvedValue({
				recommendation: "FULL",
				resolved: [],
				newRisk: true,
			});
			routeAgents({}, onlyRepeat);
			const octokit = ledgerOctokit({
				reviews: [carrying(carriedRow, { state: "COMMENTED" })],
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision).toBeNull();
			expect(restampedConclusion(octokit)).toBe("neutral");
		});

		// The settled finding lives only in its inline thread, never in a body
		// table, so a later push whose ledger fetch fails has nothing to carry.
		it("a settled inline finding cannot block a later cold-ledger push", async () => {
			mockTriageReReview.mockResolvedValue({
				recommendation: "FULL",
				resolved: [],
				newRisk: true,
			});
			routeAgents({}, onlyRepeat);
			const prior = {
				...priorOwn("COMMENTED"),
				body: buildOwnReviewBody({
					sha: OLD_SHA,
					count: 1,
					inline: "Inline comments: 1",
				}),
			};

			const silent = await buildReview({
				octokit: ledgerOctokit({ reviews: [prior] }),
				...baseContext,
			});

			expect(silent).toBeNull();

			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			mockTriageReReview.mockResolvedValue({
				recommendation: "INCREMENTAL",
				resolved: [],
				newRisk: false,
			});
			routeAgents(
				{},
				buildModelReview({
					event: "COMMENT",
					general_findings: [],
					inline_comments: [],
				}),
			);
			const later = ledgerOctokit({
				reviews: [prior],
				graphqlError: new Error("graphql down"),
			});

			const next = await buildReview({
				octokit: later,
				...baseContext,
				headSha: "fedcba0987654321",
			});

			expect(next?.event).not.toBe("REQUEST_CHANGES");
			expect(next?.body ?? "").not.toContain(REPEAT_TITLE);
			expect(restampedConclusion(later)).not.toBe("action_required");
			warn.mockRestore();
		});

		it("posts the APPROVE when a COMMENTED review followed a change request", async () => {
			routeAgents({}, onlyRepeat);
			const octokit = ledgerOctokit({
				reviews: [priorOwn("CHANGES_REQUESTED"), priorOwn("COMMENTED", 101)],
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("APPROVE");
		});

		it("posts the APPROVE when the last approval was dismissed", async () => {
			routeAgents({}, onlyRepeat);
			const octokit = ledgerOctokit({ reviews: [priorOwn("DISMISSED")] });

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("APPROVE");
		});

		it("stays silent when an approval stands under a later comment", async () => {
			routeAgents({}, onlyRepeat);
			const octokit = ledgerOctokit({
				reviews: [priorOwn("APPROVED"), priorOwn("COMMENTED", 101)],
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision).toBeNull();
			expect(restampedConclusion(octokit)).toBe("success");
		});

		it("stays silent when the history holds only comments", async () => {
			routeAgents({}, onlyRepeat);
			const octokit = ledgerOctokit({ reviews: [priorOwn("COMMENTED")] });

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision).toBeNull();
			expect(restampedConclusion(octokit)).toBe("neutral");
		});

		it("re-stamps success when the latest own review approved", async () => {
			routeAgents({}, onlyRepeat);
			const octokit = ledgerOctokit({
				reviews: [priorOwn("CHANGES_REQUESTED"), priorOwn("APPROVED", 101)],
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision).toBeNull();
			expect(restampedConclusion(octokit)).toBe("success");
		});

		it("reads the latest own review from the last page of a long review list", async () => {
			routeAgents({}, onlyRepeat);
			const reviews = [
				...Array.from({ length: 30 }, (_, i) => ({
					...priorOwn("COMMENTED"),
					id: 200 + i,
				})),
				priorOwn("CHANGES_REQUESTED"),
			];
			const octokit = ledgerOctokit({ reviews });

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("APPROVE");
		});

		it("posts the APPROVE when the latest own review requested changes", async () => {
			routeAgents({}, onlyRepeat);
			const octokit = ledgerOctokit({
				reviews: [priorOwn("APPROVED"), priorOwn("CHANGES_REQUESTED", 101)],
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("APPROVE");
			expect(restampedConclusion(octokit)).toBeUndefined();
		});

		it("still posts its APPROVE on a first review with zero findings", async () => {
			routeAgents(
				{},
				buildModelReview({
					event: "COMMENT",
					general_findings: [],
					inline_comments: [],
				}),
			);

			const decision = await buildReview({
				octokit: ledgerOctokit({ reviews: [] }),
				...baseContext,
			});

			expect(decision?.event).toBe("APPROVE");
		});

		it("posts when an agent errored, even with zero findings", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			routeAgents({}, onlyRepeat);
			const route = mockGenerateObject.getMockImplementation();
			mockGenerateObject.mockImplementation(
				async (call: { messages: [{ content: unknown }] }) => {
					if (JSON.stringify(call.messages).includes("code-reviewer.md"))
						throw new Error("agent crashed");
					return route?.(call);
				},
			);

			const decision = await buildReview({
				octokit: ledgerOctokit({ reviews: [priorOwn("COMMENTED")] }),
				...baseContext,
			});

			expect(decision?.body).toContain("failed, not retried");
			error.mockRestore();
		});

		it("posts a fresh finding normally after an approved review", async () => {
			routeAgents(
				{},
				buildModelReview({
					event: "COMMENT",
					general_findings: [fresh],
					inline_comments: [repeat],
				}),
			);
			const octokit = ledgerOctokit({ reviews: [priorOwn("APPROVED")] });

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("COMMENT");
			expect(decision?.body).toContain(fresh.title);
		});

		it("posts when the review was explicitly forced", async () => {
			routeAgents({}, onlyRepeat);
			const octokit = ledgerOctokit({ reviews: [priorOwn("COMMENTED")] });

			const decision = await buildReview({
				octokit,
				...baseContext,
				force: true,
			});

			expect(decision?.event).toBe("APPROVE");
		});
	});
});

describe("delta scoping without KV", () => {
	const OWNER = baseContext.owner;
	const REPO = baseContext.repo;
	const HEAD = baseContext.headSha;
	const OLD = "abcdef1234567890";
	const REVIEWS_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
	const COMMENTS_ROUTE =
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments";
	const COMPARE_ROUTE = "GET /repos/{owner}/{repo}/compare/{basehead}";
	const CHECK_RUNS_ROUTE = "POST /repos/{owner}/{repo}/check-runs";
	const aFile = buildPullFile("src/a.ts", TWENTY_LINE_PATCH);
	const bFile = buildPullFile("src/b.ts", SIMPLE_PATCH);
	const fresh = buildModelReview({
		general_findings: [
			{
				title: "Fresh issue",
				body: "Something new.",
				severity: "P2",
				category: "bug",
				confidence: 0.9,
				evidence: "src/b.ts:1",
				suppressible: false,
			},
		],
	}).general_findings[0];

	type OwnReview = {
		id: number;
		body: string;
		state?: string;
		submitted_at?: string;
	};

	function expectPr(p: Record<string, unknown>) {
		expect(p.owner).toBe(OWNER);
		expect(p.repo).toBe(REPO);
		expect(p.pull_number).toBe(baseContext.pullNumber);
	}

	function prOctokit(o: {
		reviews?: OwnReview[];
		ledgerReviews?: OwnReview[];
		files?: Array<{
			filename: string;
			status: string;
			patch?: string;
			additions?: number;
			deletions?: number;
		}>;
		compare?: (basehead: string) => unknown;
		coldLedger?: boolean;
		comments?: unknown[];
		threadNodes?: unknown[];
		rawDiff?: string;
	}) {
		const compareCalls: string[] = [];
		const checkRuns: Array<Record<string, unknown>> = [];
		const stamp = (rs: OwnReview[]) =>
			rs.map((r, i) => ({
				state: "COMMENTED",
				submitted_at: `2026-10-0${i + 1}T00:00:00Z`,
				...r,
			}));
		const octokit = buildStrictOctokit({
			[REVIEWS_ROUTE]: (p) => {
				expectPr(p);
				// The ledger pages with `page`; buildReview's own fetch paginates.
				return stamp(
					p.page !== undefined
						? (o.ledgerReviews ?? o.reviews ?? [])
						: (o.reviews ?? []),
				);
			},
			[FILES_ROUTE]: (p) => {
				expectPr(p);
				return o.files ?? [aFile, bFile];
			},
			[COMMENTS_ROUTE]: (p) => {
				expectPr(p);
				return o.comments ?? [];
			},
			...(o.rawDiff !== undefined && {
				"GET /repos/{owner}/{repo}/pulls/{pull_number}": (
					p: Record<string, unknown>,
				) => {
					expectPr(p);
					return o.rawDiff;
				},
			}),
			"POST /graphql": (p) => {
				expect(p.variables).toMatchObject({
					owner: OWNER,
					repo: REPO,
					pr: baseContext.pullNumber,
				});
				if (o.coldLedger) return { errors: [{ message: "boom" }] };
				return {
					data: {
						repository: {
							pullRequest: {
								author: { login: "joe" },
								reviewThreads: {
									nodes: o.threadNodes ?? [],
									pageInfo: { hasNextPage: false, endCursor: null },
								},
							},
						},
					},
				};
			},
			[COMPARE_ROUTE]: (p) => {
				expect(p.owner).toBe(OWNER);
				expect(p.repo).toBe(REPO);
				compareCalls.push(p.basehead as string);
				if (!o.compare) throw new Error("compare not expected");
				return o.compare(p.basehead as string);
			},
			[CHECK_RUNS_ROUTE]: (p) => {
				expect(p.owner).toBe(OWNER);
				expect(p.repo).toBe(REPO);
				checkRuns.push(p);
				return {};
			},
		});
		return {
			octokit: octokit as unknown as Parameters<
				typeof buildReview
			>[0]["octokit"],
			compareCalls,
			checkRuns,
		};
	}

	/** Routes the mocked model by call shape: revalidation prompts, the summary
	 * (the only call with a system prompt), and review agents. */
	function routeModels(o: {
		agent?: ReturnType<typeof buildModelReview>;
		resolved?: string[];
	}) {
		const revalidatePrompts: string[] = [];
		mockGenerateObject.mockImplementation(
			async (args: { prompt?: unknown; system?: unknown }) => {
				if (
					typeof args.prompt === "string" &&
					args.prompt.startsWith("You are checking")
				) {
					revalidatePrompts.push(args.prompt);
					return { object: { resolved: o.resolved ?? [] } };
				}
				if (args.system !== undefined)
					return {
						object: { summary: "Summary." },
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				return buildGenerateObjectResponse(o.agent ?? buildModelReview());
			},
		);
		return revalidatePrompts;
	}

	const withFresh = () =>
		buildModelReview({ event: "COMMENT", general_findings: [fresh] });
	const reviewedFiles = () =>
		(
			mockBuildUserMessage.mock.calls[0]?.[0] as {
				files: Array<{ filename: string }>;
			}
		).files.map((f) => f.filename);

	beforeEach(async () => {
		const actual =
			await vi.importActual<typeof import("./triage.js")>("./triage.js");
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		mockTriageReReview.mockReset();
		mockFetchDeltaMeta.mockReset();
		mockFetchDeltaMeta.mockImplementation(
			actual.fetchDeltaMeta as unknown as typeof mockFetchDeltaMeta,
		);
		mockRevalidateFindings.mockReset();
		mockRevalidateFindings.mockImplementation(
			actual.revalidateFindings as unknown as typeof mockRevalidateFindings,
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		mockFetchDeltaMeta.mockReset();
		mockRevalidateFindings.mockReset();
		vi.restoreAllMocks();
	});

	it("cold run scopes to the delta", async () => {
		routeModels({ agent: withFresh() });
		mockTriageReReview.mockResolvedValue({
			recommendation: "INCREMENTAL",
			resolved: [],
			newRisk: true,
		});
		const { octokit, compareCalls } = prOctokit({
			reviews: [{ id: 11, body: buildOwnReviewBody({ sha: OLD, count: 1 }) }],
			compare: () => ({ status: "ahead", files: [bFile] }),
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
		expect(reviewedFiles()).toEqual(["src/b.ts"]);
		expect(decision?.body).toContain("scope: delta from abcdef1 (github)");
		expect(decision?.body).toContain("ledger: warm");
		expect(decision?.body).toContain("<!-- ai-review:review=2 -->");
	});

	const KV_METHODS = [
		"zadd",
		"zrangebyscore",
		"zremrangebyscore",
		"set",
		"setNx",
		"get",
		"del",
		"lpush",
		"lrange",
	] as const;
	function spyKv(impl: () => Promise<unknown>) {
		const spies = Object.fromEntries(
			KV_METHODS.map((m) => [m, vi.fn(impl)]),
		) as Record<(typeof KV_METHODS)[number], ReturnType<typeof vi.fn>>;
		return { spies, client: spies as unknown as KvClient };
	}
	const staleKvState = JSON.stringify({
		lastReviewedSha: "fedcba9876543210",
		event: "REQUEST_CHANGES",
		findings: [
			{
				id: findingId(null, null, "Kv only blocker"),
				path: null,
				line: null,
				title: "Kv only blocker",
				severity: "P1",
				status: "open",
			},
		],
		reviewedAt: "2026-10-01T00:00:00Z",
		reviewCount: 7,
	});
	const deltaRound = () => {
		routeModels({ agent: withFresh() });
		mockTriageReReview.mockResolvedValue({
			recommendation: "INCREMENTAL",
			resolved: [],
			newRisk: true,
		});
		return prOctokit({
			reviews: [{ id: 11, body: buildOwnReviewBody({ sha: OLD, count: 1 }) }],
			compare: () => ({ status: "ahead", files: [bFile] }),
		});
	};

	it("a throwing kv does not fail a non-forced review", async () => {
		const { client } = spyKv(async () => {
			throw new Error("kv down");
		});
		const { octokit, compareCalls } = deltaRound();

		const decision = await buildReview({ octokit, ...baseContext, kv: client });

		expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
		expect(decision?.body).toContain("Fresh issue");
		expect(decision?.body).toContain("scope: delta from abcdef1 (github)");
	});

	it("kv set and kv null give the same event, body and scope note for the same prior review", async () => {
		const { client } = spyKv(async () => staleKvState);
		const withKv = deltaRound();
		const a = await buildReview({
			octokit: withKv.octokit,
			...baseContext,
			kv: client,
		});
		const withoutKv = deltaRound();
		const b = await buildReview({
			octokit: withoutKv.octokit,
			...baseContext,
			kv: null,
		});

		// The agents marker records each agent's measured durationMs, which
		// differs between two real runs.
		const stableBody = (body?: string) =>
			body?.replace(/"durationMs":\d+/g, '"durationMs":0');
		expect(withKv.compareCalls).toEqual(withoutKv.compareCalls);
		expect(a?.event).toBe(b?.event);
		expect(a?.body).toContain('"durationMs":');
		expect(stableBody(a?.body)).toBe(stableBody(b?.body));
		expect(a?.body).toContain("scope: delta from abcdef1 (github)");
		expect(a?.body).not.toContain("Kv only blocker");
	});

	// Production runs both bots under one heading (REVIEW_COMMENT_PREFIX is set,
	// OPENAI_REVIEW_COMMENT_PREFIX is not). On PR #92 reviews 5719190216 and
	// 5719191481 differ only in the provider marker.
	describe("own reviews when both bots share one heading", () => {
		const OLDER = "0123456789abcdef";
		const anthropicReview = (sha = OLD) => ({
			id: 11,
			body: buildOwnReviewBody({
				sha,
				count: 3,
				provider: "anthropic",
				rows: ["| 🟠 | **Anthropic carried bug** (`src/a.ts:5`) |"],
			}),
		});
		const openaiReview = (sha = OLD) => ({
			id: 12,
			body: buildOwnReviewBody({
				sha,
				count: 8,
				provider: "openai",
				rows: ["| 🟠 | **Codex carried bug** (`src/a.ts:6`) |"],
			}),
		});
		/** A posted body with the full marker block, as formatReviewBody writes it. */
		const postedReview = (id: number, provider: string) => ({
			id,
			body: [
				"<!-- ai-review:post-attempt:0000 -->",
				"### ai-review-bot",
				"",
				"Summary.",
				"",
				[
					`sha=${HEAD}`,
					"review=1",
					"readiness=4",
					`provider=${provider}`,
					"model=m",
					"findings=0",
					"cost=0.000100",
				]
					.map((m) => `<!-- ai-review:${m} -->`)
					.join("\n"),
				"",
				"---",
				"*Model: m · 5 agents · $0.000100*",
			].join("\n"),
		});
		const incremental = () => {
			routeModels({ agent: withFresh() });
			mockTriageReReview.mockResolvedValue({
				recommendation: "INCREMENTAL",
				resolved: [],
				newRisk: true,
			});
		};

		it("takes the review count and carried findings from this provider's review", async () => {
			incremental();
			const { octokit, compareCalls } = prOctokit({
				reviews: [anthropicReview(), openaiReview()],
				compare: () => ({ status: "ahead", files: [bFile] }),
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
			expect(decision?.body).toContain("<!-- ai-review:review=4 -->");
			expect(decision?.body).toContain("Anthropic carried bug");
			expect(decision?.body).not.toContain("Codex carried bug");
		});

		it("takes the delta base sha from this provider's review", async () => {
			incremental();
			const { octokit, compareCalls } = prOctokit({
				reviews: [anthropicReview(), openaiReview(OLDER)],
				compare: () => ({ status: "ahead", files: [bFile] }),
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
			expect(decision?.body).toContain("scope: delta from abcdef1 (github)");
		});

		it("reviews a head that only the other provider has reviewed, and shows that review as a sister review", async () => {
			routeModels({ agent: withFresh() });
			const sister = postedReview(12, "openai");
			const { octokit, compareCalls } = prOctokit({ reviews: [sister] });

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision).not.toBeNull();
			expect(compareCalls).toEqual([]);
			expect(decision?.body).toContain("<!-- ai-review:review=1 -->");
			expect(mockBuildUserMessage).toHaveBeenCalledWith(
				expect.objectContaining({ priorBotReviews: [sister.body] }),
			);
		});

		it("skips a head this provider has already reviewed", async () => {
			routeModels({ agent: withFresh() });
			const { octokit } = prOctokit({
				reviews: [postedReview(12, "openai"), postedReview(11, "anthropic")],
			});

			expect(await buildReview({ octokit, ...baseContext })).toBeNull();
		});
	});

	it("a failing baseline derivation falls back to a full review without error", async () => {
		routeModels({ agent: withFresh() });
		const { octokit, compareCalls } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({
						sha: OLD,
						count: 1,
						inline: "Inline comments: 1",
					}),
				},
			],
			coldLedger: true,
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([]);
		expect(reviewedFiles()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(decision?.body).toContain("Fresh issue");
		expect(decision?.body).toContain("ledger: cold");
		expect(decision?.body).toContain("scope: full (baseline incomplete)");
	});

	it("buildReview makes no kv calls", async () => {
		const { spies, client } = spyKv(async () => null);
		const posted = deltaRound();
		expect(
			await buildReview({
				octokit: posted.octokit,
				...baseContext,
				kv: client,
			}),
		).not.toBeNull();
		mockTriageReReview.mockResolvedValue({
			recommendation: "SKIP",
			resolved: [],
			newRisk: false,
		});
		const skipped = prOctokit({
			reviews: [{ id: 11, body: buildOwnReviewBody({ sha: OLD, count: 1 }) }],
			compare: () => ({ status: "ahead", files: [bFile] }),
		});
		expect(
			await buildReview({
				octokit: skipped.octokit,
				...baseContext,
				kv: client,
			}),
		).toBeNull();
		expect(skipped.checkRuns).toHaveLength(1);

		for (const m of KV_METHODS) expect(spies[m], m).not.toHaveBeenCalled();
	});

	const blockerRow = "| 🟠 | correctness | **Blocker** |";

	it.each([
		[
			"compare throws",
			() => {
				throw Object.assign(new Error("Not Found"), { status: 404 });
			},
		],
		["compare diverged", () => ({ status: "diverged", files: [bFile] })],
	])("%s: runs FULL, skips triage, and keeps the baseline blocker", async (_name, compare) => {
		routeModels({});
		const { octokit, compareCalls } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({ sha: OLD, count: 1, rows: [blockerRow] }),
				},
			],
			compare,
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
		expect(mockTriageReReview).not.toHaveBeenCalled();
		expect(reviewedFiles()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Blocker**");
		expect(decision?.body).toContain("scope: full (compare failed)");
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("full review"),
			expect.objectContaining({ pullNumber: 1, reason: "compare failed" }),
		);
	});

	it("compare truncated: delta triage is never asked and no resolution applies", async () => {
		routeModels({});
		mockTriageReReview.mockResolvedValue({
			recommendation: "SKIP",
			resolved: [findingId(null, null, "Blocker")],
			newRisk: false,
		});
		const many = Array.from({ length: 300 }, (_, i) =>
			buildPullFile(`src/f${i}.ts`, SIMPLE_PATCH),
		);
		const { octokit, compareCalls } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({ sha: OLD, count: 1, rows: [blockerRow] }),
				},
			],
			compare: () => ({ status: "ahead", files: many }),
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
		expect(mockTriageReReview).not.toHaveBeenCalled();
		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Blocker**");
		expect(decision?.body).toContain("scope: full (compare truncated)");
	});

	it("fallback revalidation resolves a fixed finding", async () => {
		const fixedId = findingId("src/a.ts", 3, "Null deref");
		const prompts = routeModels({ agent: withFresh(), resolved: [fixedId] });
		const { octokit, compareCalls } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({
						sha: OLD,
						count: 1,
						rows: ["| 🟠 | **Null deref** (`src/a.ts:3`) |"],
					}),
				},
			],
			compare: () => {
				throw new Error("gone");
			},
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(fixedId);
		expect(prompts[0]).toContain("FILE: src/a.ts");
		expect(prompts[0]).not.toContain("FILE: src/b.ts");
		expect(decision?.event).toBe("COMMENT");
		expect(decision?.body).not.toContain("Null deref");
	});

	it("a fixed path-less finding is resolved by a fallback round and not carried by a later push", async () => {
		const fixedId = findingId(null, null, "Missing tests");
		const prompts = routeModels({ agent: withFresh(), resolved: [fixedId] });
		const r1 = {
			id: 11,
			body: buildOwnReviewBody({
				sha: OLD,
				count: 1,
				rows: ["| 🟡 | tests | **Missing tests** |"],
			}),
		};
		const fallback = prOctokit({
			reviews: [r1],
			compare: () => {
				throw new Error("gone");
			},
		});

		const decision = await buildReview({
			octokit: fallback.octokit,
			...baseContext,
		});

		expect(fallback.compareCalls).toEqual([`${OLD}...${HEAD}`]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(fixedId);
		expect(prompts[0]).toContain("FILE: src/a.ts");
		expect(prompts[0]).toContain("FILE: src/b.ts");
		expect(decision?.event).toBe("COMMENT");
		expect(decision?.body).not.toContain("Missing tests");

		const NEXT = "fedcba0987654321";
		routeModels({ agent: withFresh() });
		mockTriageReReview.mockResolvedValue({
			recommendation: "INCREMENTAL",
			resolved: [],
			newRisk: true,
		});
		const later = prOctokit({
			reviews: [r1, { id: 12, body: decision?.body ?? "" }],
			compare: () => ({ status: "ahead", files: [bFile] }),
		});
		await buildReview({
			octokit: later.octokit,
			...baseContext,
			headSha: NEXT,
		});

		expect(later.compareCalls).toEqual([`${HEAD}...${NEXT}`]);
		const open = mockTriageReReview.mock.calls[0]?.[2] as PersistedFinding[];
		expect(open.map((f) => f.title)).toEqual(["Fresh issue"]);
	});

	it("a review at the current head without the full metadata block runs full with scope same head", async () => {
		routeModels({ agent: withFresh() });
		const { octokit, compareCalls } = prOctokit({
			reviews: [{ id: 11, body: buildOwnReviewBody({ sha: HEAD, count: 1 }) }],
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([]);
		expect(mockTriageReReview).not.toHaveBeenCalled();
		expect(reviewedFiles()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(decision?.body).toContain("scope: full (same head)");
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("full review"),
			expect.objectContaining({ pullNumber: 1, reason: "same head" }),
		);
	});

	it("forced run carries the own review's open findings and continues its count", async () => {
		routeModels({});
		const { octokit, compareCalls } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({
						sha: OLD,
						count: 5,
						rows: ["| 🟠 | correctness | **Carried blocker** |"],
					}),
				},
			],
		});

		const decision = await buildReview({
			octokit,
			...baseContext,
			force: true,
		});

		expect(compareCalls).toEqual([]);
		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Carried blocker**");
		expect(decision?.body).toContain("scope: full (forced)");
		expect(decision?.body).toContain(`<!-- ai-review:sha=${HEAD} -->`);
		expect(decision?.body).toContain("<!-- ai-review:review=6 -->");
	});

	it("forced run carries: round 3's baseline holds round 1's and round 2's findings", async () => {
		const A = { ...fresh, title: "Finding A" };
		const B = { ...fresh, title: "Finding B" };
		const R1 = "1111111aaaaaaaaa";
		const R2 = "2222222bbbbbbbbb";

		routeModels({ agent: buildModelReview({ general_findings: [A] }) });
		const round1 = await buildReview({
			octokit: prOctokit({}).octokit,
			...baseContext,
			headSha: R1,
		});
		expect(round1?.body).toContain("scope: full (first review)");

		routeModels({ agent: buildModelReview({ general_findings: [B] }) });
		const r1 = { id: 1, body: round1?.body ?? "" };
		const forced = prOctokit({ reviews: [r1] });
		const round2 = await buildReview({
			octokit: forced.octokit,
			...baseContext,
			headSha: R2,
			force: true,
		});
		expect(forced.compareCalls).toEqual([]);
		expect(round2?.body).toContain("scope: full (forced)");
		expect(round2?.body).toContain("<!-- ai-review:review=2 -->");

		routeModels({ agent: withFresh() });
		mockTriageReReview.mockResolvedValue({
			recommendation: "INCREMENTAL",
			resolved: [],
			newRisk: true,
		});
		const { octokit } = prOctokit({
			reviews: [r1, { id: 2, body: round2?.body ?? "" }],
			compare: () => ({ status: "ahead", files: [bFile] }),
		});
		await buildReview({ octokit, ...baseContext });

		const open = mockTriageReReview.mock.calls[0]?.[2] as PersistedFinding[];
		expect(open.map((f) => f.title).sort()).toEqual(["Finding A", "Finding B"]);
	});

	it("same-head forced run with no KV carries the same-head review's findings and continues the count", async () => {
		routeModels({});
		const { octokit, compareCalls } = prOctokit({
			reviews: [
				{
					id: 5,
					body: buildOwnReviewBody({ sha: HEAD, count: 3, rows: [blockerRow] }),
				},
			],
		});

		const decision = await buildReview({
			octokit,
			...baseContext,
			force: true,
		});

		expect(compareCalls).toEqual([]);
		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Blocker**");
		expect(decision?.body).toContain("<!-- ai-review:review=4 -->");
		expect(decision?.body).toContain("scope: full (forced)");
	});

	it("incomplete baseline runs full, carries what was recovered, footer says baseline incomplete", async () => {
		routeModels({});
		const { octokit, compareCalls } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({
						sha: OLD,
						count: 1,
						inline: "Inline comments: 3",
						rows: [blockerRow],
					}),
				},
			],
			coldLedger: true,
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([]);
		expect(reviewedFiles()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Blocker**");
		expect(decision?.body).toContain("scope: full (baseline incomplete)");
	});

	it("source review missing from the ledger's reviewIds is incomplete", async () => {
		routeModels({ agent: withFresh() });
		const older = {
			id: 10,
			body: buildOwnReviewBody({ sha: "9999999999999999", count: 1 }),
		};
		const { octokit, compareCalls } = prOctokit({
			reviews: [
				older,
				{ id: 11, body: buildOwnReviewBody({ sha: OLD, count: 2 }) },
			],
			ledgerReviews: [older],
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([]);
		expect(decision?.body).toContain("scope: full (baseline incomplete)");
	});

	it("two own reviews at one older sha: the later one is the source", async () => {
		routeModels({});
		const { octokit } = prOctokit({
			reviews: [
				{
					id: 10,
					body: buildOwnReviewBody({
						sha: OLD,
						count: 1,
						rows: ["| 🟠 | correctness | **Earlier only** |"],
					}),
				},
				{
					id: 11,
					body: buildOwnReviewBody({ sha: OLD, count: 2, rows: [blockerRow] }),
				},
			],
			compare: () => {
				throw new Error("gone");
			},
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(decision?.body).toContain("**Blocker**");
		expect(decision?.body).not.toContain("Earlier only");
		expect(decision?.body).toContain("<!-- ai-review:review=3 -->");
	});

	it("footer scope note: first review", async () => {
		routeModels({ agent: withFresh() });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { octokit } = prOctokit({});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(decision?.body).toContain("scope: full (first review)");
		expect(decision?.body).toContain("<!-- ai-review:review=1 -->");
		expect(log).toHaveBeenCalledWith("review scope", {
			scope: "scope: full (first review)",
		});
	});

	it("footer scope note: triage chose FULL carries and revalidates", async () => {
		const prompts = routeModels({ agent: withFresh() });
		mockTriageReReview.mockResolvedValue({
			recommendation: "FULL",
			resolved: [],
			newRisk: true,
		});
		const { octokit, compareCalls } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({
						sha: OLD,
						count: 1,
						rows: ["| 🟠 | **Null deref** (`src/a.ts:3`) |"],
					}),
				},
			],
			compare: () => ({ status: "ahead", files: [bFile] }),
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
		expect(reviewedFiles()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(prompts).toHaveLength(1);
		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Null deref**");
		expect(decision?.body).toContain("scope: full (triage)");
	});

	it("review@sha1 (REQUEST_CHANGES) → push sha2 (SKIP) → push sha3 (INCREMENTAL → APPROVE) from GitHub alone", async () => {
		const sha1 = "aaaaaaaaaaaa1111";
		const sha2 = "bbbbbbbbbbbb2222";
		const sha3 = "cccccccccccc3333";
		const bugId = findingId("src/a.ts", 5, "Bug");
		// One agent raises the bug: identical comments from several agents are
		// merged into one body that the ledger splits back into several claims.
		routeModels({});
		mockGenerateObject.mockImplementationOnce(async () =>
			buildGenerateObjectResponse(
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
							severity: "P1",
						}),
					],
				}),
			),
		);
		const r1 = await buildReview({
			octokit: prOctokit({ files: [aFile] }).octokit,
			...baseContext,
			headSha: sha1,
		});
		expect(r1?.event).toBe("REQUEST_CHANGES");
		expect(mockTriageReReview).not.toHaveBeenCalled();
		expect(r1?.comments).toHaveLength(1);

		// What GitHub holds after round 1: the review and its open inline thread.
		const posted = r1?.comments[0] as { body: string };
		const github = {
			reviews: [{ id: 1, state: "CHANGES_REQUESTED", body: r1?.body ?? "" }],
			files: [aFile],
			comments: [
				{
					id: 501,
					pull_request_review_id: 1,
					path: "src/a.ts",
					line: 5,
					body: posted.body,
				},
			],
			threadNodes: [
				{
					isResolved: false,
					resolvedBy: null,
					comments: {
						pageInfo: { hasNextPage: false },
						nodes: [
							{
								databaseId: 501,
								author: { login: "ai-review-bot", __typename: "Bot" },
								authorAssociation: "NONE",
								body: posted.body,
								createdAt: "2026-10-01T00:00:00Z",
							},
						],
					},
				},
			],
			compare: () => ({ status: "ahead", files: [aFile] }),
		};

		mockTriageReReview.mockResolvedValueOnce({
			recommendation: "SKIP",
			resolved: [],
			newRisk: false,
		});
		mockGenerateObject.mockClear();
		const round2 = prOctokit(github);
		const r2 = await buildReview({
			octokit: round2.octokit,
			...baseContext,
			headSha: sha2,
		});
		expect(r2).toBeNull();
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(round2.compareCalls).toEqual([`${sha1}...${sha2}`]);
		const open = mockTriageReReview.mock.calls[0]?.[2] as PersistedFinding[];
		expect(open.map((f) => f.id)).toEqual([bugId]);
		expect(open[0]?.severity).toBe("P1");
		expect(round2.checkRuns.map((c) => c.conclusion)).toEqual([
			"action_required",
		]);

		// Round 2 posted nothing, so round 3's baseline is still round 1's review.
		mockTriageReReview.mockResolvedValueOnce({
			recommendation: "INCREMENTAL",
			resolved: [bugId],
			newRisk: false,
		});
		mockGenerateObject.mockClear();
		routeModels({});
		const round3 = prOctokit(github);
		const r3 = await buildReview({
			octokit: round3.octokit,
			...baseContext,
			headSha: sha3,
		});
		expect(round3.compareCalls).toEqual([`${sha1}...${sha3}`]);
		expect(r3?.event).toBe("APPROVE");
		expect(r3?.body).not.toContain("Still open from the previous review");
		expect(r3?.body).toContain(`<!-- ai-review:sha=${sha3} -->`);
		expect(r3?.body).toContain("<!-- ai-review:review=2 -->");
	});

	it("SKIP with no KV posts nothing and re-stamps the check-run", async () => {
		routeModels({});
		mockTriageReReview.mockResolvedValue({
			recommendation: "SKIP",
			resolved: [],
			newRisk: false,
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { octokit, checkRuns, compareCalls } = prOctokit({
			reviews: [{ id: 11, body: buildOwnReviewBody({ sha: OLD, count: 1 }) }],
			compare: () => ({ status: "ahead", files: [bFile] }),
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
		expect(log).toHaveBeenCalledWith("review scope", {
			scope: "scope: delta from abcdef1 (github)",
			decision: "SKIP",
		});
		expect(decision).toBeNull();
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(checkRuns).toHaveLength(1);
		expect(checkRuns[0]?.head_sha).toBe(HEAD);
	});

	describe("carried findings with no path", () => {
		const p3Row = "| 🟢 | style | **Nit name** |";
		const p1Row = "| 🟠 | correctness | **Real bug** |";
		const failCompare = () => {
			throw new Error("gone");
		};

		it("a path-less P3 does not decide the verdict but stays listed", async () => {
			routeModels({});
			const { octokit } = prOctokit({
				reviews: [
					{
						id: 11,
						state: "CHANGES_REQUESTED",
						body: buildOwnReviewBody({ sha: OLD, count: 1, rows: [p3Row] }),
					},
				],
				compare: failCompare,
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("APPROVE");
			expect(decision?.body).toContain("**Nit name**");
		});

		it.each([
			["path-less P3", p3Row, "APPROVE"],
			["path-less P1", p1Row, "REQUEST_CHANGES"],
			["path-bearing P3", "| 🟢 | **Nit** (`src/a.ts:3`) |", "REQUEST_CHANGES"],
		])("forced run: a carried %s (row %s) gives %s on a clean result", async (_n, row, event) => {
			routeModels({});
			const { octokit } = prOctokit({
				reviews: [
					{
						id: 11,
						body: buildOwnReviewBody({ sha: OLD, count: 1, rows: [row] }),
					},
				],
			});

			const decision = await buildReview({
				octokit,
				...baseContext,
				force: true,
			});

			expect(decision?.event).toBe(event);
		});

		it("a path-less P1 blocks on a fallback round", async () => {
			routeModels({});
			const { octokit } = prOctokit({
				reviews: [
					{
						id: 11,
						body: buildOwnReviewBody({ sha: OLD, count: 1, rows: [p1Row] }),
					},
				],
				compare: failCompare,
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("REQUEST_CHANGES");
		});

		it("SKIP with only a path-less P3 open stamps success", async () => {
			routeModels({});
			mockTriageReReview.mockResolvedValue({
				recommendation: "SKIP",
				resolved: [],
				newRisk: false,
			});
			const { octokit, checkRuns, compareCalls } = prOctokit({
				reviews: [
					{
						id: 11,
						body: buildOwnReviewBody({ sha: OLD, count: 1, rows: [p3Row] }),
					},
				],
				compare: () => ({ status: "ahead", files: [bFile] }),
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
			expect(decision).toBeNull();
			expect(checkRuns[0]?.conclusion).toBe("success");
		});
	});

	it("a carried finding whose file left the PR is retired on a fallback round", async () => {
		const prompts = routeModels({ agent: withFresh() });
		const { octokit } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({
						sha: OLD,
						count: 1,
						rows: ["| 🟢 | **Stale nit** (`src/gone.ts:3`) |"],
					}),
				},
			],
			compare: () => {
				throw new Error("gone");
			},
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(prompts).toEqual([]);
		expect(decision?.event).toBe("COMMENT");
		expect(decision?.body).not.toContain("Still open from the previous review");
		expect(decision?.body).toContain("#### Retired, file no longer in this PR");
		expect(decision?.body).toContain("- P3 **Stale nit** (`src/gone.ts:3`)");
	});

	it("a carried finding on a renamed file is revalidated, not resolved as moot", async () => {
		const prompts = routeModels({});
		const { octokit } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({
						sha: OLD,
						count: 1,
						rows: ["| 🟠 | **Real bug** (`src/old.ts:3`) |"],
					}),
				},
			],
			files: [
				{
					filename: "src/new.ts",
					previous_filename: "src/old.ts",
					status: "renamed",
					patch: SIMPLE_PATCH,
				} as { filename: string; status: string; patch?: string },
			],
			compare: () => {
				throw new Error("gone");
			},
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("FILE: src/new.ts");
		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Real bug** (`src/new.ts:3`)");
	});

	describe("carried findings on a file that left the PR", () => {
		const GONE = "src/self-retraction.ts";
		const goneRows = [
			`| 🟠 | **Retraction scan is unbounded** (\`${GONE}:49\`) |`,
			`| 🟠 | **Negated phrases count as retractions** (\`${GONE}:73\`) |`,
			`| 🟡 | **Threshold is a magic number** (\`${GONE}:12\`) |`,
		];
		const goneTitles = [
			"Retraction scan is unbounded",
			"Negated phrases count as retractions",
			"Threshold is a magic number",
		];
		// PR #92 added the renamed file under src/replay/; the name differs so
		// the replay boundary test's text scan does not flag this file.
		const addedFile = buildPullFile(
			"src/replay/renamed-rule.ts",
			SIMPLE_PATCH,
			"added",
		);
		const pr92 = () =>
			prOctokit({
				reviews: [
					{
						id: 11,
						state: "CHANGES_REQUESTED",
						body: buildOwnReviewBody({ sha: OLD, count: 1, rows: goneRows }),
					},
				],
				files: [addedFile],
				compare: () => ({ status: "ahead", files: [addedFile] }),
			});

		it("a prior REQUEST_CHANGES review whose carried findings are all on a file that left the PR posts a non-blocking review", async () => {
			routeModels({});
			mockTriageReReview.mockResolvedValue({
				recommendation: "INCREMENTAL",
				resolved: [],
				newRisk: false,
			});
			const { octokit, compareCalls } = pr92();

			const decision = await buildReview({ octokit, ...baseContext });

			expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
			expect(decision).not.toBeNull();
			expect(decision?.event).not.toBe("REQUEST_CHANGES");
			expect(decision?.body).toContain("Retired, file no longer in this PR");
			expect(decision?.body).not.toContain(
				"Still open from the previous review",
			);
			for (const title of goneTitles) {
				expect(decision?.body).toContain(title);
			}
			expect(decision?.body).toContain(`\`${GONE}:49\``);
			// The next round derives its baseline from this body; a retired row
			// read back as open would block again.
			const derived = deriveBaseline(
				{ id: 12, body: decision?.body ?? "" },
				{ entries: [], reviewIds: [], warm: false },
				new Set(),
			);
			expect(derived?.state.lastReviewedSha).toBe(HEAD);
			const reread = derived?.state.findings.map((f) => f.title) ?? [];
			for (const title of goneTitles) {
				expect(reread.some((t) => t.includes(title))).toBe(false);
			}
		});

		it("keeps carrying a finding when the PR file list is incomplete", async () => {
			routeModels({});
			mockTriageReReview.mockResolvedValue({
				recommendation: "INCREMENTAL",
				resolved: [],
				newRisk: false,
			});
			const { octokit } = pr92();

			const decision = await buildReview({
				octokit,
				...baseContext,
				changedFiles: 2,
			});

			expect(decision?.event).toBe("REQUEST_CHANGES");
			expect(decision?.body).toContain("Still open from the previous review");
			expect(decision?.body).toContain(`\`${GONE}:49\``);
			expect(decision?.body).not.toContain(
				"Retired, file no longer in this PR",
			);
		});

		it("a triage SKIP does not hold the PR on findings whose file left the PR", async () => {
			routeModels({});
			mockTriageReReview.mockResolvedValue({
				recommendation: "SKIP",
				resolved: [],
				newRisk: false,
			});
			const { octokit, checkRuns } = pr92();

			const decision = await buildReview({ octokit, ...baseContext });

			expect(checkRuns.map((c) => c.conclusion)).not.toContain(
				"action_required",
			);
			expect(decision).not.toBeNull();
			expect(decision?.event).not.toBe("REQUEST_CHANGES");
			expect(decision?.body).toContain("Retired, file no longer in this PR");
		});

		it("retargets through previous_filename so a settled thread still suppresses", async () => {
			const TITLE = "Token cache never expires";
			const routes = routeModels({});
			const commentBody = `**P1** **${TITLE}**\n\nEntries in \`tokenCache\` are never evicted.`;
			const { octokit } = prOctokit({
				reviews: [
					{
						id: 11,
						state: "CHANGES_REQUESTED",
						body: buildOwnReviewBody({
							sha: OLD,
							count: 1,
							inline: "Inline comments: 1",
							rows: [`| 🟠 | **${TITLE}** (\`src/old.ts:3\`) |`],
						}),
					},
				],
				comments: [
					{
						id: 501,
						pull_request_review_id: 11,
						path: "src/new.ts",
						line: 3,
						body: commentBody,
					},
				],
				threadNodes: [
					{
						isResolved: false,
						resolvedBy: null,
						comments: {
							pageInfo: { hasNextPage: false },
							nodes: [
								{
									databaseId: 501,
									author: { login: "ai-review-bot", __typename: "Bot" },
									authorAssociation: "NONE",
									body: commentBody,
									createdAt: "2026-10-01T00:00:00Z",
								},
								{
									databaseId: 502,
									author: { login: "joe", __typename: "User" },
									authorAssociation: "OWNER",
									body: "This is intentional, the token is short-lived",
									createdAt: "2026-10-02T00:00:00Z",
								},
							],
						},
					},
				],
				files: [
					{
						filename: "src/new.ts",
						previous_filename: "src/old.ts",
						status: "renamed",
						patch: SIMPLE_PATCH,
					} as { filename: string; status: string; patch?: string },
				],
				compare: () => {
					throw new Error("gone");
				},
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(routes).toEqual([]);
			expect(decision?.event).not.toBe("REQUEST_CHANGES");
			expect(decision?.body).not.toContain(
				"Still open from the previous review",
			);
			expect(decision?.body).not.toContain(
				"Retired, file no longer in this PR",
			);
			expect(decision?.body).not.toContain(TITLE);
			expect(decision?.body).toContain(`<!-- ai-review:sha=${HEAD} -->`);
		});
	});

	it("approval text says carried non-blocking findings are still open", async () => {
		routeModels({});
		const { octokit } = prOctokit({
			reviews: [
				{
					id: 11,
					state: "CHANGES_REQUESTED",
					body: buildOwnReviewBody({
						sha: OLD,
						count: 1,
						rows: ["| 🟢 | style | **Nit name** |"],
					}),
				},
			],
			compare: () => {
				throw new Error("gone");
			},
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(decision?.event).toBe("APPROVE");
		expect(decision?.body).toContain(
			"No blocking issues. The findings listed below are still open but do not block.",
		);
		expect(decision?.body).not.toContain("have been resolved");
		expect(decision?.body).toContain("**Nit name**");
	});

	it("approval text keeps the existing headline when nothing is carried", async () => {
		routeModels({});
		const { octokit } = prOctokit({
			reviews: [
				{
					id: 11,
					state: "CHANGES_REQUESTED",
					body: buildOwnReviewBody({ sha: OLD, count: 1 }),
				},
			],
			compare: () => {
				throw new Error("gone");
			},
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(decision?.event).toBe("APPROVE");
		// ownBody has no full metadata block, so priorOwnReview is null and the
		// existing first-review headline applies.
		expect(decision?.body).toContain(
			"✅ No issues found. PR approved for merge.",
		);
		expect(decision?.body).not.toContain("No blocking issues.");
	});

	it("a base-branch merge in the compare is not reviewed or anchored", async () => {
		const mergedPatch = [
			"@@ -40,2 +40,3 @@",
			" line40",
			"+line41",
			" line42",
		].join("\n");
		routeModels({
			agent: buildModelReview({
				event: "COMMENT",
				inline_comments: [
					buildInlineComment({
						title: "Merged code issue",
						path: "src/a.ts",
						line: 41,
						start_line: null,
						severity: "P2",
					}),
				],
			}),
		});
		mockTriageReReview.mockResolvedValue({
			recommendation: "INCREMENTAL",
			resolved: [],
			newRisk: true,
		});
		const { octokit, compareCalls } = prOctokit({
			reviews: [{ id: 11, body: buildOwnReviewBody({ sha: OLD, count: 1 }) }],
			files: [aFile],
			compare: () => ({
				status: "ahead",
				files: [
					buildPullFile("src/a.ts", mergedPatch),
					buildPullFile("src/main-only.ts", SIMPLE_PATCH),
				],
			}),
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(compareCalls).toEqual([`${OLD}...${HEAD}`]);
		expect(reviewedFiles()).toEqual(["src/a.ts"]);
		expect(decision?.comments).toEqual([]);
		expect(decision?.body).toContain("could not be anchored");
		expect(decision?.body).toContain("`src/a.ts:41`");
	});

	it("the source is the latest own review with a sha marker", async () => {
		routeModels({});
		const { octokit } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({ sha: OLD, count: 1, rows: [blockerRow] }),
				},
				{ id: 12, body: "> ### ai-review-bot\n> quoted by a human" },
			],
			compare: () => {
				throw new Error("gone");
			},
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Blocker**");
		expect(decision?.body).toContain("scope: full (compare failed)");
	});

	it("a forced run ignores a throwing kv", async () => {
		const { client: kv } = spyKv(async () => {
			throw new Error("kv down");
		});
		routeModels({});
		const { octokit } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({ sha: OLD, count: 1, rows: [blockerRow] }),
				},
			],
		});

		const decision = await buildReview({
			octokit,
			...baseContext,
			kv,
			force: true,
		});

		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Blocker**");
		expect(decision?.body).toContain("<!-- ai-review:review=2 -->");
		expect(console.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("KV"),
			expect.anything(),
		);
	});

	it("an open inline finding flows from the ledger into the still-open block", async () => {
		routeModels({});
		const { octokit } = prOctokit({
			reviews: [
				{
					id: 11,
					body: buildOwnReviewBody({
						sha: OLD,
						count: 1,
						inline: "Inline comments: 1",
					}),
				},
			],
			comments: [
				{
					id: 501,
					pull_request_review_id: 11,
					path: "src/a.ts",
					line: 7,
					body: "**P2** **Leaky handle**\n\nThe handle is never closed.",
				},
			],
			compare: () => {
				throw new Error("gone");
			},
		});

		const decision = await buildReview({ octokit, ...baseContext });

		expect(decision?.event).toBe("REQUEST_CHANGES");
		expect(decision?.body).toContain("**Leaky handle** (`src/a.ts:7`)");
		expect(decision?.body).toContain("ledger: warm");
	});

	describe("pending coverage", () => {
		const SAST = "security-sast.md";
		const COMMENTS_SKILL = "comment-analyzer.md";
		const NEW_HEAD = "fedcba0987654321";
		const WHOLE = "files:src/a.ts,src/b.ts";
		const DELTA = "files:src/b.ts";
		const incremental = () =>
			mockTriageReReview.mockResolvedValue({
				recommendation: "INCREMENTAL",
				resolved: [],
				newRisk: true,
			});
		const deltaB = () => ({ status: "ahead", files: [bFile] });
		const schemaMismatch = () =>
			new NoObjectGeneratedError({
				message: "no object",
				text: "{not json",
				response: {} as never,
				usage: { inputTokens: 7, outputTokens: 3 } as never,
				finishReason: "stop" as never,
			});
		const withPending = (pending: string[], sha = OLD) =>
			buildOwnReviewBody({ sha, count: 1, pending });
		const pendingIn = (body: string | undefined) =>
			parseAgentsMarker(body ?? "", KNOWN_SKILLS)?.pending;
		/** Routes the mocked model by skill and records the user message each
		 * agent call was given. */
		function agents(replies: Record<string, (call: number) => unknown> = {}) {
			const seen: Record<string, string[]> = {};
			mockGenerateObject.mockImplementation(
				async (args: {
					prompt?: unknown;
					system?: unknown;
					messages?: Array<{ content: unknown }>;
				}) => {
					if (
						typeof args.prompt === "string" &&
						args.prompt.startsWith("You are checking")
					)
						return { object: { resolved: [] } };
					if (args.system !== undefined)
						return {
							object: { summary: "Summary." },
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					const content = args.messages?.[0]?.content as Array<{
						text: string;
					}>;
					const skill = content[1].text.replace(/^system:/, "");
					const calls = seen[skill] ?? [];
					calls.push(content[0].text);
					seen[skill] = calls;
					const reply = replies[skill];
					return reply
						? reply(calls.length)
						: buildGenerateObjectResponse(buildModelReview());
				},
			);
			return seen;
		}
		const fails = () => () => {
			throw schemaMismatch();
		};
		const finds = () => () => buildGenerateObjectResponse(withFresh());
		const messagesBuilt = () =>
			mockBuildUserMessage.mock.calls.map((c) => {
				const ctx = c[0] as {
					files: Array<{ filename: string }>;
					diffScope?: string;
				};
				return {
					files: ctx.files.map((f) => f.filename),
					incremental: ctx.diffScope?.startsWith("INCREMENTAL") ?? false,
				};
			});

		beforeEach(() => {
			mockBuildUserMessage.mockImplementation(
				(ctx: { files: Array<{ filename: string }> }) =>
					`files:${ctx.files.map((f) => f.filename).join(",")}`,
			);
		});

		it("an incremental round gives the pending skill the PR's files and the others the delta", async () => {
			const seen = agents({ [SAST]: finds() });
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(messagesBuilt()).toEqual([
				{ files: ["src/b.ts"], incremental: true },
				{ files: ["src/a.ts", "src/b.ts"], incremental: false },
			]);
			expect(seen[SAST]).toEqual([WHOLE]);
			for (const skill of TIER1_SKILLS.filter((s) => s !== SAST))
				expect(seen[skill]).toEqual([DELTA]);
			expect(decision?.body).toContain("Fresh issue");
			expect(pendingIn(decision?.body)).toEqual([]);
		});

		it("a pending skill gets the whole PR on its retry too; the delta never reaches it", async () => {
			const seen = agents({
				[SAST]: (n) =>
					n === 1
						? (() => {
								throw schemaMismatch();
							})()
						: buildGenerateObjectResponse(withFresh()),
			});
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(seen[SAST]).toEqual([WHOLE, WHOLE]);
			expect(pendingIn(decision?.body)).toEqual([]);
		});

		it("a clearing round posts although nothing else is new, and its marker drops the skill (no KV)", async () => {
			incremental();
			agents();
			const quiet = prOctokit({
				reviews: [{ id: 11, body: buildOwnReviewBody({ sha: OLD, count: 1 }) }],
				compare: deltaB,
			});
			expect(
				await buildReview({ octokit: quiet.octokit, ...baseContext }),
			).toBeNull();

			agents();
			const { octokit, checkRuns } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
			});
			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.event).toBe("APPROVE");
			expect(pendingIn(decision?.body)).toEqual([]);
			expect(checkRuns).toEqual([]);
		});

		it("a clearing round reviews the pending skill over the whole PR and posts the new head", async () => {
			const seen = agents();
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(seen[SAST]).toEqual([WHOLE]);
			expect(decision?.event).toBe("APPROVE");
			expect(pendingIn(decision?.body)).toEqual([]);
			expect(decision?.body).toContain(`<!-- ai-review:sha=${HEAD} -->`);
		});

		it("a legacy own review with no agents marker means none pending", async () => {
			const seen = agents({ [SAST]: finds() });
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: buildOwnReviewBody({ sha: OLD, count: 1 }) }],
				compare: deltaB,
			});

			await buildReview({ octokit, ...baseContext });

			expect(messagesBuilt()).toEqual([
				{ files: ["src/b.ts"], incremental: true },
			]);
			expect(seen[SAST]).toEqual([DELTA]);
		});

		it("a triage SKIP with a pending skill runs only that skill, over the whole PR", async () => {
			const seen = agents();
			mockTriageReReview.mockResolvedValue({
				recommendation: "SKIP",
				resolved: [],
				newRisk: false,
			});
			const { octokit, checkRuns } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(Object.keys(seen)).toEqual([SAST]);
			expect(seen[SAST]).toEqual([WHOLE]);
			expect(messagesBuilt()).toEqual([
				{ files: ["src/a.ts", "src/b.ts"], incremental: false },
			]);
			expect(decision?.event).toBe("APPROVE");
			expect(pendingIn(decision?.body)).toEqual([]);
			expect(checkRuns).toEqual([]);
		});

		it("a triage SKIP whose pending skill fails again posts nothing, re-stamps, and keeps it pending", async () => {
			mockTriageReReview.mockResolvedValue({
				recommendation: "SKIP",
				resolved: [],
				newRisk: false,
			});
			const reviews = [{ id: 11, body: withPending([SAST]) }];
			for (const headSha of [HEAD, NEW_HEAD]) {
				const seen = agents({ [SAST]: fails() });
				const { octokit, checkRuns } = prOctokit({ reviews, compare: deltaB });

				const decision = await buildReview({
					octokit,
					...baseContext,
					headSha,
				});

				// Nothing posted, so GitHub still lists the skill as pending and the
				// next push retries it.
				expect(decision).toBeNull();
				expect(Object.keys(seen)).toEqual([SAST]);
				expect(seen[SAST]).toHaveLength(2);
				expect(checkRuns).toHaveLength(1);
				expect(checkRuns[0]?.head_sha).toBe(headSha);
				expect(checkRuns[0]?.conclusion).toBe("neutral");
			}
		});

		it("a triage SKIP whose pending skill clears nothing and finds nothing keeps the SKIP verdict", async () => {
			const seen = agents();
			mockTriageReReview.mockResolvedValue({
				recommendation: "SKIP",
				resolved: [],
				newRisk: false,
			});
			const body = buildOwnReviewBody({
				sha: OLD,
				count: 1,
				rows: [blockerRow],
				pending: [SAST],
			});
			const { octokit, checkRuns } = prOctokit({
				reviews: [{ id: 11, body }],
				compare: deltaB,
				files: [
					aFile,
					bFile,
					{
						filename: "src/huge.ts",
						status: "modified",
						additions: 5000,
						deletions: 0,
					},
				],
				rawDiff: "",
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(Object.keys(seen)).toEqual([SAST]);
			expect(decision).toBeNull();
			expect(checkRuns).toHaveLength(1);
			expect(checkRuns[0]?.conclusion).toBe("action_required");
		});

		it("with both message versions, one delta agent warms the cache, then the pending skills, then the rest", async () => {
			const seen = agents();
			incremental();
			// Marker order (sast, comment-analyzer) differs from queue order.
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST, COMMENTS_SKILL]) }],
				compare: deltaB,
			});

			await buildReview({
				octokit,
				...baseContext,
				tier2Enabled: true,
				agentConcurrency: 2,
			});

			expect(Object.keys(seen)).toEqual([
				"code-reviewer.md",
				COMMENTS_SKILL,
				SAST,
				"silent-failure-hunter.md",
				"pr-test-analyzer.md",
				"code-review-and-quality.md",
			]);
			expect(seen["code-reviewer.md"]).toEqual([DELTA]);
		});

		it("with one message version, the pending skills go first", async () => {
			const seen = agents();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST, COMMENTS_SKILL]) }],
			});

			await buildReview({
				octokit,
				...baseContext,
				force: true,
				tier2Enabled: true,
				agentConcurrency: 2,
			});

			expect(Object.keys(seen)).toEqual([
				COMMENTS_SKILL,
				SAST,
				"code-reviewer.md",
				"silent-failure-hunter.md",
				"pr-test-analyzer.md",
				"code-review-and-quality.md",
			]);
		});

		it("a pending Tier 2 skill is not run while Tier 2 is off, and stays pending", async () => {
			const seen = agents({ "code-reviewer.md": finds() });
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([COMMENTS_SKILL]) }],
				compare: deltaB,
			});

			const decision = await buildReview({
				octokit,
				...baseContext,
				tier2Enabled: false,
			});

			expect(seen[COMMENTS_SKILL]).toBeUndefined();
			expect(pendingIn(decision?.body)).toEqual([COMMENTS_SKILL]);
		});

		it("a triage SKIP that needs a fresh approval runs every agent, the pending one over the whole PR", async () => {
			const seen = agents();
			mockTriageReReview.mockResolvedValue({
				recommendation: "SKIP",
				resolved: [],
				newRisk: false,
			});
			const { octokit, checkRuns } = prOctokit({
				reviews: [
					{ id: 11, body: withPending([SAST]), state: "CHANGES_REQUESTED" },
				],
				compare: deltaB,
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(seen[SAST]).toEqual([WHOLE]);
			for (const skill of TIER1_SKILLS.filter((s) => s !== SAST))
				expect(seen[skill]).toEqual([DELTA]);
			expect(decision?.event).toBe("APPROVE");
			expect(pendingIn(decision?.body)).toEqual([]);
			expect(checkRuns).toEqual([]);
		});

		it("a pending-only SKIP round whose skill finds something new posts, though it clears nothing", async () => {
			const seen = agents({ [SAST]: finds() });
			mockTriageReReview.mockResolvedValue({
				recommendation: "SKIP",
				resolved: [],
				newRisk: false,
			});
			const { octokit, checkRuns } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
				files: [
					aFile,
					bFile,
					{
						filename: "src/huge.ts",
						status: "modified",
						additions: 5000,
						deletions: 0,
					},
				],
				rawDiff: "",
			});

			const decision = await buildReview({
				octokit,
				...baseContext,
				changedFiles: 3,
			});

			expect(Object.keys(seen)).toEqual([SAST]);
			expect(decision?.body).toContain("Fresh issue");
			expect(pendingIn(decision?.body)).toEqual([SAST]);
			expect(checkRuns).toEqual([]);
		});

		it("a pending Tier 2 skill runs although the delta would not select it", async () => {
			const seen = agents();
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([COMMENTS_SKILL]) }],
				compare: deltaB,
			});

			const decision = await buildReview({
				octokit,
				...baseContext,
				tier2Enabled: true,
			});

			expect(Object.keys(seen).sort()).toEqual(
				[...TIER1_SKILLS, COMMENTS_SKILL].sort(),
			);
			expect(seen[COMMENTS_SKILL]).toEqual([WHOLE]);
			expect(seen[SAST]).toEqual([DELTA]);
			expect(pendingIn(decision?.body)).toEqual([]);
		});

		it("a pending skill whose file is gone is dropped", async () => {
			const seen = agents();
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending(["retired-skill.md", SAST]) }],
				compare: deltaB,
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(seen["retired-skill.md"]).toBeUndefined();
			expect(seen[SAST]).toEqual([WHOLE]);
			expect(mockBuildAgentSystemPrompt).not.toHaveBeenCalledWith(
				"retired-skill.md",
				expect.anything(),
				expect.anything(),
			);
			expect(pendingIn(decision?.body)).toEqual([]);
		});

		const bigFile = buildPullFile(
			"src/big.ts",
			`@@ -0,0 +1,1 @@\n+${"x".repeat(24_001)}`,
		);
		const many = Array.from({ length: 2998 }, (_, i) =>
			buildPullFile(`src/f${i}.ts`, SIMPLE_PATCH),
		);
		type PrInput = {
			files: Array<{
				filename: string;
				status: string;
				patch?: string;
				additions?: number;
				deletions?: number;
			}>;
			rawDiff?: string;
			changedFiles?: number;
		};
		const runWith = async (pr: PrInput) => {
			const seen = agents({ [SAST]: finds() });
			incremental();
			const { changedFiles, ...rest } = pr;
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
				...rest,
			});
			const decision = await buildReview({
				octokit,
				...baseContext,
				changedFiles: changedFiles ?? pr.files.length,
			});
			expect(seen[SAST]).toHaveLength(1);
			expect(seen[SAST]?.[0]).toContain("src/a.ts");
			expect(decision?.body).toContain("Fresh issue");
			return pendingIn(decision?.body);
		};
		it.each<[string, PrInput]>([
			[
				"a changed file without a patch",
				{
					files: [
						aFile,
						bFile,
						{
							filename: "src/huge.ts",
							status: "modified",
							additions: 5000,
							deletions: 10,
						},
					],
					rawDiff: "",
				},
			],
			[
				"a file list shorter than the PR's changed files",
				{ files: [aFile, bFile], changedFiles: 3 },
			],
			["a file list at the 3000-file cap", { files: [aFile, bFile, ...many] }],
		])("success on whole-PR input with %s stays pending, and its findings still merge", async (_name, pr) => {
			expect(await runWith(pr)).toEqual([SAST]);
		});

		it.each<[string, PrInput]>([
			[
				"an image",
				{
					files: [
						aFile,
						bFile,
						{
							filename: "logo.png",
							status: "added",
							additions: 0,
							deletions: 0,
						},
					],
					rawDiff: "",
				},
			],
			[
				"a pure rename",
				{
					files: [
						aFile,
						bFile,
						{
							filename: "src/moved.ts",
							status: "renamed",
							additions: 0,
							deletions: 0,
						},
					],
					rawDiff: "",
				},
			],
			["a patch trimmed by the size limit", { files: [aFile, bFile, bigFile] }],
			[
				"a lockfile with changes but no patch",
				{
					files: [
						aFile,
						bFile,
						{
							filename: "pnpm-lock.yaml",
							status: "modified",
							additions: 9000,
							deletions: 4000,
						},
					],
					rawDiff: "",
				},
			],
		])("whole-PR input with %s still clears the pending skill", async (_name, pr) => {
			expect(await runWith(pr)).toEqual([]);
		});

		const readinessOf = (body: string | undefined) =>
			Number(body?.match(/<!-- ai-review:readiness=(\d) -->/)?.[1]);
		const incompleteInput = {
			files: [
				aFile,
				bFile,
				{
					filename: "src/huge.ts",
					status: "modified",
					additions: 5000,
					deletions: 0,
				},
			],
			rawDiff: "",
		};
		const OWED_LINE = "`security-sast` still owes a review of the whole PR";

		it.each([
			["a forced run", { force: true }],
			["an incremental round", {}],
		])("%s with every agent ok but a pending skill left uncleared is partial, not an approval", async (_name, extra) => {
			agents();
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
				...incompleteInput,
			});

			const decision = await buildReview({
				octokit,
				...baseContext,
				changedFiles: 3,
				...extra,
			});

			expect(decision?.event).toBe("COMMENT");
			expect(readinessOf(decision?.body)).toBe(3);
			expect(decision?.body).toContain(OWED_LINE);
			expect(pendingIn(decision?.body)).toEqual([SAST]);
		});

		it.each([
			["a forced run", { force: true }],
			["an incremental round", {}],
		])("%s with complete input clears the skill and approves", async (_name, extra) => {
			agents();
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
			});

			const decision = await buildReview({
				octokit,
				...baseContext,
				...extra,
			});

			expect(decision?.event).toBe("APPROVE");
			expect(readinessOf(decision?.body)).toBe(5);
			expect(decision?.body).not.toContain("still owes");
			expect(pendingIn(decision?.body)).toEqual([]);
		});

		it("a triage SKIP with only a waiting Tier 2 skill pending re-stamps neutral, not success", async () => {
			agents();
			mockTriageReReview.mockResolvedValue({
				recommendation: "SKIP",
				resolved: [],
				newRisk: false,
			});
			const { octokit, checkRuns } = prOctokit({
				reviews: [{ id: 11, body: withPending([COMMENTS_SKILL]) }],
				compare: deltaB,
			});

			const decision = await buildReview({
				octokit,
				...baseContext,
				tier2Enabled: false,
			});

			expect(decision).toBeNull();
			expect(checkRuns.map((c) => c.conclusion)).toEqual(["neutral"]);
		});

		it("a forced FULL round clears by success", async () => {
			const seen = agents();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
			});

			const decision = await buildReview({
				octokit,
				...baseContext,
				force: true,
			});

			expect(messagesBuilt()).toEqual([
				{ files: ["src/a.ts", "src/b.ts"], incremental: false },
			]);
			expect(seen[SAST]).toEqual([WHOLE]);
			expect(decision?.body).toContain("scope: full (forced)");
			expect(pendingIn(decision?.body)).toEqual([]);
		});

		it("a recovery finding outside the delta keeps its inline anchor", async () => {
			agents({
				[SAST]: () =>
					buildGenerateObjectResponse(
						buildModelReview({
							event: "REQUEST_CHANGES",
							inline_comments: [
								buildInlineComment({
									path: "src/a.ts",
									line: 3,
									title: "Unvalidated input",
								}),
							],
						}),
					),
			});
			incremental();
			const { octokit } = prOctokit({
				reviews: [{ id: 11, body: withPending([SAST]) }],
				compare: deltaB,
			});

			const decision = await buildReview({ octokit, ...baseContext });

			expect(decision?.comments).toEqual([
				expect.objectContaining({ path: "src/a.ts", line: 3 }),
			]);
		});

		it("a skill that fails again stays pending and is retried once per round, with no extra round", async () => {
			incremental();
			const reviews = [{ id: 11, body: withPending([SAST]) }];

			const rounds: Array<{
				seen: Record<string, string[]>;
				decision: Awaited<ReturnType<typeof buildReview>>;
			}> = [];
			for (const headSha of [HEAD, NEW_HEAD]) {
				const seen = agents({ [SAST]: fails() });
				const { octokit } = prOctokit({ reviews, compare: deltaB });
				const decision = await buildReview({
					octokit,
					...baseContext,
					headSha,
				});
				rounds.push({ seen, decision });
				// What GitHub holds for the next push: this round's review.
				reviews.push({ id: 12, body: decision?.body ?? "" });
			}

			for (const { seen, decision } of rounds) {
				expect(seen[SAST]).toEqual([WHOLE, WHOLE]);
				for (const skill of TIER1_SKILLS.filter((s) => s !== SAST))
					expect(seen[skill]).toEqual([DELTA]);
				expect(decision?.event).toBe("COMMENT");
				expect(pendingIn(decision?.body)).toEqual([SAST]);
			}
			const last = rounds.at(-1)?.decision?.body;
			expect(last).toContain(`<!-- ai-review:sha=${NEW_HEAD} -->`);
			expect(last).toContain("<!-- ai-review:review=3 -->");
		});
	});
});

describe("classified agent failures with usage", () => {
	const noObject = (finishReason: string, text: string) =>
		new NoObjectGeneratedError({
			message: "no object",
			text,
			response: {} as never,
			usage: { inputTokens: 700, outputTokens: 30 } as never,
			finishReason: finishReason as never,
		});

	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function ctx() {
		return {
			octokit: {
				request: vi.fn(async (route: string) =>
					route.includes("/reviews") ? { data: [] } : { data: {} },
				),
				paginate: vi.fn(async () => []),
			} as never,
			owner: "o",
			repo: "r",
			pullNumber: 7,
			headSha: "abc",
			title: "t",
			body: null,
			additions: 0,
			deletions: 0,
			changedFiles: 0,
			labels: [],
			commentPrefix: "ai-review-bot",
			extraInstructions: "",
			force: true,
			provider: "anthropic" as const,
			feedbackEnabled: false,
			agentConcurrency: 1,
			agentBudgetMs: 600_000,
			tier2Enabled: false,
		};
	}

	const outcomeLogs = (log: { mock: { calls: unknown[][] } }) =>
		log.mock.calls
			.filter((c) => c[0] === "agent outcome")
			.map((c) => c as [string, Record<string, unknown>]);

	it("returns an error outcome with class, usage and duration", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		mockGenerateObject.mockRejectedValue(noObject("length", "{"));
		const out = await runAgent("code-reviewer.md", "S", sel, "");
		expect(out).toMatchObject({
			status: "error",
			failure: { class: "output_truncated", retryable: false },
			usage: { promptTokens: 700, completionTokens: 30 },
			message: "no object",
		});
		expect((out as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(
			0,
		);
	});

	it("leaves usage undefined when the error carries none", async () => {
		mockGenerateObject.mockRejectedValue(new Error("boom"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		const out = await runAgent("code-reviewer.md", "S", sel, "");
		expect(out).toMatchObject({ status: "error" });
		expect((out as { usage?: unknown }).usage).toBeUndefined();
	});

	it("keeps a deadline abort as skipped with no usage", async () => {
		const c = new AbortController();
		c.abort();
		mockGenerateObject.mockRejectedValue(noObject("length", "{"));
		const out = await runAgent("code-reviewer.md", "S", sel, "", {
			abortSignal: c.signal,
		});
		expect(out).toEqual({ status: "skipped", skillPath: "code-reviewer.md" });
	});

	it("counts failed-attempt tokens in cost and logs one record per agent", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const base = buildGenerateObjectResponse(
			buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
		);
		const ok = {
			...base,
			object: { ...base.object, summary: "s" },
			usage: { inputTokens: 100_000, outputTokens: 10_000 },
		};
		mockGenerateObject
			.mockRejectedValueOnce(noObject("length", "SECRET MODEL TEXT"))
			.mockResolvedValue(ok);
		const decision = await buildReview(ctx());
		const okCalls = mockGenerateObject.mock.calls.length - 1;
		const expected = computeCost(
			{
				promptTokens: okCalls * 100_000 + 700,
				completionTokens: okCalls * 10_000 + 30,
			},
			decision?.metadata.model ?? "",
		);
		expect(expected).toBeGreaterThan(0);
		expect(decision?.metadata.cost).toBeCloseTo(expected, 10);
		const recs = outcomeLogs(log);
		expect(recs).toHaveLength(TIER1_SKILLS.length);
		const failed = recs.find((c) => c[1].status === "error")?.[1];
		expect(failed).toMatchObject({
			owner: "o",
			repo: "r",
			pr: 7,
			sha: "abc",
			class: "output_truncated",
			inputTokens: 700,
			outputTokens: 30,
		});
		expect(JSON.stringify(recs)).not.toContain("SECRET MODEL TEXT");
		expect(failed).toMatchObject({ message: "no object" });
		expect(failed).not.toHaveProperty("text");
	});

	it("logs every record before the all-agents-failed throw", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		mockGenerateObject.mockRejectedValue(new Error("boom"));
		await expect(buildReview(ctx())).rejects.toThrow(
			"All review agents failed",
		);
		expect(outcomeLogs(log)).toHaveLength(TIER1_SKILLS.length);
	});

	it("logs records for an all-rate-limited round", async () => {
		vi.useFakeTimers();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		mockGenerateObject.mockRejectedValue(
			Object.assign(new Error("429"), {
				statusCode: 429,
				responseHeaders: { "retry-after": "42" },
			}),
		);
		const p = buildReview(ctx());
		await vi.runAllTimersAsync();
		expect((await p)?.event).toBe("RATE_LIMITED");
		const recs = outcomeLogs(log);
		expect(recs).toHaveLength(TIER1_SKILLS.length);
		expect(recs[0][1].status).toBe("rate_limited");
	});

	it("logs records for an all-quota-exhausted round", async () => {
		vi.useFakeTimers();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		mockGenerateObject.mockRejectedValue(
			Object.assign(new Error("insufficient_quota"), { statusCode: 429 }),
		);
		const p = buildReview(ctx());
		await vi.runAllTimersAsync();
		expect((await p)?.event).toBe("QUOTA_EXHAUSTED");
		const recs = outcomeLogs(log);
		expect(recs).toHaveLength(TIER1_SKILLS.length);
		expect(recs[0][1].status).toBe("quota_exhausted");
	});
	/** A programming error whose message and attached request body stand in
	 * for diff text that must never reach a log line or the review. */
	const bugWithDiff = () => {
		const bug = Object.assign(new TypeError("cannot read DIFF-IN-MESSAGE"), {
			requestBodyValues: { messages: "DIFF-IN-BODY" },
		});
		bug.stack = `TypeError: cannot read DIFF-IN-MESSAGE\nDIFF-IN-MESSAGE continued\n${"    at frame (src/review.ts:1:1)\n".repeat(200)}`;
		return bug;
	};

	it("an unknown failure carries a frames-only stack of at most 1500 characters", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		mockGenerateObject.mockRejectedValueOnce(bugWithDiff());
		const unknown = await runAgent("code-reviewer.md", "S", sel, "");
		expect(unknown).toMatchObject({
			status: "error",
			failure: { class: "unknown" },
		});
		const stack = (unknown as { stack?: string }).stack ?? "";
		expect(stack).toMatch(/^ {4}at frame/);
		expect(stack.length).toBeGreaterThan(1000);
		expect(stack.length).toBeLessThanOrEqual(1500);
		expect(stack).not.toContain("DIFF-IN");

		mockGenerateObject.mockRejectedValueOnce(noObject("stop", "{not json"));
		const mismatch = await runAgent("code-reviewer.md", "S", sel, "");
		expect(mismatch).toMatchObject({ failure: { class: "schema_mismatch" } });
		expect(mismatch).not.toHaveProperty("stack");
	});

	it("the console record of an unknown failure has the stack; other records and the review do not", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		mockGenerateObject.mockImplementation(
			async (args: { system?: unknown; messages?: unknown }) => {
				if (args.system !== undefined)
					return {
						object: { summary: "s" },
						usage: { inputTokens: 0, outputTokens: 0 },
					};
				const content = (args.messages as Array<{ content: unknown }>)[0]
					?.content as Array<{ text: string }>;
				if (content[1]?.text === "system:security-sast.md") throw bugWithDiff();
				return buildGenerateObjectResponse(buildModelReview());
			},
		);

		const decision = await buildReview(ctx());

		const records = outcomeLogs(log).map(([, r]) => r);
		const sast = records.filter((r) => r.skill === "security-sast.md");
		expect(sast).toHaveLength(1);
		expect(String(sast[0]?.stack)).toMatch(/^ {4}at frame/);
		for (const r of records.filter((r) => r.skill !== "security-sast.md"))
			expect(r).not.toHaveProperty("stack");
		const logged = JSON.stringify(log.mock.calls);
		expect(logged).not.toContain("DIFF-IN-BODY");
		expect(decision?.body).not.toContain("at frame");
		expect(decision?.body).not.toContain("DIFF-IN");
	});
});

describe("agent retry", () => {
	const noObject = (finishReason: string, text?: string) =>
		new NoObjectGeneratedError({
			message: "no object",
			text,
			response: {} as never,
			usage: { inputTokens: 700, outputTokens: 30 } as never,
			finishReason: finishReason as never,
		});
	// no_output and schema_mismatch are both sampled, so both are retryable.
	const noOutput = () => noObject("stop", undefined);
	const schemaMismatch = () => noObject("stop", "{not json");

	const okResponse = (
		titles: string[] = [],
		headers: Record<string, string> = {},
	) => ({
		object: buildModelReview({
			event: titles.length > 0 ? "REQUEST_CHANGES" : "COMMENT",
			general_findings: titles.map((title) => ({
				title,
				body: "real",
				severity: "P1",
				category: "style",
				confidence: 0.8,
				evidence: "See diff.",
				suppressible: true,
			})),
			inline_comments: [],
		}),
		usage: { inputTokens: 1000, outputTokens: 100 },
		response: { headers },
	});

	type Handler = (call: number, args: Record<string, unknown>) => unknown;
	const skillOf = (args: Record<string, unknown>): string => {
		const msgs = args.messages as Array<{ content: unknown }> | undefined;
		const content = msgs?.[0]?.content;
		if (!Array.isArray(content)) return "summary";
		return String((content[1] as { text: string }).text).replace(
			/^system:/,
			"",
		);
	};
	function route(handlers: Record<string, Handler>) {
		const calls: Record<string, number> = {};
		mockGenerateObject.mockImplementation(
			async (args: Record<string, unknown>) => {
				const skill = skillOf(args);
				if (skill === "summary") {
					return {
						object: { summary: "s" },
						usage: { inputTokens: 0, outputTokens: 0 },
					};
				}
				calls[skill] = (calls[skill] ?? 0) + 1;
				const h = handlers[skill];
				return h ? h(calls[skill], args) : okResponse();
			},
		);
		return calls;
	}

	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function ctx(overrides: Record<string, unknown> = {}) {
		return {
			octokit: {
				request: vi.fn(async (r: string) =>
					r.includes("/reviews") ? { data: [] } : { data: {} },
				),
				paginate: vi.fn(async () => []),
			} as never,
			owner: "o",
			repo: "r",
			pullNumber: 7,
			headSha: "abc",
			title: "t",
			body: null,
			additions: 0,
			deletions: 0,
			changedFiles: 0,
			labels: [],
			commentPrefix: "ai-review-bot",
			extraInstructions: "",
			force: true,
			provider: "anthropic" as const,
			feedbackEnabled: false,
			agentConcurrency: 1,
			agentBudgetMs: 600_000,
			tier2Enabled: false,
			...overrides,
		};
	}

	const recordsFor = (log: { mock: { calls: unknown[][] } }, skill: string) =>
		log.mock.calls
			.filter((c) => c[0] === "agent outcome")
			.map((c) => c[1] as Record<string, unknown>)
			.filter((r) => r.skill === skill);

	const retrySkippedWarned = (
		warn: { mock: { calls: unknown[][] } },
		skill: string,
	) =>
		warn.mock.calls.some(
			(c) =>
				c[0] === "agent retry skipped: out of time" &&
				(c[1] as { skill?: string }).skill === skill,
		);

	it("merges a recovered agent's findings, logs both attempts and bills both", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const calls = route({
			"code-reviewer.md": (n) => {
				if (n === 1) throw noOutput();
				return okResponse(["Recovered finding"]);
			},
		});
		const decision = await buildReview(ctx());
		expect(calls["code-reviewer.md"]).toBe(2);
		expect(decision?.body).toContain("Recovered finding");
		expect(decision?.body).toMatch(
			/failed, then recovered on retry: `code-reviewer`/,
		);
		expect(decision?.body).not.toContain("Partial review");
		const marker = parseAgentsMarker(decision?.body ?? "", KNOWN_SKILLS);
		expect(marker?.pending).toEqual([]);
		expect(
			marker?.records
				.filter((r) => r.skill === "code-reviewer.md")
				.map((r) => [r.attempt, r.status]),
		).toEqual([
			[1, "error"],
			[2, "ok"],
		]);
		const recs = recordsFor(log, "code-reviewer.md");
		expect(recs).toHaveLength(2);
		expect(recs[0]).toMatchObject({
			attempt: 1,
			status: "error",
			class: "no_output",
		});
		expect(recs[1]).toMatchObject({ attempt: 2, status: "ok" });
		const expected = computeCost(
			{
				promptTokens: TIER1_SKILLS.length * 1000 + 700,
				completionTokens: TIER1_SKILLS.length * 100 + 30,
			},
			decision?.metadata.model ?? "",
		);
		expect(decision?.metadata.cost).toBeCloseTo(expected, 10);
	});

	it("never reruns a non-retryable failure", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const calls = route({
			"code-reviewer.md": () => {
				throw noObject("length", "{");
			},
		});
		await buildReview(ctx());
		expect(calls["code-reviewer.md"]).toBe(1);
	});

	it("skips the retry at collection when less than 30s is left", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		// The failure is instant; the other four agents use up all but 20s.
		const burn = () => {
			now += 145_000;
			return okResponse();
		};
		const calls = route({
			"code-reviewer.md": () => {
				throw noOutput();
			},
			"silent-failure-hunter.md": burn,
			"pr-test-analyzer.md": burn,
			"security-sast.md": burn,
			"code-review-and-quality.md": burn,
		});
		const decision = await buildReview(ctx());
		expect(calls["code-reviewer.md"]).toBe(1);
		expect(retrySkippedWarned(warn, "code-reviewer.md")).toBe(true);
		expect(decision?.body).toMatch(
			/retry skipped, out of time: `code-reviewer`/,
		);
	});

	it("skips the retry when less time is left than the first attempt took", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const calls = route({
			"code-reviewer.md": () => {
				now += 310_000;
				throw noOutput();
			},
		});
		const decision = await buildReview(ctx());
		// 290s left is well over 30s, but under the 310s the first attempt took.
		expect(calls["code-reviewer.md"]).toBe(1);
		expect(retrySkippedWarned(warn, "code-reviewer.md")).toBe(true);
		expect(decision?.body).toMatch(
			/retry skipped, out of time: `code-reviewer`/,
		);
	});

	it("cancels the retry when pacing uses up the time that made it eligible", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const calls = route({
			"code-reviewer.md": () => {
				throw noOutput();
			},
			// Last agent of the first pass: leaves 70s and asks for a 50s pause.
			"code-review-and-quality.md": () => {
				vi.setSystemTime(Date.now() + 530_000);
				return okResponse([], { "retry-after": "50" });
			},
		});
		const p = buildReview(ctx());
		await vi.runAllTimersAsync();
		const decision = await p;
		expect(calls["code-reviewer.md"]).toBe(1);
		expect(retrySkippedWarned(warn, "code-reviewer.md")).toBe(true);
		expect(decision?.body).toMatch(
			/retry skipped, out of time: `code-reviewer`/,
		);
	});

	it("paces the retry pass's first agent from the first pass's rate limit", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => {});
		let firstPassEnd = 0;
		let retryAt = 0;
		const calls = route({
			"code-reviewer.md": (n) => {
				if (n === 1) throw noOutput();
				retryAt = Date.now();
				return okResponse();
			},
			"code-review-and-quality.md": () => {
				firstPassEnd = Date.now();
				return okResponse([], { "retry-after": "50" });
			},
		});
		const p = buildReview(ctx());
		await vi.runAllTimersAsync();
		await p;
		expect(calls["code-reviewer.md"]).toBe(2);
		expect(retryAt - firstPassEnd).toBeGreaterThanOrEqual(50_000);
	});

	it("keeps the second attempt's class when the retry fails too", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		route({
			"code-reviewer.md": (n) => {
				throw n === 1 ? noOutput() : schemaMismatch();
			},
		});
		const decision = await buildReview(ctx());
		const recs = recordsFor(log, "code-reviewer.md");
		expect(recs.map((r) => [r.attempt, r.class])).toEqual([
			[1, "no_output"],
			[2, "schema_mismatch"],
		]);
		expect(decision?.body).toMatch(
			/failed after retry: `code-reviewer` \(schema_mismatch\)/,
		);
	});

	it("builds the retry's abort signal from the original absolute deadline", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const timeout = vi.spyOn(AbortSignal, "timeout");
		route({
			"code-reviewer.md": (n) => {
				if (n === 1) {
					now += 100_000;
					throw noOutput();
				}
				return okResponse();
			},
		});
		await buildReview(ctx({ agentBudgetMs: 600_000 }));
		expect(timeout).toHaveBeenCalledTimes(TIER1_SKILLS.length + 1);
		// Deadline is t=600s; the retry starts at t=100s, so 500s remain. A
		// fresh budget would give 600s.
		expect(timeout.mock.calls.at(-1)?.[0]).toBe(500_000);
	});

	it("does not run the retry pass's first agent alone", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const events: string[] = [];
		route({
			"code-reviewer.md": async (n) => {
				if (n === 1) throw noOutput();
				events.push("a-start");
				await new Promise((r) => setTimeout(r, 20));
				events.push("a-end");
				return okResponse();
			},
			"silent-failure-hunter.md": (n) => {
				if (n === 1) throw noOutput();
				events.push("b-start");
				return okResponse();
			},
		});
		await buildReview(ctx({ agentConcurrency: 4 }));
		expect(events).toEqual(["a-start", "b-start", "a-end"]);
	});

	it("does not retry rate-limited, quota-exhausted or deadline-aborted agents", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const real = AbortSignal.timeout.bind(AbortSignal);
		let signals = 0;
		// The third agent's call gets an already-fired deadline signal.
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
			++signals === 3 ? AbortSignal.abort() : real(ms),
		);
		const calls = route({
			"code-reviewer.md": () => {
				throw Object.assign(new Error("429"), {
					statusCode: 429,
					responseHeaders: {},
				});
			},
			"silent-failure-hunter.md": () => {
				throw Object.assign(new Error("insufficient_quota"), {
					statusCode: 429,
				});
			},
			"pr-test-analyzer.md": () => {
				throw noOutput();
			},
		});
		await buildReview(ctx());
		expect(calls["code-reviewer.md"]).toBe(1);
		expect(calls["silent-failure-hunter.md"]).toBe(1);
		expect(calls["pr-test-analyzer.md"]).toBe(1);
	});

	const collected = (log: { mock: { calls: unknown[][] } }) =>
		log.mock.calls.find((c) => c[0] === "agent results collected")?.[1] as
			| Record<string, number>
			| undefined;
	const retrySkipWarns = (
		warn: { mock: { calls: unknown[][] } },
		skill: string,
	) =>
		warn.mock.calls.filter(
			(c) =>
				c[0] === "agent retry skipped: out of time" &&
				(c[1] as { skill?: string }).skill === skill,
		).length;

	it("keeps the first error when the retry is aborted at the deadline", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const real = AbortSignal.timeout.bind(AbortSignal);
		let signals = 0;
		// The retry is the sixth dispatch; it gets an already-fired deadline.
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
			++signals === TIER1_SKILLS.length + 1 ? AbortSignal.abort() : real(ms),
		);
		route({
			"code-reviewer.md": () => {
				throw noOutput();
			},
		});
		const decision = await buildReview(ctx());
		const recs = recordsFor(log, "code-reviewer.md");
		expect(recs.map((r) => [r.attempt, r.status, r.class])).toEqual([
			[1, "error", "no_output"],
			[2, "skipped", undefined],
		]);
		// Final result is the first attempt's error: in errored, not skipped.
		const lines = (decision?.body ?? "")
			.split("\n")
			.filter((l) => l.includes("`code-reviewer`") && l.startsWith(">"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("retry skipped, out of time");
		expect(decision?.body).not.toContain("did not run");
		const marker = parseAgentsMarker(decision?.body ?? "", KNOWN_SKILLS);
		expect(
			marker?.records
				.filter((r) => r.skill === "code-reviewer.md")
				.map((r) => [r.attempt, r.status]),
		).toEqual([[1, "error"]]);
		expect(marker?.pending).toEqual(["code-reviewer.md"]);
		expect(collected(log)).toMatchObject({ errored: 1 });
		// And in retrySkipped, with exactly one warning.
		expect(retrySkipWarns(warn, "code-reviewer.md")).toBe(1);
	});

	it.each([
		[
			"rate limited",
			() =>
				Object.assign(new Error("429"), {
					statusCode: 429,
					responseHeaders: {},
				}),
			"rate_limited",
			{ rateLimited: 1, quotaExhausted: 0, errored: 0 },
		],
		[
			"quota exhausted",
			() => Object.assign(new Error("insufficient_quota"), { statusCode: 429 }),
			"quota_exhausted",
			{ rateLimited: 0, quotaExhausted: 1, errored: 0 },
		],
	])("takes a %s retry as the final outcome and still bills attempt 1", async (_label, refusal, status, counts) => {
		vi.useFakeTimers();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		route({
			"code-reviewer.md": (n) => {
				throw n === 1 ? noOutput() : refusal();
			},
		});
		const p = buildReview(ctx());
		await vi.runAllTimersAsync();
		const decision = await p;
		const recs = recordsFor(log, "code-reviewer.md");
		expect(recs.map((r) => [r.attempt, r.status])).toEqual([
			[1, "error"],
			[2, status],
		]);
		expect(collected(log)).toMatchObject(counts);
		expect(decision?.body).toMatch(/Partial review/);
		expect(decision?.body).toContain(`\`code-reviewer\``);
		expect(decision?.body).toContain("<!-- ai-review:readiness=3 -->");
		const expected = computeCost(
			{
				promptTokens: (TIER1_SKILLS.length - 1) * 1000 + 700,
				completionTokens: (TIER1_SKILLS.length - 1) * 100 + 30,
			},
			decision?.metadata.model ?? "",
		);
		expect(decision?.metadata.cost).toBeCloseTo(expected, 10);
	});

	it("does not pace for a retry already ruled out at collection", async () => {
		vi.useFakeTimers();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const calls = route({
			// Took 310s, leaving 290s: ineligible at collection.
			"code-reviewer.md": () => {
				vi.setSystemTime(Date.now() + 310_000);
				throw noOutput();
			},
			"code-review-and-quality.md": () =>
				okResponse([], { "retry-after": "50" }),
		});
		const p = buildReview(ctx());
		await vi.runAllTimersAsync();
		await p;
		expect(calls["code-reviewer.md"]).toBe(1);
		expect(retrySkipWarns(warn, "code-reviewer.md")).toBe(1);
		expect(
			log.mock.calls.some((c) => c[0] === "pacing before next agent"),
		).toBe(false);
	});

	it.each([
		["exactly the first attempt's duration left", 300_000, 0, 2],
		["1ms under the first attempt's duration", 300_000, 1, 1],
		["exactly 30s left", 0, 570_000, 2],
		["1ms under 30s", 0, 570_001, 1],
	])("retry window boundary: %s", async (_label, firstMs, burnMs, expectedCalls) => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const calls = route({
			"code-reviewer.md": (n) => {
				if (n > 1) return okResponse();
				now += firstMs;
				throw noOutput();
			},
			"code-review-and-quality.md": () => {
				now += burnMs;
				return okResponse();
			},
		});
		await buildReview(ctx({ agentBudgetMs: firstMs * 2 || 600_000 }));
		expect(calls["code-reviewer.md"]).toBe(expectedCalls);
	});

	it("logs the skill, not a restarted index, when pacing a retry", async () => {
		vi.useFakeTimers();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		route({
			"code-reviewer.md": (n) => {
				if (n === 1) throw noOutput();
				return okResponse();
			},
			"code-review-and-quality.md": () =>
				okResponse([], { "retry-after": "5" }),
		});
		const p = buildReview(ctx());
		await vi.runAllTimersAsync();
		await p;
		const pacing = log.mock.calls.filter(
			(c) => c[0] === "pacing before next agent",
		);
		expect(pacing.map((c) => c[1])).toEqual([
			{ skill: "code-reviewer.md", delayMs: 5000 },
		]);
	});
});
