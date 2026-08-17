import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import type { SubmitReviewOutcome } from "./github-app.js";
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

const posted: SubmitReviewOutcome = { status: "posted", event: "COMMENT" };
const skipped: SubmitReviewOutcome = {
	status: "skipped",
	reason: "pull request is a draft",
};

describe("watchPr", () => {
	it("posts once per provider on the first cycle, then not again while the SHA is unchanged", async () => {
		const request = vi.fn().mockResolvedValue(pollResponse());
		const submitReview = vi.fn().mockResolvedValue(posted);
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
		// One preflight resolution per target, plus one more per target for the
		// single cycle that actually posts (Bug D pre-flight + per-cycle reuse).
		expect(resolveAuthFor).toHaveBeenCalledTimes(4);
		expect(sleep).toHaveBeenCalledTimes(3);
	});

	it("re-reviews once per provider when the head SHA changes", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(pollResponse({ headSha: "sha1" }))
			.mockResolvedValueOnce(pollResponse({ headSha: "sha2" }))
			.mockResolvedValue(pollResponse({ headSha: "sha2" }));
		const submitReview = vi.fn().mockResolvedValue(posted);

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
			submitReview: vi.fn().mockResolvedValue(posted),
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
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
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
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
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
			.mockResolvedValueOnce(posted);
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

	// Bug A: force must be true only for the very first review this watch
	// session posts, not on every cycle — otherwise reviewer memory (KV state
	// load) and the triage gate are disabled every single cycle, and the
	// state-persistence write silently overwrites real state with an
	// empty-prior union every push.
	it("passes force: true only until the first successful post, then force: false on every subsequent cycle", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(pollResponse({ headSha: "sha1" }))
			.mockResolvedValueOnce(pollResponse({ headSha: "sha2" }))
			.mockResolvedValue(pollResponse({ headSha: "sha3" }));
		const submitReview = vi.fn().mockResolvedValue(posted);

		await watchPr({
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

		expect(submitReview).toHaveBeenCalledTimes(3);
		expect(submitReview.mock.calls[0][0]).toEqual(
			expect.objectContaining({ force: true }),
		);
		expect(submitReview.mock.calls[1][0]).toEqual(
			expect.objectContaining({ force: false }),
		);
		expect(submitReview.mock.calls[2][0]).toEqual(
			expect.objectContaining({ force: false }),
		);
	});

	// Bug C: a cycle where nothing actually posted must not advance
	// lastReviewedSha — otherwise the SHA is burned and never retried (a
	// rate-limited or quota-exhausted cycle promises an auto-retry that then
	// never happens under watch).
	it("does not advance lastReviewedSha on a cycle where submitReview does not report posted", async () => {
		const request = vi
			.fn()
			.mockResolvedValue(pollResponse({ headSha: "sha1" }));
		const submitReview = vi
			.fn()
			.mockResolvedValueOnce({
				status: "rate_limited",
			} satisfies SubmitReviewOutcome)
			.mockResolvedValueOnce({
				status: "rate_limited",
			} satisfies SubmitReviewOutcome)
			.mockResolvedValue(posted);

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

		// Same SHA every poll, but submitReview is retried every cycle because
		// the first two cycles never actually posted.
		expect(result).toEqual({ cycles: 3, reason: "max-cycles" });
		expect(submitReview).toHaveBeenCalledTimes(3);
	});

	// Bug C, draft-PR variant: a watched draft PR must be retried every cycle
	// (submitReview reports a skip, not a post) until it eventually posts once
	// marked ready — watchPr itself never needs to know about `draft`, it just
	// reacts to whatever status submitReview reports.
	it("retries a draft PR every cycle until submitReview eventually reports posted", async () => {
		const request = vi
			.fn()
			.mockResolvedValue(pollResponse({ headSha: "sha1" }));
		const submitReview = vi
			.fn()
			.mockResolvedValueOnce(skipped)
			.mockResolvedValueOnce(skipped)
			.mockResolvedValueOnce(posted)
			.mockResolvedValue(posted);

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
			maxCycles: 4,
		});

		expect(result).toEqual({ cycles: 4, reason: "max-cycles" });
		// Cycles 1-2 skip (draft) and retry the same SHA; cycle 3 posts and
		// advances the SHA; cycle 4 sees the same SHA as cycle 3's post and does
		// not call submitReview again.
		expect(submitReview).toHaveBeenCalledTimes(3);
	});

	// Bug D: auth must be validated for every target BEFORE any polling or
	// posting, so a missing credential for one provider can't let the other
	// post a partial review before the process crashes.
	it("resolves auth for every target before the first poll, and a failure for one target prevents any post", async () => {
		const request = vi.fn().mockResolvedValue(pollResponse());
		const submitReview = vi.fn().mockResolvedValue(posted);
		const resolveAuthFor = vi.fn(async (provider: "anthropic" | "openai") => {
			if (provider === "openai") {
				throw new Error("run `codex login` to log in");
			}
			return { ...apiKeyAuth, provider };
		});

		await expect(
			watchPr({
				owner: "o",
				repo: "r",
				pullNumber: 5,
				pollOctokit: { request },
				targets: [buildTarget("anthropic"), buildTarget("openai")],
				resolveAuthFor,
				sleep: vi.fn().mockResolvedValue(undefined),
				log: () => {},
				submitReview,
			}),
		).rejects.toThrow(/run `codex login` to log in/);

		// The failure happened during pre-flight, before the polling loop ever
		// ran — no poll and no post for either target.
		expect(request).not.toHaveBeenCalled();
		expect(submitReview).not.toHaveBeenCalled();
	});
});
