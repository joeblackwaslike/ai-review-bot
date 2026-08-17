import type { App } from "octokit";
import type { OctokitLike } from "./audit-pr.js";
import type { Provider, ResolvedAuth } from "./auth.js";
import type { AppConfig } from "./config.js";
import { maybeSubmitReview, type PullRequestDetails } from "./github-app.js";

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

	let lastReviewedSha: string | null = null;
	let cycles = 0;

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

		if (pr.head.sha !== lastReviewedSha) {
			for (const target of targets) {
				// Not caught here: an auth-resolution failure (e.g. the local
				// subscription session logged out mid-watch) propagates out of
				// watchPr entirely, surfacing auth.ts's own "run `claude`/`codex
				// login`" error instead of retrying forever with no signal.
				const auth = await resolveAuthFor(target.provider);
				try {
					await submitReview({
						app: target.app,
						installationId: target.installationId,
						owner,
						repo,
						pullNumber,
						pullRequest: pr,
						extraInstructions: "",
						force: true,
						config: target.config,
						auth,
					});
					log(
						`ai-review watch: posted ${target.provider} review for ${pr.head.sha}`,
					);
				} catch (err) {
					log(
						`ai-review watch: ${target.provider} review failed, continuing: ${errMsg(err)}`,
					);
				}
			}
			lastReviewedSha = pr.head.sha;
		}

		await sleep(intervalMs);
	}
}
