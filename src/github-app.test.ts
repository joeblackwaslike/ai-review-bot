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
import { quotaCommentMarker, rateLimitCommentMarker } from "./notify.js";
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
		agentBudgetMs: 600_000,
		tier2Enabled: false,
	}),
}));

vi.mock("./review.js", () => ({
	buildReview: mockBuildReview,
}));

// The peer gate re-publishes a callback when it decides to wait; stubbing the
// scheduler keeps that observable without reaching QStash.
const mockScheduleReview = vi.hoisted(() =>
	vi.fn(async (): Promise<{ messageId: string } | null> => null),
);
vi.mock("./scheduler.js", () => ({
	scheduleReview: mockScheduleReview,
	reviewRunCallbackUrl: () => "https://example.test/api/github/review-run",
	verifyQStashSignature: vi.fn(async () => true),
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
		peerCheckIntervalMs: 90_000,
		peerMaxAttempts: 6,
		improveEnabled: false,
		improveCarrierEnabled: false,
		agentConcurrency: 1,
		agentBudgetMs: 600_000,
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
		const { app, octokit } = buildMockApp();
		mockBuildReview.mockReset().mockRejectedValueOnce(new Error("agent boom"));

		await expect(maybeSubmitReview({ app, ...baseArgs })).rejects.toThrow(
			"agent boom",
		);

		// hs1: a total agent failure must NOT be silent. GitHub already received a
		// 202 for the webhook, so a surfaced PR comment is the only signal — without
		// it the run vanishes (the failure mode that hid a multi-day provider outage).
		const failureComments = octokit.request.mock.calls.filter(
			([route, params]) =>
				route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments" &&
				typeof params?.body === "string" &&
				params.body.includes("couldn't complete"),
		);
		expect(failureComments).toHaveLength(1);

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

		const outcome = await maybeSubmitReview({
			app,
			...baseArgs,
			pullRequest: { ...pr, draft: true },
		});

		expect(mockBuildReview).not.toHaveBeenCalled();
		expect(octokit.request).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: "skipped",
			reason: "pull request is a draft",
		});
	});

	it("skips submission when buildReview returns null (already reviewed)", async () => {
		const { app, octokit } = buildMockApp();
		mockBuildReview.mockReset().mockResolvedValue(null);

		const outcome = await maybeSubmitReview({ app, ...baseArgs });

		expect(octokit.request).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: "skipped",
			reason: "no new review to post",
		});
	});

	it("reports a distinct skip reason when the commit is already claimed", async () => {
		const { app } = buildMockApp();
		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		await maybeSubmitReview({ app, ...baseArgs });
		const outcome = await maybeSubmitReview({ app, ...baseArgs });

		expect(outcome).toEqual({
			status: "skipped",
			reason: "commit already claimed by another run",
		});
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

		const outcome = await maybeSubmitReview({ app, ...baseArgs });
		expect(outcome).toEqual({ status: "posted", event: "REQUEST_CHANGES" });

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
		let postAttempts = 0;
		// Fail twice, succeed on the third attempt. The existence check
		// (GET .../reviews) run after each failure finds nothing — the
		// failures were real, nothing landed on GitHub's side.
		request.mockImplementation(async (route: string) => {
			if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				postAttempts++;
				if (postAttempts < 3) throw new Error("422 Unprocessable Entity");
				return { data: { id: 999 } };
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				return { data: [] };
			}
			return { data: {} };
		});

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

		expect(postAttempts).toBe(3);
		const patchCall = request.mock.calls.find(
			([route]) => route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
		);
		expect(patchCall).toBeDefined();
		const checkRunCall = request.mock.calls.find(
			([route]) => route === "POST /repos/{owner}/{repo}/check-runs",
		);
		expect(checkRunCall).toBeDefined();
	});

	it("does not repost a duplicate review when a prior attempt actually landed despite the client seeing an error", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		let postAttempts = 0;
		// GitHub actually stores whatever body was sent (marker included) —
		// simulate that by capturing it from the POST and echoing it back
		// from the GET check, rather than hardcoding a body the test can't
		// predict (the marker is a fresh randomUUID generated inside the
		// function under test).
		let landedBody: string | null = null;
		request.mockImplementation(
			async (route: string, opts: { body?: string } = {}) => {
				if (
					route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
				) {
					postAttempts++;
					// GitHub processes the write, but the client sees an error
					// anyway (secondary rate limit, dropped connection after
					// commit, timeout past the actual write) — exactly what was
					// observed live: ai-review watch posted a byte-for-byte
					// duplicate review 76s after a secondary-rate-limit error.
					landedBody = opts.body ?? null;
					throw new Error("You have exceeded a secondary rate limit");
				}
				if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
					return {
						data: landedBody ? [{ id: 555, body: landedBody }] : [],
					};
				}
				return { data: {} };
			},
		);

		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		const promise = maybeSubmitReview({ app, ...baseArgs });
		await vi.runAllTimersAsync();
		const outcome = await promise;

		// Only one POST was attempted — the check after that "failure" found
		// the review already existed on GitHub (carrying the same marker) and
		// returned it instead of retrying, so no duplicate was ever created.
		expect(postAttempts).toBe(1);
		expect(outcome).toEqual({ status: "posted", event: "COMMENT" });
	});

	it("finds a matching review beyond the first page on a PR with many prior reviews", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		let postAttempts = 0;
		let landedBody: string | null = null;
		const page1 = Array.from({ length: 100 }, (_, i) => ({
			id: i,
			body: "An unrelated older review.",
		}));
		request.mockImplementation(
			async (route: string, opts: { body?: string; page?: number } = {}) => {
				if (
					route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
				) {
					postAttempts++;
					landedBody = opts.body ?? null;
					throw new Error("You have exceeded a secondary rate limit");
				}
				if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
					// The match landed on page 2 — a check capped at page 1 would
					// wrongly conclude nothing exists and retry, creating a real
					// duplicate on exactly the kind of busy PR most likely to hit
					// a secondary rate limit in the first place.
					if (opts.page === 2) {
						return { data: landedBody ? [{ id: 777, body: landedBody }] : [] };
					}
					return { data: page1 };
				}
				return { data: {} };
			},
		);

		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		const promise = maybeSubmitReview({ app, ...baseArgs });
		await vi.runAllTimersAsync();
		const outcome = await promise;

		expect(postAttempts).toBe(1);
		expect(outcome).toEqual({ status: "posted", event: "COMMENT" });
	});

	it("refuses to retry — rather than risk a duplicate — when it cannot verify whether a prior attempt landed", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		let postAttempts = 0;
		request.mockImplementation(async (route: string) => {
			if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				postAttempts++;
				throw new Error("You have exceeded a secondary rate limit");
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				// The verification check ITSELF fails — we have no way to know
				// whether the POST above landed. Retrying here is exactly the
				// ambiguous situation that causes a duplicate; the only way to
				// make a duplicate structurally impossible is to refuse to
				// guess rather than assume "not found".
				throw new Error("503 Service Unavailable");
			}
			return { data: {} };
		});

		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		const promise = maybeSubmitReview({ app, ...baseArgs });
		await vi.runAllTimersAsync();
		const outcome = await promise;

		// Exactly one POST attempt — no blind retry against an unverifiable
		// state. The findings are still preserved via the existing fallback
		// comment path (maybeSubmitReview's outer catch), so nothing is lost;
		// the guarantee is specifically "never post a second review when we
		// can't prove the first didn't land."
		expect(postAttempts).toBe(1);
		expect(outcome).toEqual({ status: "posted", event: "COMMENT" });
		const fallbackCall = request.mock.calls.find(
			([route]) =>
				route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(fallbackCall).toBeDefined();
	});

	it("matches despite whitespace drift on GitHub's round-trip, because the marker is a substring match, not a whole-body comparison", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		let postAttempts = 0;
		let landedBody: string | null = null;
		request.mockImplementation(
			async (route: string, opts: { body?: string } = {}) => {
				if (
					route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
				) {
					postAttempts++;
					landedBody = opts.body ?? null;
					throw new Error("You have exceeded a secondary rate limit");
				}
				if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
					// GitHub trims trailing whitespace / normalises line endings on
					// the round-trip — a whole-body `===` comparison would never
					// match this and would silently reproduce the original bug
					// while looking fixed. A substring match on the marker alone
					// is unaffected by drift elsewhere in the body.
					const drifted = landedBody?.trimEnd().replace(/\r\n/g, "\n");
					return { data: drifted ? [{ id: 555, body: drifted }] : [] };
				}
				return { data: {} };
			},
		);

		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.\r\n\r\n",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		const promise = maybeSubmitReview({ app, ...baseArgs });
		await vi.runAllTimersAsync();
		const outcome = await promise;

		expect(postAttempts).toBe(1);
		expect(outcome).toEqual({ status: "posted", event: "COMMENT" });
	});

	it("refuses to retry once the page cap is reached, rather than assume absence on a pathologically large PR", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		let postAttempts = 0;
		const fullPage = Array.from({ length: 100 }, (_, i) => ({
			id: i,
			body: "An unrelated older review.",
		}));
		request.mockImplementation(async (route: string) => {
			if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				postAttempts++;
				throw new Error("You have exceeded a secondary rate limit");
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				// Every page is full (100 results, none matching) — the lookup
				// never finds a short page to confirm exhaustion, so it hits the
				// page cap and must report "unknown", not "confirmed absent".
				return { data: fullPage };
			}
			return { data: {} };
		});

		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		const promise = maybeSubmitReview({ app, ...baseArgs });
		await vi.runAllTimersAsync();
		const outcome = await promise;

		expect(postAttempts).toBe(1);
		expect(outcome).toEqual({ status: "posted", event: "COMMENT" });
		const fallbackCall = request.mock.calls.find(
			([route]) =>
				route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(fallbackCall).toBeDefined();
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

		const outcome = await maybeSubmitReview({
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

		const comment = requests.find(
			(r) =>
				r.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(comment?.params.body).toContain("2026-06-09T07:21:30Z");
		expect(
			requests.some((r) => r.route.includes("/pulls/{pull_number}/reviews")),
		).toBe(false);
		expect(outcome).toEqual({ status: "rate_limited" });
	});

	it("reports quota_exhausted and posts no review on QUOTA_EXHAUSTED", async () => {
		const { app, octokit } = buildMockApp();
		mockBuildReview.mockReset().mockResolvedValue({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: "anthropic" as const,
		});

		const outcome = await maybeSubmitReview({ app, ...baseArgs });

		expect(outcome).toEqual({ status: "quota_exhausted" });
		expect(
			octokit.request.mock.calls.some(
				([route]) =>
					route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			),
		).toBe(false);
	});

	// ai-review-bot-zm9: under watch's indefinite retry loop, a persistent
	// quota/rate-limit condition must not repost an identical warning comment
	// every cycle — mirror notifyQuotaExhausted's existing issue-path dedup for
	// this PR-comment path too.
	// Dedup now matches the exact posted body, not just the marker (see the
	// rate-limit test below for why) — captured from a real first post, then
	// replayed as the "existing comment" for a second call, so this proves
	// the actual production body round-trips through the dedup check rather
	// than a hand-duplicated fixture string that could drift from it.
	it("does not repost the quota-exhausted comment when one with the same content already exists", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: "anthropic" as const,
		});
		let postedBody: string | undefined;
		const octokitFirst = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [] };
				}
				if (
					route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					postedBody = params.body as string;
				}
				return { data: {} };
			}),
		};
		await maybeSubmitReview({
			app: { getInstallationOctokit: vi.fn(async () => octokitFirst) } as never,
			...baseArgs,
		});
		// anthropicreviewbot (PRRT_kwDOSM5cU86Z_qo0): make the fixture-setup
		// failure loud rather than silent — if the POST branch above were never
		// reached, postedBody would stay undefined and the second call's mock
		// would trivially defeat dedup by construction.
		expect(postedBody).toBeDefined();
		expect(postedBody).toContain(quotaCommentMarker("anthropic"));

		const requests: Array<{ route: string; params: Record<string, unknown> }> =
			[];
		const octokitSecond = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests.push({ route, params });
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [{ body: postedBody }] };
				}
				return { data: {} };
			}),
		};
		const outcome = await maybeSubmitReview({
			app: {
				getInstallationOctokit: vi.fn(async () => octokitSecond),
			} as never,
			...baseArgs,
		});

		expect(outcome).toEqual({ status: "quota_exhausted" });
		const posts = requests.filter(
			(r) =>
				r.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts).toHaveLength(0);
	});

	// anthropicreviewbot (PRRT_kwDOSM5cU86Z_qo5) reviewing PR #67: the test
	// above round-trips a real posted body through the dedup check, but since
	// its fixture's quotaProvider ("anthropic") always matches config.provider
	// ("anthropic"), it can't distinguish "keyed off config.provider" from
	// "keyed off quotaProvider" — a regression that reverted the marker key to
	// quotaProvider would still pass it. This is the invariant test that check
	// was folded away from: quotaProvider is deliberately "unknown" (unset)
	// while config.provider stays "anthropic", so only a key derived from
	// config.provider can dedupe correctly.
	it("keys the quota-exhausted marker off config.provider even when quotaProvider diverges", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: undefined,
		});
		let postedBody: string | undefined;
		const octokitFirst = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [] };
				}
				if (
					route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					postedBody = params.body as string;
				}
				return { data: {} };
			}),
		};
		await maybeSubmitReview({
			app: { getInstallationOctokit: vi.fn(async () => octokitFirst) } as never,
			...baseArgs,
		});
		expect(postedBody).toBeDefined();
		expect(postedBody).toContain(quotaCommentMarker("anthropic"));
		expect(postedBody).not.toContain(quotaCommentMarker("unknown"));

		const requests: Array<{ route: string; params: Record<string, unknown> }> =
			[];
		const octokitSecond = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests.push({ route, params });
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [{ body: postedBody }] };
				}
				return { data: {} };
			}),
		};
		const outcome = await maybeSubmitReview({
			app: {
				getInstallationOctokit: vi.fn(async () => octokitSecond),
			} as never,
			...baseArgs,
		});

		expect(outcome).toEqual({ status: "quota_exhausted" });
		const posts = requests.filter(
			(r) =>
				r.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts).toHaveLength(0);
	});

	// codexreviewbot (PRRT_kwDOSM5cU86Z_xF1 / _xGF) reviewing PR #67's own
	// 2f66390 commit: the exact-body-match fix is correct for RATE_LIMITED
	// (its variable text — reset time — IS the signal a new warning exists),
	// but the quota-exhausted body ALSO embeds `providerLabel(quotaProvider)`,
	// whose value can drift (e.g. "anthropic" on one cycle, unset/"unknown" on
	// a retry for the same underlying condition) independent of the marker.
	// Exact-body matching on that path would miss the existing comment and
	// repost on every drift — reintroducing the very spam this dedup exists
	// to stop, just on the quota path instead of the rate-limit path.
	it("dedupes the quota-exhausted comment by marker even when the quotaProvider label text drifts between cycles", async () => {
		mockBuildReview.mockReset().mockResolvedValueOnce({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: "anthropic",
		});
		let postedBody: string | undefined;
		const octokitFirst = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [] };
				}
				if (
					route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					postedBody = params.body as string;
				}
				return { data: {} };
			}),
		};
		await maybeSubmitReview({
			app: { getInstallationOctokit: vi.fn(async () => octokitFirst) } as never,
			...baseArgs,
		});
		expect(postedBody).toBeDefined();
		expect(postedBody).toContain("Anthropic");

		// Same underlying condition, same config.provider, but this retry's
		// quotaProvider is unset — the human-facing label text differs even
		// though the marker (keyed off config.provider) does not.
		mockBuildReview.mockReset().mockResolvedValueOnce({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: undefined,
		});
		const requests2: Array<{
			route: string;
			params: Record<string, unknown>;
		}> = [];
		const octokitSecond = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests2.push({ route, params });
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [{ body: postedBody }] };
				}
				return { data: {} };
			}),
		};
		const outcome2 = await maybeSubmitReview({
			app: {
				getInstallationOctokit: vi.fn(async () => octokitSecond),
			} as never,
			...baseArgs,
		});

		expect(outcome2).toEqual({ status: "quota_exhausted" });
		const posts2 = requests2.filter(
			(r) =>
				r.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts2).toHaveLength(0);
	});

	// Found by sourcery-ai reviewing PR #67: hasExistingComment's own docstring
	// says a malformed response is treated as "no existing comment", but a
	// thrown network/Octokit error from the GET itself was never caught and
	// would reject the whole maybeSubmitReview call — blocking the
	// quota/rate-limit warning from posting at all on a transient API blip,
	// worse than the duplicate-comment problem this dedup exists to fix.
	it("treats a failed comment-list request as no existing comment, rather than rejecting the review", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: "anthropic" as const,
		});
		const octokitLocal = {
			request: vi.fn(async (route: string) => {
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					throw new Error("ETIMEDOUT");
				}
				return { data: {} };
			}),
		};
		const appLocal = {
			getInstallationOctokit: vi.fn(async () => octokitLocal),
		} as never;

		const outcome = await maybeSubmitReview({ app: appLocal, ...baseArgs });

		expect(outcome).toEqual({ status: "quota_exhausted" });
		const posts = octokitLocal.request.mock.calls.filter(
			([route]) =>
				route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts).toHaveLength(1);
	});

	// codexreviewbot (PRRT_kwDOSM5cU86Z_cHu / ikk9l) reviewing PR #67: the
	// try/catch above must absorb only the network/Octokit request failure —
	// wrapping the whole pagination loop also downgrades a bug in the
	// per-comment `.body` access below (anthropicreviewbot,
	// PRRT_kwDOSM5cU86Z_7r_) to "no existing comment", which would silently
	// start reposting duplicate warnings instead of surfacing the bug. A
	// comment whose `.body` getter throws simulates that failure and must
	// propagate out of hasExistingComment entirely.
	it("propagates a non-request error from the local scan instead of swallowing it as no-existing-comment", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: "anthropic" as const,
		});
		const octokitLocal = {
			request: vi.fn(async (route: string) => {
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return {
						data: [
							{
								get body(): string {
									throw new Error("local scan bug");
								},
							},
						],
					};
				}
				return { data: {} };
			}),
		};
		const appLocal = {
			getInstallationOctokit: vi.fn(async () => octokitLocal),
		} as never;

		await expect(
			maybeSubmitReview({ app: appLocal, ...baseArgs }),
		).rejects.toThrow("local scan bug");
		// anthropicreviewbot (PRRT_kwDOSM5cU86Z_7rb): a future change that
		// caught the scan error and posted anyway would still throw (since the
		// throw happens inside the outer try in maybeSubmitReview) — assert no
		// POST was made too, to rule that out explicitly.
		const posts = octokitLocal.request.mock.calls.filter(
			([route]) =>
				route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts).toHaveLength(0);
	});

	// anthropicreviewbot (PRRT_kwDOSM5cU86Z_qoq) reviewing PR #67: the switch
	// from marker-substring to exact-body matching is more precise but also
	// more brittle — a trailing-newline difference between the
	// locally-constructed body and what GitHub's API echoes back would defeat
	// the match entirely. trimEnd() on both sides tolerates that without
	// reintroducing the marker-substring false-positive it replaced.
	it("matches an existing comment despite trailing-whitespace drift from GitHub's API", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: "anthropic" as const,
		});
		let postedBody: string | undefined;
		const octokitFirst = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [] };
				}
				if (
					route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					postedBody = params.body as string;
				}
				return { data: {} };
			}),
		};
		await maybeSubmitReview({
			app: { getInstallationOctokit: vi.fn(async () => octokitFirst) } as never,
			...baseArgs,
		});
		expect(postedBody).toBeDefined();

		const requests: Array<{ route: string; params: Record<string, unknown> }> =
			[];
		const octokitSecond = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests.push({ route, params });
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					// GitHub echoes the body back with an added trailing newline.
					return { data: [{ body: `${postedBody}\n` }] };
				}
				return { data: {} };
			}),
		};

		const outcome = await maybeSubmitReview({
			app: {
				getInstallationOctokit: vi.fn(async () => octokitSecond),
			} as never,
			...baseArgs,
		});

		expect(outcome).toEqual({ status: "quota_exhausted" });
		const posts = requests.filter(
			(r) =>
				r.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts).toHaveLength(0);
	});

	const rateLimitedBaseArgs = {
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
	};

	it("does not repost the rate-limit comment when one with the same content already exists", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "RATE_LIMITED",
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			rateLimitResetAt: "2026-06-09T07:21:30Z",
		});
		let postedBody: string | undefined;
		const octokitFirst = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [] };
				}
				if (
					route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					postedBody = params.body as string;
				}
				return { data: {} };
			}),
		};
		await maybeSubmitReview({
			app: { getInstallationOctokit: vi.fn(async () => octokitFirst) } as never,
			...rateLimitedBaseArgs,
		});
		// anthropicreviewbot (PRRT_kwDOSM5cU86Z_qo3): same fixture-setup guard as
		// the quota-exhausted test above.
		expect(postedBody).toBeDefined();
		expect(postedBody).toContain(rateLimitCommentMarker("anthropic"));
		expect(postedBody).toContain("2026-06-09T07:21:30Z");

		const requests: Array<{ route: string; params: Record<string, unknown> }> =
			[];
		const octokitSecond = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests.push({ route, params });
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [{ body: postedBody }] };
				}
				return { data: {} };
			}),
		};
		const outcome = await maybeSubmitReview({
			app: {
				getInstallationOctokit: vi.fn(async () => octokitSecond),
			} as never,
			...rateLimitedBaseArgs,
		});

		expect(outcome).toEqual({ status: "rate_limited" });
		const posts = requests.filter(
			(r) =>
				r.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts).toHaveLength(0);
	});

	// Found by codexreviewbot reviewing PR #67: marker-only dedup would
	// suppress a genuinely NEW rate-limit warning if the reset time changed
	// between windows, pinning a stale timestamp in the PR indefinitely.
	// Matching the full body means a changed reset time is correctly treated
	// as new content and reposted.
	it("reposts the rate-limit comment when the reset time has changed since the last warning", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "RATE_LIMITED",
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			rateLimitResetAt: "2026-06-09T07:21:30Z",
		});
		const staleExisting = {
			body: `${rateLimitCommentMarker("anthropic")}\n⚠️ **[ai-review-bot]** Review couldn't run — the model is rate-limited (input-token budget). Budget resets at 2026-06-09T05:00:00Z. Push again after that, or it will auto-retry on your next commit.`,
		};
		const requests: Array<{ route: string; params: Record<string, unknown> }> =
			[];
		const octokitLocal = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests.push({ route, params });
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [staleExisting] };
				}
				return { data: {} };
			}),
		};

		const outcome = await maybeSubmitReview({
			app: { getInstallationOctokit: vi.fn(async () => octokitLocal) } as never,
			...rateLimitedBaseArgs,
		});

		expect(outcome).toEqual({ status: "rate_limited" });
		const posts = requests.filter(
			(r) =>
				r.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts).toHaveLength(1);
		expect(posts[0].params.body).toContain("2026-06-09T07:21:30Z");
		// anthropicreviewbot (PRRT_kwDOSM5cU86Z_qo_): a bug that posted a comment
		// containing BOTH the old and new reset times would still pass the
		// `.toContain` assertion above — assert the stale timestamp is gone too.
		expect(posts[0].params.body).not.toContain("2026-06-09T05:00:00Z");
	});

	// Found by anthropicreviewbot/codexreviewbot/llamapreview on PR #67's own
	// review: a single GET with no pagination means a match beyond GitHub's
	// default page size (30) is never found, so the dedup silently fails on
	// busy PRs — exactly the spam scenario ai-review-bot-zm9 was fixed to stop.
	it("finds an existing matching comment on a later page, not just the first page", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: "anthropic" as const,
		});
		let postedBody: string | undefined;
		const octokitFirst = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [] };
				}
				if (
					route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					postedBody = params.body as string;
				}
				return { data: {} };
			}),
		};
		await maybeSubmitReview({
			app: { getInstallationOctokit: vi.fn(async () => octokitFirst) } as never,
			...baseArgs,
		});
		// anthropicreviewbot (PRRT_kwDOSM5cU86Z_qpK / codexreviewbot 0Kw): make
		// the fixture-setup failure loud rather than silent — if the POST
		// branch above were never reached, postedBody would stay undefined and
		// page2 below would trivially defeat dedup by construction.
		expect(postedBody).toBeDefined();

		const requests: Array<{ route: string; params: Record<string, unknown> }> =
			[];
		const page1 = Array.from({ length: 100 }, (_, i) => ({
			body: `unrelated comment ${i}`,
		}));
		const page2 = [{ body: postedBody }];
		const octokitSecond = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests.push({ route, params });
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: params.page === 2 ? page2 : page1 };
				}
				return { data: {} };
			}),
		};

		const outcome = await maybeSubmitReview({
			app: {
				getInstallationOctokit: vi.fn(async () => octokitSecond),
			} as never,
			...baseArgs,
		});

		expect(outcome).toEqual({ status: "quota_exhausted" });
		const posts = requests.filter(
			(r) =>
				r.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts).toHaveLength(0);
		const listCalls = requests.filter(
			(r) =>
				r.route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(listCalls).toHaveLength(2);
		// codexreviewbot (0Kw): pin the per_page/page contract itself, not just
		// the call count — a regression that dropped per_page or reused page:1
		// would still pass a bare-length assertion.
		expect(listCalls[0]?.params).toMatchObject({ per_page: 100, page: 1 });
		expect(listCalls[1]?.params).toMatchObject({ per_page: 100, page: 2 });
	});

	// codexreviewbot (PRRT_kwDOSM5cU86Z-0Kr / -0Kv) reviewing PR #67: the old
	// fixed 10-page cap (1000 comments) meant hasExistingComment gave up before
	// reaching a marker that existed on page 11+ of a busy, long-lived PR —
	// exactly the watch-loop scenario this dedup exists to protect — and
	// reposted the same quota/rate-limit warning. HAS_EXISTING_COMMENT_MAX_PAGES
	// is now high enough that this passes.
	it("finds a matching comment beyond the old 10-page cap on very busy PRs", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: "anthropic" as const,
		});
		let postedBody: string | undefined;
		const octokitFirst = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: [] };
				}
				if (
					route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					postedBody = params.body as string;
				}
				return { data: {} };
			}),
		};
		await maybeSubmitReview({
			app: { getInstallationOctokit: vi.fn(async () => octokitFirst) } as never,
			...baseArgs,
		});
		expect(postedBody).toBeDefined();

		const requests: Array<{ route: string; params: Record<string, unknown> }> =
			[];
		const fullPage = Array.from({ length: 100 }, (_, i) => ({
			body: `unrelated comment ${i}`,
		}));
		const matchPage = [{ body: postedBody }];
		const octokitSecond = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests.push({ route, params });
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: params.page === 11 ? matchPage : fullPage };
				}
				return { data: {} };
			}),
		};

		const outcome = await maybeSubmitReview({
			app: {
				getInstallationOctokit: vi.fn(async () => octokitSecond),
			} as never,
			...baseArgs,
		});

		expect(outcome).toEqual({ status: "quota_exhausted" });
		const posts = requests.filter(
			(r) =>
				r.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(posts).toHaveLength(0);
		const listCalls = requests.filter(
			(r) =>
				r.route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(listCalls).toHaveLength(11);
	});

	it("stops paginating once a page returns fewer than per_page comments", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "QUOTA_EXHAUSTED" as const,
			body: "",
			comments: [],
			validLinesByPath: new Map(),
			metadata: DEFAULT_METADATA,
			quotaProvider: "anthropic" as const,
		});
		const requests: Array<{ route: string; params: Record<string, unknown> }> =
			[];
		const page1 = Array.from({ length: 100 }, (_, i) => ({
			body: `unrelated comment ${i}`,
		}));
		const page2 = [{ body: "unrelated last comment" }]; // < per_page(100) — no page 3
		const octokitLocal = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				requests.push({ route, params });
				if (
					route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
				) {
					return { data: params.page === 2 ? page2 : page1 };
				}
				return { data: {} };
			}),
		};
		const appLocal = {
			getInstallationOctokit: vi.fn(async () => octokitLocal),
		} as never;

		await maybeSubmitReview({ app: appLocal, ...baseArgs });

		const listCalls = requests.filter(
			(r) =>
				r.route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(listCalls).toHaveLength(2);
	});

	it("posts fallback comment with findings when all retries are exhausted", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		let postAttempts = 0;
		// All 3 review attempts genuinely fail (the existence check after each
		// finds nothing on GitHub's side); the fallback comment then succeeds.
		request.mockImplementation(async (route: string) => {
			if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				postAttempts++;
				throw new Error("422 Unprocessable Entity");
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				return { data: [] };
			}
			return { data: {} };
		});

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

		const promise = maybeSubmitReview({ app, ...baseArgs });
		await vi.runAllTimersAsync();
		const outcome = await promise;

		expect(postAttempts).toBe(3);

		const fallbackCall = request.mock.calls.find(
			([route]) =>
				route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(fallbackCall).toBeDefined();
		const [fallbackRoute, fallbackParams] = fallbackCall as [
			string,
			{ body: string },
		];
		expect(fallbackRoute).toBe(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		);
		expect(fallbackParams.body).toContain("⚠️");
		expect(fallbackParams.body).toContain("422 Unprocessable Entity");
		expect(fallbackParams.body).toContain("Review body.");
		expect(fallbackParams.body).toContain("src/file.ts:2");

		// The fallback comment preserved the findings — from the caller's
		// perspective that is a real post, not a skip.
		expect(outcome).toEqual({ status: "posted", event: "COMMENT" });
	});

	it("keeps the claim after a successful fallback comment so the commit is not re-billed", async () => {
		vi.useFakeTimers();
		const { app, request } = buildMockApp();
		// All 3 review POSTs genuinely fail (the existence check after each
		// finds nothing on GitHub's side); the fallback comment then succeeds.
		request.mockImplementation(async (route: string) => {
			if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				throw new Error("422 Unprocessable Entity");
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
				return { data: [] };
			}
			return { data: {} };
		});
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
				peerCheckIntervalMs: 90_000,
				peerMaxAttempts: 6,
				improveEnabled: false,
				improveCarrierEnabled: false,
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
				peerCheckIntervalMs: 90_000,
				peerMaxAttempts: 6,
				improveEnabled: false,
				improveCarrierEnabled: false,
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
					peerCheckIntervalMs: 90_000,
					peerMaxAttempts: 6,
					improveEnabled: false,
					improveCarrierEnabled: false,
				} as never,
			}),
		).resolves.not.toThrow();
	});

	it("threads auth through to buildReview when provided", async () => {
		const { app } = buildMockApp();
		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});
		const auth = {
			mode: "oauth" as const,
			provider: "anthropic" as const,
			token: "tok",
			baseURL: "https://api.example.test",
			headers: {},
			fetch: vi.fn() as unknown as typeof fetch,
		};

		await maybeSubmitReview({ app, ...baseArgs, auth });

		expect(mockBuildReview).toHaveBeenCalledWith(
			expect.objectContaining({ auth }),
		);
	});

	it("passes auth as undefined when not provided (unchanged webhook behavior)", async () => {
		const { app } = buildMockApp();
		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		await maybeSubmitReview({ app, ...baseArgs });

		expect(mockBuildReview).toHaveBeenCalledWith(
			expect.objectContaining({ auth: undefined }),
		);
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
			paginate: vi.fn(async () => []),
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

	// The gate exists so peers post first; it must actually hold when one has
	// engaged but not yet caught up to the current head.
	it("waits and reschedules when an engaged peer has not reviewed the head", async () => {
		mockBuildReview.mockReset();
		mockScheduleReview.mockClear();
		mockScheduleReview.mockResolvedValueOnce({ messageId: "next" });
		const octokit = {
			paginate: vi.fn(async (route: string) =>
				route.includes("/reviews")
					? [{ user: { login: "coderabbitai[bot]" }, commit_id: "OLDER" }]
					: [],
			),
			request: vi.fn(async () => ({
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

		const result = await runScheduledReview(
			{ ...message, headSha: "SAME" },
			app,
			{
				reviewEnabled: true,
				reviewCommentPrefix: "ai-review-bot",
				provider: "anthropic",
				peerCheckIntervalMs: 90_000,
				peerMaxAttempts: 6,
			} as never,
		);

		expect(result.status).toBe("waiting");
		expect(mockScheduleReview).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ attempt: 1 }),
			90,
		);
		expect(mockBuildReview).not.toHaveBeenCalled();
	});

	// A peer that never arrives must not starve the review — this is the
	// failure that left our own Codex bot with zero reviews across a whole PR.
	it("reviews at the ceiling even though the peer never arrived", async () => {
		mockBuildReview.mockReset();
		mockScheduleReview.mockClear();
		const octokit = {
			paginate: vi.fn(async (route: string) =>
				route.includes("/reviews")
					? [{ user: { login: "coderabbitai[bot]" }, commit_id: "OLDER" }]
					: [],
			),
			request: vi.fn(async () => ({
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

		const result = await runScheduledReview(
			{ ...message, headSha: "SAME", attempt: 5 },
			app,
			{
				reviewEnabled: true,
				reviewCommentPrefix: "ai-review-bot",
				provider: "anthropic",
				peerCheckIntervalMs: 90_000,
				peerMaxAttempts: 6,
			} as never,
		);

		expect(result.status).toBe("reviewed");
		expect(mockScheduleReview).not.toHaveBeenCalled();
	});

	it("runs the review (reviewed) when the PR head still matches the scheduled SHA", async () => {
		mockBuildReview.mockReset();
		const octokit = {
			// No peer reviews and none expected, so the peer gate resolves
			// immediately and the review proceeds on this pass.
			paginate: vi.fn(async () => []),
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

	it("skips peer gate and reviews immediately when fetchPrReviews fails", async () => {
		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});
		mockScheduleReview.mockClear();
		const octokit = {
			paginate: vi.fn(async () => {
				throw new Error("GitHub API down");
			}),
			request: vi.fn(async (route: string) => {
				if (route.includes("/search/issues")) {
					return { data: { total_count: 5 } };
				}
				return {
					data: {
						draft: false,
						head: { sha: "SAME" },
						additions: 0,
						deletions: 0,
						changed_files: 0,
						title: "t",
						body: null,
					},
				};
			}),
		};
		const app = { getInstallationOctokit: vi.fn(async () => octokit) } as never;

		const result = await runScheduledReview(
			{ ...message, headSha: "SAME" },
			app,
			{
				reviewEnabled: true,
				reviewCommentPrefix: "ai-review-bot",
				provider: "anthropic",
				peerCheckIntervalMs: 90_000,
				peerMaxAttempts: 6,
			} as never,
		);

		expect(result).toEqual({ status: "reviewed" });
		expect(mockScheduleReview).not.toHaveBeenCalled();
		expect(mockBuildReview).toHaveBeenCalledTimes(1);
	});
});

describe("buildPRSummarySection", () => {
	it("builds a summary section with verdict and metadata", () => {
		const section = buildPRSummarySection(
			{ ...DEFAULT_METADATA, generalFindings: 2, inlineComments: 1 },
			"REQUEST_CHANGES",
			"ai-review-bot",
			"anthropic",
		);
		expect(section).toContain("<!-- ai-review-bot:anthropic:start -->");
		expect(section).toContain("<!-- ai-review-bot:anthropic:end -->");
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
			"anthropic",
		);
		expect(section).toContain("5 Tier 1 + 2 Tier 2");
		expect(section).toContain("`security-auditor`");
	});

	// ai-review-bot-1f5: each provider's marker pair must be distinct so
	// injectPRSection can address one without touching the other — see the
	// injectPRSection tests below for the actual coexistence guarantee.
	it("uses a provider-scoped marker pair, distinct per provider", () => {
		const anthropicSection = buildPRSummarySection(
			DEFAULT_METADATA,
			"COMMENT",
			"ai-review-bot",
			"anthropic",
		);
		const openaiSection = buildPRSummarySection(
			DEFAULT_METADATA,
			"COMMENT",
			"ai-review-bot",
			"openai",
		);
		expect(anthropicSection).toContain(
			"<!-- ai-review-bot:anthropic:start -->",
		);
		expect(openaiSection).toContain("<!-- ai-review-bot:openai:start -->");
		expect(anthropicSection).not.toContain("ai-review-bot:openai:");
		expect(openaiSection).not.toContain("ai-review-bot:anthropic:");
	});
});

describe("injectPRSection", () => {
	const section =
		"<!-- ai-review-bot:anthropic:start -->\ntest\n<!-- ai-review-bot:anthropic:end -->";

	it("appends section to existing body", () => {
		const result = injectPRSection(
			"Existing description.",
			section,
			"anthropic",
		);
		expect(result).toBe(`Existing description.\n\n${section}`);
	});

	it("replaces existing section for the same provider", () => {
		const body = `Intro\n\n${section}\n\nOutro`;
		const newSection =
			"<!-- ai-review-bot:anthropic:start -->\nupdated\n<!-- ai-review-bot:anthropic:end -->";
		const result = injectPRSection(body, newSection, "anthropic");
		expect(result).toBe(`Intro\n\n${newSection}\n\nOutro`);
	});

	it("handles null body", () => {
		const result = injectPRSection(null, section, "anthropic");
		expect(result).toBe(section);
	});

	// ai-review-bot-1f5: this is the real regression test for the bug —
	// caught by chatgpt-codex-connector reviewing PR #67, the original fix
	// (re-poll between providers) did NOT actually solve the two-provider
	// overwrite, because injectPRSection always fully replaced ONE shared
	// marker section regardless of how fresh the body was. Provider-scoped
	// markers are what actually make the two sections coexist.
	it("preserves the other provider's section when injecting a second provider's section", () => {
		const anthropicSection =
			"<!-- ai-review-bot:anthropic:start -->\nanthropic content\n<!-- ai-review-bot:anthropic:end -->";
		const openaiSection =
			"<!-- ai-review-bot:openai:start -->\nopenai content\n<!-- ai-review-bot:openai:end -->";

		const afterFirst = injectPRSection(null, anthropicSection, "anthropic");
		const afterSecond = injectPRSection(afterFirst, openaiSection, "openai");

		expect(afterSecond).toContain("anthropic content");
		expect(afterSecond).toContain("openai content");
	});

	it("replaces only the matching provider's section, leaving the other's untouched", () => {
		const anthropicSection =
			"<!-- ai-review-bot:anthropic:start -->\nanthropic v1\n<!-- ai-review-bot:anthropic:end -->";
		const openaiSection =
			"<!-- ai-review-bot:openai:start -->\nopenai v1\n<!-- ai-review-bot:openai:end -->";
		const body = injectPRSection(
			injectPRSection(null, anthropicSection, "anthropic"),
			openaiSection,
			"openai",
		);

		const anthropicV2 =
			"<!-- ai-review-bot:anthropic:start -->\nanthropic v2\n<!-- ai-review-bot:anthropic:end -->";
		const result = injectPRSection(body, anthropicV2, "anthropic");

		expect(result).toContain("anthropic v2");
		expect(result).not.toContain("anthropic v1");
		expect(result).toContain("openai v1");
	});

	// Found by both anthropicreviewbot and codexreviewbot reviewing PR #67
	// (independent convergence — treated as signal, not noise): a PR whose
	// body already carries the OLD unscoped marker (from before this
	// deploy) would never have it found/replaced by the new provider-scoped
	// logic, leaving it as permanent orphaned stale content while new
	// provider-scoped sections get appended alongside it.
	it("migrates away the legacy unscoped marker section when injecting a new provider-scoped section", () => {
		const legacyBody =
			"Intro\n\n<!-- ai-review-bot:start -->\nold shared content\n<!-- ai-review-bot:end -->\n\nOutro";
		const newSection =
			"<!-- ai-review-bot:anthropic:start -->\nnew content\n<!-- ai-review-bot:anthropic:end -->";

		const result = injectPRSection(legacyBody, newSection, "anthropic");

		expect(result).not.toContain("ai-review-bot:start -->");
		expect(result).not.toContain("old shared content");
		expect(result).toContain("new content");
		expect(result).toContain("Intro");
		expect(result).toContain("Outro");
		// anthropicreviewbot (PRRT_kwDOSM5cU86Z_qpC): the migrated body must be
		// well-formed, not just missing the legacy markers and containing the
		// new content somewhere. There's no existing provider-scoped section
		// yet at migration time, so injectPRSection falls through to its
		// normal "append to the end" behavior (same as the non-migration
		// append case above) — assert that ordering rather than an
		// "interleaved between Intro/Outro" shape it never produces.
		expect(result.indexOf("Intro")).toBeLessThan(result.indexOf("Outro"));
		expect(result.indexOf("Outro")).toBeLessThan(result.indexOf("new content"));
	});

	// anthropicreviewbot (PRRT_kwDOSM5cU86Z_qoy / _qpF) reviewing PR #67: the
	// legacy strip only checked that both markers were present, not that they
	// were in the right order. A malformed body with the end marker BEFORE the
	// start marker sliced `[0, legacyStartIdx) + (legacyEndIdx + END.length, )`
	// — since legacyEndIdx < legacyStartIdx here, that duplicates the text
	// between the two markers and leaves both legacy markers behind instead of
	// stripping them.
	it("does not corrupt the body when legacy markers appear in reversed order", () => {
		const malformed =
			"Para1\n\n<!-- ai-review-bot:end -->\nmiddle\n<!-- ai-review-bot:start -->\n\nPara2";
		const newSection =
			"<!-- ai-review-bot:anthropic:start -->\nnew content\n<!-- ai-review-bot:anthropic:end -->";

		const result = injectPRSection(malformed, newSection, "anthropic");

		expect(result.split("middle")).toHaveLength(2);
		// anthropicreviewbot (PRRT_kwDOSM5cU86Z_7q8 / _7rW / _7ru): the guard
		// deliberately SKIPS stripping a malformed (reversed-order) body rather
		// than guessing at its structure, so the legacy markers are left in
		// place, not removed — assert that explicitly. This also distinguishes
		// "the guard correctly detected reversed order and left it alone" from
		// "legacy stripping never ran at all", which the split-count assertion
		// alone can't tell apart (both leave "middle" appearing once).
		expect(result).toContain("<!-- ai-review-bot:start -->");
		expect(result).toContain("<!-- ai-review-bot:end -->");
	});

	// codexreviewbot (PRRT_kwDOSM5cU86Z_xF_) reviewing PR #67's own 2f66390
	// commit: legacyEndIdx was found via `body.indexOf(END)` from position 0,
	// not from just after legacyStartIdx — so if the literal end-marker text
	// appears earlier in user-authored content within the legacy section
	// (e.g. quoting the bot's own markers as an example), the strip stops at
	// that spurious occurrence instead of the true closing marker, leaving
	// the rest of the legacy section (including a dangling real end marker)
	// in the migrated body.
	// codexreviewbot (PRRT_kwDOSM5cU86Z_xF_) reviewing PR #67's own 2f66390
	// commit: legacyEndIdx was found via `body.indexOf(END)` from position 0,
	// so a literal mention of the end-marker text BEFORE the real legacy
	// start marker (e.g. someone quoting the bot's own markers as an example
	// earlier in the PR description) makes legacyEndIdx < legacyStartIdx.
	// The `legacyStartIdx < legacyEndIdx` ordering guard added for
	// PRRT_kwDOSM5cU86Z_qoy/_qpF already stops that from corrupting the body,
	// but it does so by skipping the strip entirely — the genuine legacy
	// section (start...end, further along) never gets migrated at all.
	// Searching for the end marker starting after the start marker (instead
	// of from position 0) finds the real closing marker and lets migration
	// succeed instead of silently no-op'ing.
	it("migrates the legacy section even when the end-marker text appears earlier in unrelated content", () => {
		const body =
			"Note: our bot posts <!-- ai-review-bot:end --> as an example.\n\n<!-- ai-review-bot:start -->\nold shared content\n<!-- ai-review-bot:end -->\n\nOutro";
		const newSection =
			"<!-- ai-review-bot:anthropic:start -->\nnew content\n<!-- ai-review-bot:anthropic:end -->";

		const result = injectPRSection(body, newSection, "anthropic");

		expect(result).not.toContain("old shared content");
		expect(result).toContain("Outro");
	});
});

describe("selectReviewDelayMs", () => {
	const config = {
		reviewDelayMs: 540_000,
		reviewResyncDelayMs: 300_000,
		peerCheckIntervalMs: 90_000,
	} as AppConfig;

	// Both are now capped at the peer-check interval: the wait is a poll that
	// ends when peers actually post, not a guess at how long they take.
	it("caps both the resync and initial delays at the peer-check interval", () => {
		expect(selectReviewDelayMs("synchronize", config)).toBe(
			config.peerCheckIntervalMs,
		);
		for (const action of ["opened", "reopened", "ready_for_review"]) {
			expect(selectReviewDelayMs(action, config)).toBe(
				config.peerCheckIntervalMs,
			);
		}
	});
});
