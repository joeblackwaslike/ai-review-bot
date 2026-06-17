import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KvClient } from "./feedback/kv.js";
import {
	buildReview,
	buildReviewComments,
	collectRightSideLines,
	computePaceDelayMs,
	generateSummary,
	mergeReviews,
	runAgent,
} from "./review.js";
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
	agentConcurrency: 1,
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
		expect(parts[1].text).toBe("system"); // skill block from mocked buildAgentSystemPrompt
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
			tier2Enabled: false,
		});
		await vi.runAllTimersAsync();
		const decision = await promise;

		expect(decision?.event).toBe("RATE_LIMITED");
		expect(decision?.rateLimitResetAt).toBe("2026-06-09T07:21:30Z");
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
