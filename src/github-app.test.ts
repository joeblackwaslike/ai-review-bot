import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeSubmitReview } from "./github-app.js";
import { buildPullRequestPayload } from "./testing.js";

const mockBuildReview = vi.fn();

vi.mock("./config.js", () => ({
	getConfig: () => ({
		appId: "1",
		privateKey: "pem",
		webhookSecret: "secret",
		reviewEnabled: true,
		reviewCommentPrefix: "ai-review-bot",
		reviewCommand: "/ai-review",
		provider: "anthropic",
	}),
}));

vi.mock("./review.js", () => ({
	buildReview: (...args: unknown[]) => mockBuildReview(...args),
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
		reviewCommentPrefix: "ai-review-bot",
		reviewCommand: "/ai-review",
		provider: "anthropic" as const,
	},
};

describe("maybeSubmitReview", () => {
	afterEach(() => {
		vi.useRealTimers();
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
		};
		mockBuildReview.mockReset().mockResolvedValue(review);

		await maybeSubmitReview({ app, ...baseArgs });

		expect(octokit.request).toHaveBeenCalledOnce();
		const [route, params] = octokit.request.mock.calls[0];
		expect(route).toBe(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		);
		expect(params.comments).toEqual(review.comments);
		expect(params.event).toBe("REQUEST_CHANGES");
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
		});

		const promise = maybeSubmitReview({ app, ...baseArgs });
		await vi.runAllTimersAsync();
		await promise;

		expect(request).toHaveBeenCalledTimes(3);
		const routes = request.mock.calls.map(([route]) => route);
		expect(
			routes.every(
				(r) => r === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			),
		).toBe(true);
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
		});

		const promise = maybeSubmitReview({ app, ...baseArgs }).catch(() => {});
		await vi.runAllTimersAsync();
		await promise;

		// 3 review attempts + 1 fallback comment
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
});
