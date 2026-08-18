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
}

export interface WatchResult {
	cycles: number;
	reason: "merged" | "closed" | "max-cycles";
}

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
	} = opts;

	let cycles = 0;
	// Per-provider, not session-wide: each provider has its own "have I ever
	// posted" flag and "last SHA I successfully reviewed" marker. A single
	// shared pair would leak across providers within one watch session — one
	// provider posting first would (a) flip force:false for a co-target's
	// still-genuinely-first post in the same cycle, breaking the "first post
	// matches production" parity below the flag exists for, and (b) advance
	// the shared SHA marker even for a provider that failed/skipped, silently
	// and permanently denying it a retry on that commit. Surfaced by
	// anthropicreviewbot's own re-review of this PR while dogfooding watch on
	// itself. See Bug A / Bug C / Bug E.
	const providerState = new Map(
		targets.map((target) => [
			target.provider,
			{ hasPostedEver: false, lastReviewedSha: null as string | null },
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
					force: !state.hasPostedEver,
					config: target.config,
					auth,
				});
				if (outcome.status === "posted") {
					// Only advance this provider's lastReviewedSha on an actual
					// post — a skip/rate-limit/quota-exhaustion must retry at the
					// same SHA next cycle instead of being silently marked
					// "handled". See Bug C.
					state.hasPostedEver = true;
					state.lastReviewedSha = pr.head.sha;
					log(
						`ai-review watch: posted ${target.provider} review for ${pr.head.sha}`,
					);
				} else if (isNoNewReview(outcome)) {
					// The triage gate already decided (and persisted to KV) that
					// this SHA needs no review — a terminal decision, not a
					// transient skip. Retrying it would re-enter buildReview with
					// lastReviewedSha already equal to headSha, bypass the triage
					// guard, and post an unwanted full review. See Bug F.
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
