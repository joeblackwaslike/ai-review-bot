import { describe, expect, it, vi } from "vitest";
import { maybeSubmitReview } from "./github-app.js";
import { buildPullRequestPayload } from "./testing.js";

const mockBuildReview = vi.fn();

vi.mock("./config.js", () => ({
	getConfig: () => ({
		appId: "1",
		privateKey: "pem",
		webhookSecret: "secret",
		reviewEnabled: true,
		reviewCommentPrefix: "claude-review-bot",
		reviewCommand: "/claude-review",
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
		reviewCommentPrefix: "claude-review-bot",
		reviewCommand: "/claude-review",
		provider: "anthropic" as const,
	},
};

describe("maybeSubmitReview", () => {
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

	// Regression: if the GitHub API rejects the review POST (e.g. invalid comment
	// anchors), the bot should retry without inline comments so the review body
	// is never completely lost.
	it("regression: retries body-only when POST fails with inline comments", async () => {
		const { app, request } = buildMockApp();
		request
			.mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
			.mockResolvedValueOnce({ data: {} });

		const review = {
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
		};
		mockBuildReview.mockReset().mockResolvedValue(review);

		await maybeSubmitReview({ app, ...baseArgs });

		expect(request).toHaveBeenCalledTimes(2);

		const [, firstParams] = request.mock.calls[0];
		expect(firstParams.comments).toHaveLength(1);

		const [, retryParams] = request.mock.calls[1];
		expect(retryParams.comments).toEqual([]);
		expect(retryParams.body).toBe("Review body.");
	});

	it("does not retry when POST fails with an empty comments array", async () => {
		const { app, request } = buildMockApp();
		request.mockRejectedValue(new Error("500 Server Error"));

		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
		});

		await expect(maybeSubmitReview({ app, ...baseArgs })).rejects.toThrow(
			"500 Server Error",
		);
		expect(request).toHaveBeenCalledOnce();
	});
});
