import type { App } from "octokit";
import type { OctokitLike } from "./audit-pr.js";
import type { Provider, ResolvedAuth } from "./auth.js";
import type { AppConfig } from "./config.js";
import {
	maybeSubmitReview,
	NO_NEW_REVIEW_REASON,
	type PullRequestDetails,
	type SubmitReviewOutcome,
} from "./github-app.js";

/** Enough of the GET /pulls/{n} response shape for watchPr's own merged/closed
 * check plus everything maybeSubmitReview's pullRequest param needs. */
interface PolledPullRequest extends PullRequestDetails {
	merged: boolean;
	state: string;
}

export interface ProviderTarget {
	provider: Provider;
	app: App;
	installationId: number;
	config: AppConfig;
}

export interface WatchPrOptions {
	owner: string;
	repo: string;
	pullNumber: number;
	pollOctokit: OctokitLike;
	targets: ProviderTarget[];
	resolveAuthFor: (provider: Provider) => Promise<ResolvedAuth>;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	log?: (msg: string) => void;
	submitReview?: typeof maybeSubmitReview;
	/** Test-only escape hatch: stop after this many poll cycles regardless of
	 * PR state. Unset in production — the loop runs until merged/closed. */
	maxCycles?: number;
	/** Injectable clock for the circuit breaker's rolling window. Defaults to
	 * `Date.now`. */
	now?: () => number;
	/** Mechanical guard against the fast-repush review-nitpick loop documented
	 * in docs/post-mortem-review-loop-churn.md (ai-review-bot-599): a fast
	 * local watcher re-reviewing every push from an agent that pushes every
	 * 2-5 min raced its own fix-verify-push cadence and ran 8-10 review
	 * rounds before a human caught it. Prose guidance to pause the watcher
	 * already existed and was recognized-but-not-enforced in that incident,
	 * so this stops the loop itself once a single provider posts `maxReviews`
	 * reviews within `windowMs` — pass `false` to disable (e.g. a deliberate
	 * final confirmation pass after the operator has already reviewed the
	 * fix-verify-push cadence by hand). Defaults to 3 reviews / 15 min. */
	circuitBreaker?: { maxReviews: number; windowMs: number } | false;
}

export interface WatchResult {
	cycles: number;
	reason: "merged" | "closed" | "max-cycles" | "circuit-breaker";
}

const DEFAULT_CIRCUIT_BREAKER = { maxReviews: 3, windowMs: 15 * 60_000 };

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** True for the one "skipped" outcome that's a terminal, already-persisted
 * decision (the triage gate found nothing to review at this SHA) rather than
 * a retryable skip like a draft PR or a rate limit. See Bug F. */
function isNoNewReview(outcome: SubmitReviewOutcome): boolean {
	return (
		outcome.status === "skipped" && outcome.reason === NO_NEW_REVIEW_REASON
	);
}

/** Human-readable reason for every non-"posted" outcome, for the "skipped"
 * log line. */
function outcomeSkipReason(outcome: SubmitReviewOutcome): string {
	switch (outcome.status) {
		case "skipped":
			return outcome.reason;
		case "rate_limited":
			return "rate limited";
		case "quota_exhausted":
			return "quota exhausted";
		default:
			return outcome.status;
	}
}

/**
 * Polls an already-open PR and re-reviews it on every new push, posting
 * through the same GitHub App installation identities production uses —
 * driven by local subscription auth (resolveAuthFor) instead of API keys.
 * Exits once the PR merges or closes. See
 * docs/superpowers/plans/2026-08-16-local-pr-watch-subscription-auth.md.
 */
export async function watchPr(opts: WatchPrOptions): Promise<WatchResult> {
	const {
		owner,
		repo,
		pullNumber,
		pollOctokit,
		targets,
		resolveAuthFor,
		intervalMs = 60_000,
		sleep = defaultSleep,
		log = console.log,
		submitReview = maybeSubmitReview,
		maxCycles,
		now = Date.now,
		circuitBreaker = DEFAULT_CIRCUIT_BREAKER,
	} = opts;

	// anthropicreviewbot (PR #69): maxReviews < 1 trips on the very first post
	// with no signal the config is nonsensical, silently defeating the guard
	// it's meant to provide instead of failing loudly. Number.isFinite also
	// catches NaN (round 2 of the same review): every `< 1` and `>= maxReviews`
	// comparison against NaN is false, so an unvalidated NaN would disable the
	// breaker just as silently as maxReviews: 0 does.
	if (
		circuitBreaker &&
		(!Number.isFinite(circuitBreaker.maxReviews) ||
			circuitBreaker.maxReviews < 1)
	) {
		throw new Error(
			`circuitBreaker.maxReviews must be at least 1, got: ${circuitBreaker.maxReviews}`,
		);
	}
	// anthropicreviewbot (PR #69, round 3): windowMs <= 0 (or non-finite)
	// prunes every stored timestamp before each push, so recentPosts never
	// grows past length 1 and the breaker can never reach maxReviews —
	// silently defeated the same way an unvalidated maxReviews is.
	if (
		circuitBreaker &&
		(!Number.isFinite(circuitBreaker.windowMs) || circuitBreaker.windowMs <= 0)
	) {
		throw new Error(
			`circuitBreaker.windowMs must be positive, got: ${circuitBreaker.windowMs}`,
		);
	}

	let cycles = 0;
	// Per provider, so one provider's failed or skipped cycle never denies a
	// co-target a retry on the same commit.
	const providerState = new Map(
		targets.map((target) => [
			target.provider,
			{
				lastReviewedSha: null as string | null,
				// Timestamps of this provider's recent posts, for the circuit
				// breaker's rolling window. See WatchPrOptions.circuitBreaker.
				recentPosts: [] as number[],
			},
		]),
	);

	// Fail fast on missing/expired credentials for every selected provider
	// BEFORE the first poll or post, so a PR watched across both providers
	// never posts a real review for one and then crashes resolving auth for
	// the other. auth.ts refreshes tokens internally, so resolving again
	// per-cycle below is still correct — this is an additional up-front
	// validation, not a replacement. See Bug D.
	for (const target of targets) {
		await resolveAuthFor(target.provider);
	}

	while (true) {
		// Checked before incrementing so a maxCycles of N always means N
		// completed poll+sleep cycles, not N-1 — the test-only escape hatch
		// stops the loop *after* the Nth cycle has run to completion.
		if (maxCycles !== undefined && cycles >= maxCycles) {
			return { cycles, reason: "max-cycles" };
		}
		cycles += 1;

		let pr: PolledPullRequest;
		try {
			const response = await pollOctokit.request<PolledPullRequest>(
				"GET /repos/{owner}/{repo}/pulls/{pull_number}",
				{ owner, repo, pull_number: pullNumber },
			);
			pr = response.data;
		} catch (err) {
			log(
				`ai-review watch: poll failed, retrying next interval: ${errMsg(err)}`,
			);
			await sleep(intervalMs);
			continue;
		}

		if (pr.merged || pr.state === "closed") {
			log(
				`ai-review watch: PR #${pullNumber} is ${pr.merged ? "merged" : "closed"} — exiting`,
			);
			return { cycles, reason: pr.merged ? "merged" : "closed" };
		}

		for (const target of targets) {
			const state = providerState.get(target.provider);
			if (!state || pr.head.sha === state.lastReviewedSha) continue;

			// Not caught here: an auth-resolution failure (e.g. the local
			// subscription session logged out mid-watch) propagates out of
			// watchPr entirely, surfacing auth.ts's own "run `claude`/`codex
			// login`" error instead of retrying forever with no signal.
			const auth = await resolveAuthFor(target.provider);
			try {
				const outcome = await submitReview({
					app: target.app,
					installationId: target.installationId,
					owner,
					repo,
					pullNumber,
					pullRequest: pr,
					extraInstructions: "",
					force: false,
					config: target.config,
					auth,
				});
				if (outcome.status === "posted") {
					// Only advance this provider's lastReviewedSha on an actual
					// post — a skip/rate-limit/quota-exhaustion must retry at the
					// same SHA next cycle instead of being silently marked
					// "handled". See Bug C.
					state.lastReviewedSha = pr.head.sha;
					log(
						`ai-review watch: posted ${target.provider} review for ${pr.head.sha}`,
					);

					if (circuitBreaker) {
						const nowMs = now();
						state.recentPosts = state.recentPosts.filter(
							(t) => nowMs - t < circuitBreaker.windowMs,
						);
						state.recentPosts.push(nowMs);
						if (state.recentPosts.length >= circuitBreaker.maxReviews) {
							const windowMin = Math.round(circuitBreaker.windowMs / 60_000);
							log(
								`ai-review watch: circuit breaker tripped on cycle ${cycles} — ${target.provider} posted ${state.recentPosts.length} reviews for ${owner}/${repo}#${pullNumber} within ${windowMin} min. This usually means fixes are being pushed faster than the reviewer can converge (see docs/post-mortem-review-loop-churn.md). Stopping — let the PR settle, then restart watch for a final confirmation pass.`,
							);
							return { cycles, reason: "circuit-breaker" };
						}
					}
					// A push can land while this provider reviews; refresh so the
					// next provider reviews the current head, not the cycle-start one.
					if (target !== targets[targets.length - 1]) {
						try {
							const refreshed = await pollOctokit.request<PolledPullRequest>(
								"GET /repos/{owner}/{repo}/pulls/{pull_number}",
								{ owner, repo, pull_number: pullNumber },
							);
							pr = refreshed.data;
						} catch (pollErr) {
							log(
								`ai-review watch: re-poll after ${target.provider} post failed; the next provider will review the previous snapshot: ${errMsg(pollErr)}`,
							);
						}
					}
				} else if (isNoNewReview(outcome)) {
					// The triage gate already decided that this SHA needs no
					// review — a terminal decision, not a transient skip, so
					// retrying it would only repeat that decision. See Bug F.
					state.lastReviewedSha = pr.head.sha;
					log(
						`ai-review watch: ${target.provider} has no new review to post for ${pr.head.sha}`,
					);
				} else {
					log(
						`ai-review watch: ${target.provider} review skipped for ${pr.head.sha}: ${outcomeSkipReason(outcome)}`,
					);
				}
			} catch (err) {
				log(
					`ai-review watch: ${target.provider} review failed, continuing: ${errMsg(err)}`,
				);
			}
		}

		await sleep(intervalMs);
	}
}
