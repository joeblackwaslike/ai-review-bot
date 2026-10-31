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
		body: string | null;
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
			body: overrides.body ?? null,
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
// Distinct from `skipped` above: this is buildReview's triage gate concluding
// (and persisting to KV) that this exact SHA needs no review at all — not a
// transient/retryable skip like a draft PR or a rate limit.
const noNewReview: SubmitReviewOutcome = {
	status: "skipped",
	reason: "no new review to post",
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

	it("first cycle sends force false", async () => {
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
		for (const [args] of submitReview.mock.calls) {
			expect(args.force).toBe(false);
		}
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

	// Bug E continued: a shared lastReviewedSha means that once ANY provider
	// posts successfully for a SHA, the whole per-target loop is skipped on
	// the next cycle — silently and permanently denying a retry to a provider
	// that failed/skipped on that same SHA (it will never see that commit
	// again unless the PR receives a new push).
	it("keeps retrying a provider that failed this cycle on the same SHA, without re-posting the provider that already succeeded", async () => {
		const request = vi
			.fn()
			.mockResolvedValue(pollResponse({ headSha: "sha1" }));
		const submitReview = vi.fn((arg: { config: { provider: string } }) =>
			arg.config.provider === "openai"
				? Promise.reject(new Error("boom"))
				: Promise.resolve(posted),
		);

		await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic"), buildTarget("openai")],
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
			sleep: vi.fn().mockResolvedValue(undefined),
			log: () => {},
			submitReview,
			maxCycles: 2,
		});

		// Cycle 1: both targets attempted (anthropic posts, openai throws).
		// Cycle 2, same SHA: anthropic must NOT be called again (it already
		// posted for sha1), but openai must be retried (it never succeeded).
		const calls = submitReview.mock.calls as unknown as Array<
			[{ config: { provider: string } }]
		>;
		const anthropicCalls = calls.filter(
			([arg]) => arg.config.provider === "anthropic",
		);
		const openaiCalls = calls.filter(
			([arg]) => arg.config.provider === "openai",
		);
		expect(anthropicCalls).toHaveLength(1);
		expect(openaiCalls).toHaveLength(2);
	});

	// Bug F: a "no new review to post" skip is buildReview's triage gate
	// concluding — and persisting to KV — that this exact SHA needs no
	// review. Retrying it (like a genuinely transient skip) re-enters
	// buildReview with lastReviewedSha already equal to headSha in the
	// persisted state, so the triage gate's guard condition
	// (`state.lastReviewedSha !== context.headSha`) no longer holds and
	// execution falls through into posting a full, unwanted review —
	// silently contradicting the triage decision that was just made.
	// Surfaced by chatgpt-codex-connector's review of PR #65.
	it("treats a 'no new review to post' skip as handled, not retryable, unlike other skips", async () => {
		const request = vi
			.fn()
			.mockResolvedValue(pollResponse({ headSha: "sha1" }));
		const submitReview = vi.fn().mockResolvedValue(noNewReview);

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

		expect(result).toEqual({ cycles: 3, reason: "max-cycles" });
		// Called once on cycle 1; cycles 2-3 see the same SHA already marked
		// handled and don't call submitReview again — unlike the draft-PR skip
		// above, which retries every cycle.
		expect(submitReview).toHaveBeenCalledTimes(1);
	});

	it("does not re-review a head that buildReview went silent on, but reviews the next head", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(pollResponse({ headSha: "sha1" }))
			.mockResolvedValueOnce(pollResponse({ headSha: "sha1" }))
			.mockResolvedValue(pollResponse({ headSha: "sha2" }));
		const submitReview = vi
			.fn()
			.mockResolvedValueOnce(noNewReview)
			.mockResolvedValue(posted);

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
			maxCycles: 4,
		});

		expect(
			submitReview.mock.calls.map(([args]) => args.pullRequest.head.sha),
		).toEqual(["sha1", "sha2"]);
	});

	it("restart on an already-reviewed head ends as no new review and does not post", async () => {
		const request = vi
			.fn()
			.mockResolvedValue(pollResponse({ headSha: "sha1" }));
		const submitReview = vi.fn().mockResolvedValue(noNewReview);
		const log = vi.fn();

		await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic")],
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
			sleep: vi.fn().mockResolvedValue(undefined),
			log,
			submitReview,
			maxCycles: 3,
		});

		expect(submitReview).toHaveBeenCalledTimes(1);
		expect(submitReview.mock.calls[0][0]).toEqual(
			expect.objectContaining({ force: false }),
		);
		expect(log).not.toHaveBeenCalledWith(
			expect.stringContaining("posted anthropic review"),
		);
		expect(log).toHaveBeenCalledWith(
			"ai-review watch: anthropic has no new review to post for sha1",
		);
	});

	it("does not re-poll the PR or write to its description between targets", async () => {
		const request = vi.fn().mockResolvedValue(pollResponse({ body: "orig" }));
		const submitReview = vi.fn().mockResolvedValue(posted);

		await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic"), buildTarget("openai")],
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
			sleep: vi.fn().mockResolvedValue(undefined),
			log: () => {},
			submitReview,
			maxCycles: 1,
		});

		expect(submitReview).toHaveBeenCalledTimes(2);
		const routes = request.mock.calls.map(([route]) => route as string);
		expect(routes.filter((r) => r.startsWith("PATCH "))).toEqual([]);
		expect(request).toHaveBeenCalledTimes(1);
	});

	// ai-review-bot-599 / docs/post-mortem-review-loop-churn.md: a fast local
	// watcher re-reviewing every push from an agent that pushes every 2-5 min
	// produced 8-10 review rounds in ~2 hours before a human caught it. Prose
	// guidance (state a round cap, pause the watcher) already existed and was
	// recognized-but-not-enforced in that incident, so the mechanical guard
	// lives here instead of relying on the operator remembering it.
	describe("circuit breaker", () => {
		it("trips and stops the loop after maxReviews posts land within the window", async () => {
			let call = 0;
			const request = vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(pollResponse({ headSha: `sha${++call}` })),
				);
			const submitReview = vi.fn().mockResolvedValue(posted);
			const log = vi.fn();
			let clock = 0;
			const now = vi.fn(() => {
				clock += 60_000; // 1 min apart — well within the window
				return clock;
			});

			const result = await watchPr({
				owner: "o",
				repo: "r",
				pullNumber: 5,
				pollOctokit: { request },
				targets: [buildTarget("anthropic")],
				resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
				sleep: vi.fn().mockResolvedValue(undefined),
				log,
				submitReview,
				now,
				circuitBreaker: { maxReviews: 3, windowMs: 900_000 },
				maxCycles: 10,
			});

			expect(result).toEqual({ cycles: 3, reason: "circuit-breaker" });
			expect(submitReview).toHaveBeenCalledTimes(3);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("circuit breaker"),
			);
			// anthropicreviewbot (PR #69): the trip log had no breadcrumb for how
			// many cycles ran before firing — diagnosing "did it trip on cycle 2
			// or cycle 10" required re-deriving it from submitReview's own call
			// count instead of the log line itself.
			expect(log).toHaveBeenCalledWith(expect.stringContaining("cycle 3"));
		});

		// anthropicreviewbot (PR #69, medium): `maxReviews: 0` (or a negative
		// value) trips on the very first post with no signal that the config
		// itself is nonsensical — silently defeating the feature it's meant to
		// protect, which is worse than an obvious crash.
		it("rejects a circuitBreaker config with maxReviews below 1", async () => {
			await expect(
				watchPr({
					owner: "o",
					repo: "r",
					pullNumber: 5,
					pollOctokit: { request: vi.fn() },
					targets: [buildTarget("anthropic")],
					resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
					sleep: vi.fn().mockResolvedValue(undefined),
					log: () => {},
					submitReview: vi.fn(),
					circuitBreaker: { maxReviews: 0, windowMs: 900_000 },
					// Safety ceiling: validation must reject before the loop polls,
					// so maxCycles: 1 is never actually reached.
					maxCycles: 1,
				}),
			).rejects.toThrow(/maxReviews/);
		});

		it("rejects a circuitBreaker config with a negative maxReviews", async () => {
			await expect(
				watchPr({
					owner: "o",
					repo: "r",
					pullNumber: 5,
					pollOctokit: { request: vi.fn() },
					targets: [buildTarget("anthropic")],
					resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
					sleep: vi.fn().mockResolvedValue(undefined),
					log: () => {},
					submitReview: vi.fn(),
					circuitBreaker: { maxReviews: -1, windowMs: 900_000 },
					maxCycles: 1,
				}),
			).rejects.toThrow(/maxReviews/);
		});

		// anthropicreviewbot (PR #69, round 2): `NaN < 1` is `false`, so the
		// original `< 1` guard let a non-finite maxReviews silently through —
		// and every `recentPosts.length >= NaN` comparison is also `false`, so
		// the breaker would then never trip, defeating it just as silently as
		// the maxReviews: 0 case this guard already covers.
		it("rejects a circuitBreaker config with a non-finite maxReviews", async () => {
			await expect(
				watchPr({
					owner: "o",
					repo: "r",
					pullNumber: 5,
					pollOctokit: { request: vi.fn() },
					targets: [buildTarget("anthropic")],
					resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
					sleep: vi.fn().mockResolvedValue(undefined),
					log: () => {},
					submitReview: vi.fn(),
					circuitBreaker: { maxReviews: Number.NaN, windowMs: 900_000 },
					maxCycles: 1,
				}),
			).rejects.toThrow(/maxReviews/);
		});

		// anthropicreviewbot (PR #69, round 3): the same NaN/finite gap applies
		// to windowMs — a non-finite window would make every recentPosts filter
		// comparison false, pruning nothing and growing the array unbounded
		// instead of tripping.
		it("rejects a circuitBreaker config with a non-finite windowMs", async () => {
			await expect(
				watchPr({
					owner: "o",
					repo: "r",
					pullNumber: 5,
					pollOctokit: { request: vi.fn() },
					targets: [buildTarget("anthropic")],
					resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
					sleep: vi.fn().mockResolvedValue(undefined),
					log: () => {},
					submitReview: vi.fn(),
					circuitBreaker: { maxReviews: 3, windowMs: Number.NaN },
					maxCycles: 1,
				}),
			).rejects.toThrow(/windowMs/);
		});

		// A windowMs of 0 (or negative) prunes every stored timestamp before
		// each push (nowMs - t < 0 is never true for a non-decreasing clock),
		// so recentPosts never grows past length 1 and the breaker can never
		// reach maxReviews — silently defeated the same way maxReviews: 0 is.
		it("rejects a circuitBreaker config with a non-positive windowMs", async () => {
			await expect(
				watchPr({
					owner: "o",
					repo: "r",
					pullNumber: 5,
					pollOctokit: { request: vi.fn() },
					targets: [buildTarget("anthropic")],
					resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
					sleep: vi.fn().mockResolvedValue(undefined),
					log: () => {},
					submitReview: vi.fn(),
					circuitBreaker: { maxReviews: 3, windowMs: 0 },
					maxCycles: 1,
				}),
			).rejects.toThrow(/windowMs/);
		});

		// anthropicreviewbot (PR #69): nothing exercised the *actual* default
		// (3 reviews / 15 min) end-to-end — every other test in this block
		// passes an explicit config that happens to match it, which would stay
		// green even if a future edit silently changed DEFAULT_CIRCUIT_BREAKER
		// or broke the CLI's "omit the option" path into watchPr's default.
		it("trips on watch.ts's own default when the caller omits circuitBreaker entirely", async () => {
			let call = 0;
			const request = vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(pollResponse({ headSha: `sha${++call}` })),
				);
			const submitReview = vi.fn().mockResolvedValue(posted);
			let clock = 0;
			// 60s steps — all three posts land within DEFAULT_CIRCUIT_BREAKER's
			// 15-min window regardless of what the concrete numbers are, since
			// this test exists specifically to not hardcode them.
			const now = vi.fn(() => {
				clock += 60_000;
				return clock;
			});

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
				now,
				maxCycles: 10,
			});

			expect(result).toEqual({ cycles: 3, reason: "circuit-breaker" });
		});

		it("does not trip when posts are spaced further apart than the window", async () => {
			let call = 0;
			const request = vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(pollResponse({ headSha: `sha${++call}` })),
				);
			const submitReview = vi.fn().mockResolvedValue(posted);
			let clock = 0;
			const now = vi.fn(() => {
				clock += 1_000_000; // outside the 900_000ms window every time
				return clock;
			});

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
				now,
				circuitBreaker: { maxReviews: 3, windowMs: 900_000 },
				maxCycles: 5,
			});

			expect(result).toEqual({ cycles: 5, reason: "max-cycles" });
			expect(submitReview).toHaveBeenCalledTimes(5);
		});

		it("never trips when the circuit breaker is disabled", async () => {
			let call = 0;
			const request = vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(pollResponse({ headSha: `sha${++call}` })),
				);
			const submitReview = vi.fn().mockResolvedValue(posted);
			let clock = 0;
			const now = vi.fn(() => {
				clock += 60_000;
				return clock;
			});

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
				now,
				circuitBreaker: false,
				maxCycles: 5,
			});

			expect(result).toEqual({ cycles: 5, reason: "max-cycles" });
			expect(submitReview).toHaveBeenCalledTimes(5);
		});

		it("tracks each provider's window independently, tripping only the one that is rapid-posting", async () => {
			let call = 0;
			const request = vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(pollResponse({ headSha: `sha${++call}` })),
				);
			// anthropic always posts; openai always reports no new review, so
			// only anthropic's window ever accumulates posts.
			const submitReview = vi.fn(
				async ({ config }: { config: { provider: string } }) =>
					config.provider === "anthropic" ? posted : noNewReview,
			);
			let clock = 0;
			const now = vi.fn(() => {
				clock += 60_000;
				return clock;
			});

			const result = await watchPr({
				owner: "o",
				repo: "r",
				pullNumber: 5,
				pollOctokit: { request },
				targets: [buildTarget("anthropic"), buildTarget("openai")],
				resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
				sleep: vi.fn().mockResolvedValue(undefined),
				log: () => {},
				submitReview,
				now,
				circuitBreaker: { maxReviews: 3, windowMs: 900_000 },
				maxCycles: 10,
			});

			expect(result).toEqual({ cycles: 3, reason: "circuit-breaker" });
		});
	});
});
