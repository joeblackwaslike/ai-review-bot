import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { persistPostedComments } from "./feedback/persist.js";
import {
	buildPRSummarySection,
	injectPRSection,
	maybeSubmitReview,
	runScheduledReview,
	selectReviewDelayMs,
} from "./github-app.js";
import { buildReview } from "./review.js";
import type { ReviewRunMessage } from "./scheduler.js";
import { buildPullRequestPayload } from "./testing.js";

const DEFAULT_METADATA = {
	model: "claude-sonnet-4-6",
	tier1Count: 5,
	tier2Skills: [] as string[],
	generalFindings: 0,
	inlineComments: 0,
	cost: 0.001234,
};

const mockBuildReview = vi.hoisted(() => vi.fn());

vi.mock("./config.js", () => ({
	getConfig: () => ({
		appId: "1",
		privateKey: "pem",
		webhookSecret: "secret",
		reviewEnabled: true,
		reviewCommentPrefix: "ai-review-bot",
		reviewCommand: "/ai-review",
		provider: "anthropic",
		agentConcurrency: 1,
		tier2Enabled: false,
	}),
}));

vi.mock("./review.js", () => ({
	buildReview: mockBuildReview,
}));

vi.mock("./feedback/persist.js", () => ({
	persistPostedComments: vi.fn(async () => 1),
}));

// Backing store for the fake KV so the idempotency claim is exercised for real.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock("./feedback/kv.js", () => ({
	createUpstashKv: vi.fn(() => ({
		setNx: async (key: string, value: string, ttlSeconds: number) => {
			// Guard the TTL contract so a caller that forgets it (0/undefined) — which
			// would set a never-expiring key in production Upstash — fails the test
			// instead of silently diverging. Expiry itself is covered in kv.fake.test.ts.
			if (!(ttlSeconds > 0)) {
				throw new Error(
					`setNx requires a positive ttlSeconds, got ${ttlSeconds}`,
				);
			}
			if (kvStore.has(key)) return false;
			kvStore.set(key, value);
			return true;
		},
		del: async (...keys: string[]) => {
			for (const key of keys) kvStore.delete(key);
		},
		get: async (key: string) => kvStore.get(key) ?? null,
		set: async (key: string, value: string) => {
			kvStore.set(key, value);
		},
	})),
}));

function buildMockApp() {
	const request = vi.fn().mockResolvedValue({ data: {} });
	const octokit = { request };
	const app = {
		getInstallationOctokit: vi.fn().mockResolvedValue(octokit),
	} as never;
	return { app, octokit, request };
}

const pr = buildPullRequestPayload().pull_request;

const baseArgs = {
	installationId: 123,
	owner: "owner",
	repo: "repo",
	pullNumber: 1,
	pullRequest: pr,
	extraInstructions: "",
	force: false,
	config: {
		appId: "1",
		privateKey: "pem",
		webhookSecret: "secret",
		reviewEnabled: true,
		reviewDelayMs: 0,
		reviewResyncDelayMs: 0,
		reviewCommentPrefix: "ai-review-bot",
		reviewCommand: "/ai-review",
		provider: "anthropic" as const,
		feedbackEnabled: false,
		agentConcurrency: 1,
		tier2Enabled: false,
	},
};

describe("maybeSubmitReview", () => {
	beforeEach(() => {
		kvStore.clear();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not run a second review for the same commit (idempotency claim)", async () => {
		const { app, octokit } = buildMockApp();
		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		await maybeSubmitReview({ app, ...baseArgs });
		await maybeSubmitReview({ app, ...baseArgs });

		// The second invocation is blocked by the claim before the agents run.
		expect(mockBuildReview).toHaveBeenCalledTimes(1);
		const reviewPosts = octokit.request.mock.calls.filter(
			([route]) =>
				route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		);
		expect(reviewPosts).toHaveLength(1);
	});

	it("releases the claim when no review is posted so a retry can run", async () => {
		const { app } = buildMockApp();
		// First pass skips (already reviewed) — claim must be released.
		mockBuildReview.mockReset().mockResolvedValue(null);
		await maybeSubmitReview({ app, ...baseArgs });

		// Second pass on the same commit should not be blocked by a stale claim.
		mockBuildReview.mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});
		await maybeSubmitReview({ app, ...baseArgs });

		expect(mockBuildReview).toHaveBeenCalledTimes(2);
	});

	it("releases the claim when buildReview throws, so a retry can run", async () => {
		const { app } = buildMockApp();
		mockBuildReview.mockReset().mockRejectedValueOnce(new Error("agent boom"));

		await expect(maybeSubmitReview({ app, ...baseArgs })).rejects.toThrow(
			"agent boom",
		);

		// Assert the claim was actually released by the finally block — not merely
		// absent because beforeEach cleared the store. The throwing run above set
		// the claim via setNx; the finally must have deleted it.
		const claimKey = `review-claim:${baseArgs.config.provider}:${baseArgs.owner}/${baseArgs.repo}#${baseArgs.pullNumber}@${pr.head.sha}`;
		expect(kvStore.has(claimKey)).toBe(false);

		// The failed run must not lock the commit out of a retry.
		mockBuildReview.mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});
		await maybeSubmitReview({ app, ...baseArgs });

		expect(mockBuildReview).toHaveBeenCalledTimes(2);
	});

	it("skips submission for draft PRs", async () => {
		const { app, octokit } = buildMockApp();
		mockBuildReview.mockReset();

		await maybeSubmitReview({
			app,
			...baseArgs,
			pullRequest: { ...pr, draft: true },
		});

		expect(mockBuildReview).not.toHaveBeenCalled();
		expect(octokit.request).not.toHaveBeenCalled();
	});

	it("skips submission when buildReview returns null (already reviewed)", async () => {
		const { app, octokit } = buildMockApp();
		mockBuildReview.mockReset().mockResolvedValue(null);

		await maybeSubmitReview({ app, ...baseArgs });

		expect(octokit.request).not.toHaveBeenCalled();
	});

	it("posts review with inline comments on success", async () => {
		const { app, octokit } = buildMockApp();
		const review = {
			event: "REQUEST_CHANGES" as const,
			body: "Found issues.",
			comments: [
				{
					path: "src/file.ts",
					line: 2,
					side: "RIGHT" as const,
					body: "Fix this.",
				},
			],
			metadata: {
				...DEFAULT_METADATA,
				generalFindings: 1,
				inlineComments: 1,
			},
		};
		mockBuildReview.mockReset().mockResolvedValue(review);

		await maybeSubmitReview({ app, ...baseArgs });

		const [route, params] = octokit.request.mock.calls[0];
		expect(route).toBe(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		);
		expect(params.comments).toEqual(review.comments);
		expect(params.event).toBe("REQUEST_CHANGES");

		const [patchRoute] = octokit.request.mock.calls[1];
		expect(patchRoute).toBe("PATCH /repos/{owner}/{repo}/pulls/{pull_number}");

		const [checkRoute] = octokit.request.mock.calls[2];
		expect(checkRoute).toBe("POST /repos/{owner}/{repo}/check-runs");
	});

	it("retries POST up to 3 times on failure before succeeding", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		// Fail twice, succeed on the third attempt
		request
			.mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
			.mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
			.mockResolvedValue({ data: {} });

		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [
				{
					path: "src/file.ts",
					line: 2,
					side: "RIGHT" as const,
					body: "Comment.",
				},
			],
			metadata: DEFAULT_METADATA,
		});

		const promise = maybeSubmitReview({ app, ...baseArgs });
		await vi.runAllTimersAsync();
		await promise;

		// 3 review POST attempts + 1 PATCH (PR desc) + 1 POST (check run)
		expect(request).toHaveBeenCalledTimes(5);
		const reviewRoutes = request.mock.calls.slice(0, 3).map(([route]) => route);
		expect(
			reviewRoutes.every(
				(r) => r === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			),
		).toBe(true);
		expect(request.mock.calls[3][0]).toBe(
			"PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
		);
		expect(request.mock.calls[4][0]).toBe(
			"POST /repos/{owner}/{repo}/check-runs",
		);
	});

	it("posts an actionable rate-limit comment and no review on RATE_LIMITED", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "RATE_LIMITED",
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: {
				model: "claude-sonnet-4-6",
				tier1Count: 5,
				tier2Skills: [],
				generalFindings: 0,
				inlineComments: 0,
				cost: 0,
			},
			rateLimitResetAt: "2026-06-09T07:21:30Z",
		});
		const requests: Array<{ route: string; params: Record<string, unknown> }> =
			[];
		const octokitLocal = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests.push({ route, params });
				return { data: {} };
			}),
		};
		const appLocal = {
			getInstallationOctokit: vi.fn(async () => octokitLocal),
		} as never;

		await maybeSubmitReview({
			app: appLocal,
			installationId: 1,
			owner: "o",
			repo: "r",
			pullNumber: 7,
			pullRequest: {
				draft: false,
				head: { sha: "sha" },
				additions: 0,
				deletions: 0,
				changed_files: 0,
				title: "t",
				body: null,
			},
			extraInstructions: "",
			force: true,
			config: {
				...baseArgs.config,
				reviewEnabled: true,
				reviewCommentPrefix: "ai-review-bot",
			},
		});

		const comment = requests.find((r) =>
			r.route.includes("/issues/{issue_number}/comments"),
		);
		expect(comment?.params.body).toContain("2026-06-09T07:21:30Z");
		expect(
			requests.some((r) => r.route.includes("/pulls/{pull_number}/reviews")),
		).toBe(false);
	});

	it("posts fallback comment with findings when all retries are exhausted", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		// All 3 review attempts fail; 4th call (fallback comment) succeeds
		request
			.mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
			.mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
			.mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
			.mockResolvedValue({ data: {} });

		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [
				{
					path: "src/file.ts",
					line: 2,
					side: "RIGHT" as const,
					body: "Inline comment.",
				},
			],
			metadata: DEFAULT_METADATA,
		});

		const promise = maybeSubmitReview({ app, ...baseArgs }).catch(() => {});
		await vi.runAllTimersAsync();
		await promise;

		// 3 review attempts + 1 fallback comment (no PATCH — review failed)
		expect(request).toHaveBeenCalledTimes(4);

		const [fallbackRoute, fallbackParams] = request.mock.calls[3];
		expect(fallbackRoute).toBe(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(fallbackParams.body).toContain("⚠️");
		expect(fallbackParams.body).toContain("422 Unprocessable Entity");
		expect(fallbackParams.body).toContain("Review body.");
		expect(fallbackParams.body).toContain("src/file.ts:2");
	});

	it("keeps the claim after a successful fallback comment so the commit is not re-billed", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		// All 3 review POSTs fail; the 4th call (fallback comment) succeeds.
		request
			.mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
			.mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
			.mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
			.mockResolvedValue({ data: {} });
		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		const promise = maybeSubmitReview({ app, ...baseArgs }).catch(() => {});
		await vi.runAllTimersAsync();
		await promise;

		// Findings were delivered via the fallback comment, so the claim must be
		// retained (TTL backstop only) — releasing it would let a redelivery re-run
		// the agents and double-bill the same commit.
		const claimKey = `review-claim:${baseArgs.config.provider}:${baseArgs.owner}/${baseArgs.repo}#${baseArgs.pullNumber}@${pr.head.sha}`;
		expect(kvStore.has(claimKey)).toBe(true);
	});

	it("releases the claim when the RATE_LIMITED fallback comment POST throws", async () => {
		const { app, request } = buildMockApp();
		// The rate-limit fallback comment POST fails. Because a rate-limited run
		// spends no model budget, the outer finally must still release the claim
		// so the commit stays eligible for retry on the next delivery.
		request.mockRejectedValue(new Error("503 Service Unavailable"));
		mockBuildReview.mockReset().mockResolvedValue({
			event: "RATE_LIMITED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			rateLimitResetAt: "2026-06-09T07:21:30Z",
		});

		await maybeSubmitReview({ app, ...baseArgs }).catch(() => {});

		const claimKey = `review-claim:${baseArgs.config.provider}:${baseArgs.owner}/${baseArgs.repo}#${baseArgs.pullNumber}@${pr.head.sha}`;
		expect(kvStore.has(claimKey)).toBe(false);
	});

	it("persists posted comments when feedbackEnabled and a review with comments is posted", async () => {
		(buildReview as ReturnType<typeof vi.fn>).mockResolvedValue({
			event: "COMMENT",
			body: "b",
			comments: [{ path: "src/x.ts", line: 10, body: "c", side: "RIGHT" }],
			validLinesByPath: new Map(),
			metadata: {
				model: "m",
				tier1Count: 5,
				tier2Skills: [],
				generalFindings: 0,
				inlineComments: 1,
				cost: 0,
			},
			commentProvenance: new Map([
				["src/x.ts:10", { skills: ["code-reviewer.md"], title: "Bug" }],
			]),
		});
		const octokit = {
			request: vi.fn(async (route: string) =>
				route.includes("/reviews") ? { data: { id: 55 } } : { data: {} },
			),
			paginate: vi.fn(async () => []),
		};
		const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;

		await maybeSubmitReview({
			app,
			installationId: 5,
			owner: "o",
			repo: "r",
			pullNumber: 7,
			pullRequest: {
				draft: false,
				head: { sha: "sha" },
				additions: 0,
				deletions: 0,
				changed_files: 0,
				title: "t",
				body: null,
			},
			extraInstructions: "",
			force: true,
			config: {
				reviewEnabled: true,
				reviewCommentPrefix: "ai-review-bot",
				provider: "anthropic",
				feedbackEnabled: true,
			} as never,
		});

		expect(persistPostedComments).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: "o",
				repo: "r",
				pr: 7,
				reviewId: 55,
				installationId: 5,
				provider: "anthropic",
				headSha: "sha",
				provenance: new Map([
					["src/x.ts:10", { skills: ["code-reviewer.md"], title: "Bug" }],
				]),
			}),
		);
	});

	it("does NOT persist when feedbackEnabled is false", async () => {
		(persistPostedComments as ReturnType<typeof vi.fn>).mockClear();
		(buildReview as ReturnType<typeof vi.fn>).mockResolvedValue({
			event: "COMMENT",
			body: "b",
			comments: [{ path: "src/x.ts", line: 10, body: "c", side: "RIGHT" }],
			validLinesByPath: new Map(),
			metadata: {
				model: "m",
				tier1Count: 5,
				tier2Skills: [],
				generalFindings: 0,
				inlineComments: 1,
				cost: 0,
			},
			commentProvenance: new Map([
				["src/x.ts:10", { skills: ["code-reviewer.md"], title: "Bug" }],
			]),
		});
		const octokit = {
			request: vi.fn(async (route: string) =>
				route.includes("/reviews") ? { data: { id: 55 } } : { data: {} },
			),
			paginate: vi.fn(async () => []),
		};
		const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;
		await maybeSubmitReview({
			app,
			installationId: 5,
			owner: "o",
			repo: "r",
			pullNumber: 7,
			pullRequest: {
				draft: false,
				head: { sha: "sha" },
				additions: 0,
				deletions: 0,
				changed_files: 0,
				title: "t",
				body: null,
			},
			extraInstructions: "",
			force: true,
			config: {
				reviewEnabled: true,
				reviewCommentPrefix: "ai-review-bot",
				provider: "anthropic",
				feedbackEnabled: false,
			} as never,
		});
		expect(persistPostedComments).not.toHaveBeenCalled();
	});

	it("a persistence failure does not fail the review", async () => {
		(persistPostedComments as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("kv down"),
		);
		(buildReview as ReturnType<typeof vi.fn>).mockResolvedValue({
			event: "COMMENT",
			body: "b",
			comments: [{ path: "src/x.ts", line: 10, body: "c", side: "RIGHT" }],
			validLinesByPath: new Map(),
			metadata: {
				model: "m",
				tier1Count: 5,
				tier2Skills: [],
				generalFindings: 0,
				inlineComments: 1,
				cost: 0,
			},
			commentProvenance: new Map([
				["src/x.ts:10", { skills: ["x"], title: "t" }],
			]),
		});
		const octokit = {
			request: vi.fn(async (route: string) =>
				route.includes("/reviews") ? { data: { id: 55 } } : { data: {} },
			),
			paginate: vi.fn(async () => []),
		};
		const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;
		await expect(
			maybeSubmitReview({
				app,
				installationId: 5,
				owner: "o",
				repo: "r",
				pullNumber: 7,
				pullRequest: {
					draft: false,
					head: { sha: "sha" },
					additions: 0,
					deletions: 0,
					changed_files: 0,
					title: "t",
					body: null,
				},
				extraInstructions: "",
				force: true,
				config: {
					reviewEnabled: true,
					reviewCommentPrefix: "ai-review-bot",
					provider: "anthropic",
					feedbackEnabled: true,
				} as never,
			}),
		).resolves.not.toThrow();
	});
});

describe("runScheduledReview", () => {
	beforeEach(() => {
		kvStore.clear();
	});

	const message: ReviewRunMessage = {
		provider: "anthropic",
		owner: "owner",
		repo: "repo",
		pullNumber: 1,
		headSha: "abc1234567890def",
		action: "synchronize",
		installationId: 123,
	};

	it("no-ops (superseded) when the PR head has moved past the scheduled SHA", async () => {
		mockBuildReview.mockReset();
		const octokit = {
			request: vi.fn(async (_route: string) => ({
				data: {
					draft: false,
					head: { sha: "NEWER" },
					additions: 0,
					deletions: 0,
					changed_files: 0,
					title: "t",
					body: null,
				},
			})),
		};
		const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;

		const result = await runScheduledReview(
			{ ...message, headSha: "OLD" },
			app,
			baseArgs.config,
		);

		expect(result).toEqual({ status: "superseded" });
		// Only the GET pulls call happened — no review work was attempted.
		expect(mockBuildReview).not.toHaveBeenCalled();
		expect(octokit.request).toHaveBeenCalledTimes(1);
		expect(octokit.request.mock.calls[0][0]).toBe(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}",
		);
	});

	it("runs the review (reviewed) when the PR head still matches the scheduled SHA", async () => {
		mockBuildReview.mockReset();
		const octokit = {
			request: vi.fn(async (_route: string) => ({
				data: {
					draft: false,
					head: { sha: "SAME" },
					additions: 0,
					deletions: 0,
					changed_files: 0,
					title: "t",
					body: null,
				},
			})),
		};
		const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;

		// reviewEnabled=false makes maybeSubmitReview a cheap early-return no-op.
		const result = await runScheduledReview(
			{ ...message, headSha: "SAME" },
			app,
			{
				...baseArgs.config,
				reviewEnabled: false,
			},
		);

		expect(result).toEqual({ status: "reviewed" });
	});
});

describe("buildPRSummarySection", () => {
	it("builds a summary section with verdict and metadata", () => {
		const section = buildPRSummarySection(
			{ ...DEFAULT_METADATA, generalFindings: 2, inlineComments: 1 },
			"REQUEST_CHANGES",
			"ai-review-bot",
		);
		expect(section).toContain("<!-- ai-review-bot:start -->");
		expect(section).toContain("<!-- ai-review-bot:end -->");
		expect(section).toContain("⚠️ Changes requested");
		expect(section).toContain("2 general, 1 inline");
	});

	it("shows Tier 2 skills when present", () => {
		const section = buildPRSummarySection(
			{
				...DEFAULT_METADATA,
				tier2Skills: ["security-auditor", "type-design-analyzer"],
			},
			"COMMENT",
			"ai-review-bot",
		);
		expect(section).toContain("5 Tier 1 + 2 Tier 2");
		expect(section).toContain("`security-auditor`");
	});
});

describe("injectPRSection", () => {
	const section =
		"<!-- ai-review-bot:start -->\ntest\n<!-- ai-review-bot:end -->";

	it("appends section to existing body", () => {
		const result = injectPRSection("Existing description.", section);
		expect(result).toBe(`Existing description.\n\n${section}`);
	});

	it("replaces existing section", () => {
		const body = `Intro\n\n${section}\n\nOutro`;
		const newSection =
			"<!-- ai-review-bot:start -->\nupdated\n<!-- ai-review-bot:end -->";
		const result = injectPRSection(body, newSection);
		expect(result).toBe(`Intro\n\n${newSection}\n\nOutro`);
	});

	it("handles null body", () => {
		const result = injectPRSection(null, section);
		expect(result).toBe(section);
	});
});

describe("selectReviewDelayMs", () => {
	const config = {
		reviewDelayMs: 540_000,
		reviewResyncDelayMs: 300_000,
	} as AppConfig;

	it("uses the shorter resync delay for synchronize (push) events", () => {
		expect(selectReviewDelayMs("synchronize", config)).toBe(300_000);
	});

	it("uses the full initial delay for opened/reopened/ready_for_review events", () => {
		for (const action of ["opened", "reopened", "ready_for_review"]) {
			expect(selectReviewDelayMs(action, config)).toBe(540_000);
		}
	});
});
