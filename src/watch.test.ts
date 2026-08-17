import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { watchPr } from "./watch.js";

function buildTarget(provider: "anthropic" | "openai") {
	return {
		provider,
		app: { marker: `${provider}-app` } as never,
		installationId: provider === "anthropic" ? 1 : 2,
		config: { provider } as unknown as AppConfig,
	};
}

function pollResponse(
	overrides: Partial<{
		merged: boolean;
		state: string;
		headSha: string;
	}> = {},
) {
	return {
		data: {
			merged: overrides.merged ?? false,
			state: overrides.state ?? "open",
			draft: false,
			head: { sha: overrides.headSha ?? "sha1" },
			additions: 1,
			deletions: 0,
			changed_files: 1,
			title: "Test PR",
			body: null,
		},
	};
}

const apiKeyAuth = {
	mode: "api-key" as const,
	provider: "anthropic" as const,
	apiKey: "k",
};

describe("watchPr", () => {
	it("posts once per provider on the first cycle, then not again while the SHA is unchanged", async () => {
		const request = vi.fn().mockResolvedValue(pollResponse());
		const submitReview = vi.fn().mockResolvedValue(undefined);
		const resolveAuthFor = vi.fn(async (provider: "anthropic" | "openai") => ({
			...apiKeyAuth,
			provider,
		}));
		const sleep = vi.fn().mockResolvedValue(undefined);

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic"), buildTarget("openai")],
			resolveAuthFor,
			sleep,
			log: () => {},
			submitReview,
			maxCycles: 3,
		});

		expect(result).toEqual({ cycles: 3, reason: "max-cycles" });
		expect(submitReview).toHaveBeenCalledTimes(2);
		expect(resolveAuthFor).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(3);
	});

	it("re-reviews once per provider when the head SHA changes", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(pollResponse({ headSha: "sha1" }))
			.mockResolvedValueOnce(pollResponse({ headSha: "sha2" }))
			.mockResolvedValue(pollResponse({ headSha: "sha2" }));
		const submitReview = vi.fn().mockResolvedValue(undefined);

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic")],
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
			sleep: vi.fn().mockResolvedValue(undefined),
			log: () => {},
			submitReview,
			maxCycles: 3,
		});

		expect(result.reason).toBe("max-cycles");
		// cycle 1 (sha1) + cycle 2 (sha2), not cycle 3 (sha2 again)
		expect(submitReview).toHaveBeenCalledTimes(2);
	});

	it("exits when the PR is merged", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(pollResponse())
			.mockResolvedValueOnce(pollResponse({ merged: true }));

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic")],
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
			sleep: vi.fn().mockResolvedValue(undefined),
			log: () => {},
			submitReview: vi.fn().mockResolvedValue(undefined),
		});

		expect(result).toEqual({ cycles: 2, reason: "merged" });
	});

	it("exits when the PR is closed (not merged)", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(pollResponse({ state: "closed" }));

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic")],
			resolveAuthFor: vi.fn(),
			sleep: vi.fn().mockResolvedValue(undefined),
			log: () => {},
			submitReview: vi.fn(),
		});

		expect(result).toEqual({ cycles: 1, reason: "closed" });
	});

	it("logs and retries past a single transient poll failure instead of exiting", async () => {
		const request = vi
			.fn()
			.mockRejectedValueOnce(new Error("ETIMEDOUT"))
			.mockResolvedValueOnce(pollResponse({ merged: true }));
		const log = vi.fn();

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic")],
			resolveAuthFor: vi.fn(),
			sleep: vi.fn().mockResolvedValue(undefined),
			log,
			submitReview: vi.fn(),
		});

		expect(result).toEqual({ cycles: 2, reason: "merged" });
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("poll failed, retrying next interval"),
		);
	});

	it("propagates an auth-resolution failure instead of retrying forever", async () => {
		const request = vi.fn().mockResolvedValue(pollResponse());
		const resolveAuthFor = vi
			.fn()
			.mockRejectedValue(new Error("run `claude` to log in"));

		await expect(
			watchPr({
				owner: "o",
				repo: "r",
				pullNumber: 5,
				pollOctokit: { request },
				targets: [buildTarget("anthropic")],
				resolveAuthFor,
				sleep: vi.fn().mockResolvedValue(undefined),
				log: () => {},
				submitReview: vi.fn(),
			}),
		).rejects.toThrow(/run `claude` to log in/);
	});

	it("logs and continues when one provider's submitReview fails, still reviewing the other", async () => {
		const request = vi.fn().mockResolvedValue(pollResponse());
		const submitReview = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(undefined);
		const log = vi.fn();

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic"), buildTarget("openai")],
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
			sleep: vi.fn().mockResolvedValue(undefined),
			log,
			submitReview,
			maxCycles: 1,
		});

		expect(result).toEqual({ cycles: 1, reason: "max-cycles" });
		expect(submitReview).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("review failed, continuing"),
		);
	});
});
