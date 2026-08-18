import type { App } from "octokit";
import type { OctokitLike } from "./audit-pr.js";
import type { Provider, ResolvedAuth } from "./auth.js";
import type { AppConfig } from "./config.js";
import { createUpstashKv } from "./feedback/kv.js";
import {
	maybeSubmitReview,
	NO_NEW_REVIEW_REASON,
	type PullRequestDetails,
	type SubmitReviewOutcome,
} from "./github-app.js";
import { loadReviewState } from "./review-state.js";

/** The one field of buildReview's persisted review state that watchPr needs:
 * the SHA of the last review decision recorded for this provider/PR. This
 * doesn't by itself prove a review was successfully posted to GitHub for
 * that SHA — see the seeding comment below for what it's actually used for
 * and why that distinction doesn't matter there. */
export interface PersistedWatchState {
	lastReviewedSha: string | null;
}

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
	/** Consults the same server-side state `buildReview` persists to KV, so a
	 * restarted watch process can tell "this exact head SHA was already fully
	 * reviewed by this bot in a prior session" from "this is a genuinely fresh
	 * watch session" — see `ai-review-bot-aou`. Defaults to a real KV-backed
	 * lookup; returns `null` when KV is unconfigured or the lookup fails,
	 * which reproduces today's behavior unchanged (force:true on cycle 1). */
	loadPersistedState?: (
		provider: Provider,
	) => Promise<PersistedWatchState | null>;
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
		loadPersistedState = async (provider: Provider) => {
			let kv: ReturnType<typeof createUpstashKv>;
			try {
				kv = createUpstashKv();
			} catch (err) {
				// KV being unconfigured is routine (matches getKv()'s own graceful
				// degradation in github-app.ts) but still worth a log line — a
				// silent failure here is indistinguishable from "nothing to seed",
				// and ai-review-bot-aou's fix quietly not engaging on a genuine KV
				// outage is exactly the kind of failure this needs to be
				// observable for, not silent about.
				// No presumptive "(KV unconfigured)" label — createUpstashKv() only
				// throws today for missing env vars, but labeling every throw as
				// specifically "unconfigured" would misdiagnose a future, different
				// failure. The real message is always appended, so the actual cause
				// stays observable either way; this now matches getKv()'s neutral
				// wording in github-app.ts. Found by codexreviewbot reviewing PR #67
				// (PRRT_kwDOSM5cU86Z-0Ku).
				log(
					`ai-review watch: loadPersistedState unavailable for ${provider}: ${errMsg(err)}`,
				);
				return null;
			}
			try {
				const state = await loadReviewState(
					kv,
					provider,
					owner,
					repo,
					pullNumber,
					null,
				);
				return state ? { lastReviewedSha: state.lastReviewedSha } : null;
			} catch (err) {
				// "seeding" rather than a hardcoded "cycle 1" — loadPersistedState is
				// only ever called on cycle 1 by construction today, but the message
				// itself shouldn't assume that call site never moves. Found by
				// anthropicreviewbot reviewing PR #67 (PRRT_kwDOSM5cU86Z-uZK).
				log(
					`ai-review watch: loadPersistedState failed for ${provider}, seeding will be skipped: ${errMsg(err)}`,
				);
				return null;
			}
		},
		maxCycles,
	} = opts;

	let cycles = 0;
	// ai-review-bot-aou: seeded once, on the very first cycle only — see the
	// pre-loop-body seeding block below for why.
	let seededFromPersistedState = false;
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

		// ai-review-bot-aou: cycle 1 only, and reusing this cycle's own poll
		// result rather than an extra pre-loop round-trip. hasPostedEver starts
		// false for every provider on every fresh `watchPr` call — including a
		// restart of a previously-running session — which forces force:true on
		// cycle 1 (Bug A) and skips buildReview's triage gate entirely. If the
		// current head SHA was already fully reviewed by this same bot in a
		// PRIOR (killed) watch session, that decision is sitting in the same KV
		// state buildReview persists; seed from it here so a restart doesn't
		// repost a duplicate FULL review. A stale/mismatched SHA, or no
		// persisted state at all (KV unconfigured, cold, or a genuinely fresh
		// session), leaves force:true unchanged.
		if (!seededFromPersistedState) {
			seededFromPersistedState = true;
			for (const target of targets) {
				const state = providerState.get(target.provider);
				if (!state) continue;
				const persisted = await loadPersistedState(target.provider);
				if (persisted?.lastReviewedSha === pr.head.sha) {
					// Only hasPostedEver — NOT lastReviewedSha. Setting the SHA here
					// too would trip the per-target loop's own `pr.head.sha ===
					// state.lastReviewedSha` skip guard below and skip calling
					// submitReview entirely on cycle 1, before buildReview's own
					// idempotency check has had a chance to run — fine on a restart
					// where that's genuinely correct, but wrong on a fresh session,
					// which this same seeding code path can't tell apart from a
					// restart by SHA match alone. Leaving it unset instead lets
					// submitReview run with force:false as normal, so buildReview's
					// own idempotency checks (the "Reviewed commit:" marker check
					// and/or the KV triage gate) make the real determination and the
					// existing posted/no-new-review outcome handling below sets
					// lastReviewedSha correctly either way.
					state.hasPostedEver = true;
				}
			}
		}

		for (const [targetIndex, target] of targets.entries()) {
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
					// ai-review-bot-1f5: re-poll before the NEXT target's post (if
					// any) in this cycle, so its PR-body PATCH builds on this
					// provider's just-posted summary section instead of the stale
					// pre-cycle `pr` snapshot. injectPRSection now uses per-provider
					// markers (each provider's section coexists independently), but
					// a stale snapshot still risks the next provider's PATCH writing
					// an outright older version of THIS provider's section, so the
					// re-poll is still worth doing on top of that fix, not made
					// redundant by it. `pr` is redeclared fresh at the top of every
					// cycle (see the `let pr` above), so this reassignment cannot
					// leak into a later cycle — only into later targets this cycle.
					if (targetIndex < targets.length - 1) {
						try {
							const refreshed = await pollOctokit.request<PolledPullRequest>(
								"GET /repos/{owner}/{repo}/pulls/{pull_number}",
								{ owner, repo, pull_number: pullNumber },
							);
							pr = refreshed.data;
						} catch (pollErr) {
							log(
								`ai-review watch: re-poll after ${target.provider} post failed; next provider's PR-body PATCH will likely overwrite the just-posted section: ${errMsg(pollErr)}`,
							);
						}
					}
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
