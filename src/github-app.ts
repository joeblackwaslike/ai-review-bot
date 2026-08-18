import { App } from "octokit";
import type { Provider, ResolvedAuth } from "./auth.js";
import { createCheckRun } from "./check-run.js";
import { isTrustedAuthorAssociation, parseReviewCommand } from "./commands.js";
import type { AppConfig } from "./config.js";
import { getConfig, getOpenAIAppConfig } from "./config.js";
import type { KvClient } from "./feedback/kv.js";
import { createUpstashKv } from "./feedback/kv.js";
import { persistPostedComments } from "./feedback/persist.js";
import { recordPostedComment } from "./feedback/store.js";
import { capturePostedReview } from "./improve/capture.js";
import { getDb } from "./improve/db/client.js";
import {
	billingUrl,
	notifyQuotaExhausted,
	providerLabel,
	quotaCommentMarker,
	rateLimitCommentMarker,
} from "./notify.js";
import type { PeerOctokit } from "./peers.js";
import {
	fetchPrReviews,
	peersExpectedInRepo,
	shouldRunNow,
	summarizePeers,
} from "./peers.js";
import { resolveStaleThreads } from "./resolve-threads.js";
import type { ReviewDecision, ReviewMetadata } from "./review.js";
import { buildReview } from "./review.js";
import type { ReviewRunMessage } from "./scheduler.js";
import { scheduleReview } from "./scheduler.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The FIRST delay before the first peer check. It is deliberately short now:
// the wait is no longer a guess at how long peers take, it is a poll that ends
// as soon as they have actually posted (see peers.ts). The old fixed delay of
// 9 minutes could not tell "peers are slow" from "peers are never coming", and
// on a fast-moving PR every scheduled run was superseded before it fired —
// which starved our own Codex bot of an entire PR's reviews.
export function selectReviewDelayMs(action: string, config: AppConfig): number {
	return Math.min(
		config.peerCheckIntervalMs,
		action === "synchronize"
			? config.reviewResyncDelayMs
			: config.reviewDelayMs,
	);
}

/** TTL for the per-commit review idempotency claim. Comfortably longer than a
 * full review run (which is bounded by the function's maxDuration) so the lock
 * outlives the agents; it auto-expires as a backstop if a crash skips the
 * explicit release. */
const REVIEW_CLAIM_TTL_SECONDS = 1200;

async function postReviewWithRetry(
	octokit: Awaited<ReturnType<App["getInstallationOctokit"]>>,
	params: {
		owner: string;
		repo: string;
		pullNumber: number;
		commitId: string;
		event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
		body: string;
		comments: ReviewDecision["comments"];
	},
	maxAttempts = 3,
): Promise<number> {
	const delays = [3000, 6000];
	let lastError: unknown;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const response = await octokit.request(
				"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
				{
					owner: params.owner,
					repo: params.repo,
					pull_number: params.pullNumber,
					commit_id: params.commitId,
					event: params.event,
					body: params.body,
					comments: params.comments,
				},
			);
			// GitHub returns the created review's id here. An unexpected shape would yield
			// undefined, which downstream persist matches against pull_request_review_id —
			// no comments match, so persistence is a safe no-op rather than mis-attributing.
			return (response.data as { id: number }).id;
		} catch (err) {
			lastError = err;
			console.error(
				`review POST attempt ${attempt + 1}/${maxAttempts} failed`,
				err,
			);
			if (attempt < maxAttempts - 1) {
				await sleep(delays[attempt]);
			}
		}
	}
	throw lastError;
}

function buildFallbackCommentBody(
	review: ReviewDecision,
	err: unknown,
	commentPrefix: string,
): string {
	const errorMessage = err instanceof Error ? err.message : String(err);

	const inlineSection =
		review.comments.length > 0
			? [
					"",
					"**Inline comments** (could not be anchored — listed by location):",
					"",
					...review.comments.map(
						(c) =>
							`- \`${c.path}:${c.line}\` — ${c.body.replace(/\n+/g, " ").slice(0, 300)}`,
					),
				]
			: [];

	return [
		`⚠️ **[${commentPrefix}] Review API error — findings preserved below**`,
		"",
		`The review could not be posted after 3 attempts. Last error: \`${errorMessage}\``,
		"",
		"---",
		"",
		review.body,
		...inlineSection,
	].join("\n");
}

/** ai-review-bot-1f5: markers are scoped per provider, not shared, so each
 * bot's section can be independently found/replaced by injectPRSection
 * without touching the other's — a single shared marker pair meant the
 * second provider's post always fully replaced the first's regardless of
 * how fresh the body was, which re-polling alone (the original fix) did not
 * solve. Confirmed by chatgpt-codex-connector reviewing PR #67. */
function prSectionMarkers(provider: Provider): { start: string; end: string } {
	return {
		start: `<!-- ai-review-bot:${provider}:start -->`,
		end: `<!-- ai-review-bot:${provider}:end -->`,
	};
}

export function buildPRSummarySection(
	metadata: ReviewMetadata,
	event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
	commentPrefix: string,
	provider: Provider,
): string {
	const verdict =
		event === "APPROVE"
			? "✅ Approved"
			: event === "REQUEST_CHANGES"
				? "⚠️ Changes requested"
				: "💬 Commented";

	const tier2Line =
		metadata.tier2Skills.length > 0
			? `\n| Tier 2 skills | ${metadata.tier2Skills.map((s) => `\`${s}\``).join(", ")} |`
			: "";

	const { start, end } = prSectionMarkers(provider);
	return [
		start,
		`#### ${commentPrefix}`,
		"",
		"| | |",
		"|---|---|",
		`| Verdict | ${verdict} |`,
		`| Findings | ${metadata.generalFindings} general, ${metadata.inlineComments} inline |`,
		`| Model | \`${metadata.model}\` |`,
		`| Agents | ${metadata.tier1Count} Tier 1${metadata.tier2Skills.length > 0 ? ` + ${metadata.tier2Skills.length} Tier 2` : ""} |${tier2Line}`,
		`| Cost | $${metadata.cost.toFixed(6)} |`,
		end,
	].join("\n");
}

/** The pre-ai-review-bot-1f5 unscoped marker pair. Only ever read, never
 * written — kept so injectPRSection can migrate a PR body that still
 * carries it (from before provider-scoped markers shipped) instead of
 * leaving it as permanent orphaned content once a new provider-scoped
 * section starts getting appended alongside it. Found independently by
 * both anthropicreviewbot and codexreviewbot reviewing PR #67. */
const LEGACY_PR_SECTION_START = "<!-- ai-review-bot:start -->";
const LEGACY_PR_SECTION_END = "<!-- ai-review-bot:end -->";

export function injectPRSection(
	existingBody: string | null,
	section: string,
	provider: Provider,
): string {
	let body = existingBody ?? "";
	const legacyStartIdx = body.indexOf(LEGACY_PR_SECTION_START);
	const legacyEndIdx = body.indexOf(LEGACY_PR_SECTION_END);
	// legacyStartIdx < legacyEndIdx guards a malformed body where the end
	// marker appears before the start marker: without it, the slice below
	// duplicates the text between the two markers and leaves both legacy
	// markers behind instead of stripping them. Found by anthropicreviewbot
	// reviewing PR #67 (PRRT_kwDOSM5cU86Z_qoy / _qpF).
	if (
		legacyStartIdx !== -1 &&
		legacyEndIdx !== -1 &&
		legacyStartIdx < legacyEndIdx
	) {
		body = (
			body.slice(0, legacyStartIdx) +
			body.slice(legacyEndIdx + LEGACY_PR_SECTION_END.length)
		).trim();
	}

	const { start, end } = prSectionMarkers(provider);
	const startIdx = body.indexOf(start);
	const endIdx = body.indexOf(end);

	if (startIdx !== -1 && endIdx !== -1) {
		return body.slice(0, startIdx) + section + body.slice(endIdx + end.length);
	}

	return body ? `${body}\n\n${section}` : section;
}

type PullRequestWebhookPayload = {
	action: string;
	installation?: { id: number };
	number: number;
	pull_request: {
		draft: boolean;
		head: { sha: string };
		additions: number;
		deletions: number;
		changed_files: number;
		title: string;
		body: string | null;
	};
	repository: {
		name: string;
		owner: { login: string };
	};
};

type IssueCommentWebhookPayload = {
	action: string;
	installation?: { id: number };
	issue: {
		number: number;
		pull_request?: { url: string };
	};
	comment: {
		body: string;
		author_association: string;
	};
	repository: {
		name: string;
		owner: { login: string };
	};
};

export type PullRequestDetails = {
	draft: boolean;
	head: { sha: string };
	additions: number;
	deletions: number;
	changed_files: number;
	title: string;
	body: string | null;
	labels?: Array<{ name: string }>;
};

let appSingleton: App | null = null;
let openAIAppSingleton: App | null = null;

let kvSingleton: KvClient | null = null;
function getKv(): KvClient | null {
	if (kvSingleton) return kvSingleton;
	try {
		kvSingleton = createUpstashKv();
		return kvSingleton;
	} catch (err) {
		console.error("feedback: KV unavailable — skipping persistence", err);
		return null;
	}
}

/**
 * The observable outcome of a maybeSubmitReview call, distinguishing an
 * actual GitHub post (a review, or a fallback comment that preserves
 * findings) from every path that produced no review at all. Callers like
 * `watchPr` need this to log accurately and to decide whether a commit was
 * "handled" for retry purposes — almost everything except "posted" should be
 * retried on the next cycle at the same SHA, with one deliberate exception:
 * `{status: "skipped", reason: NO_NEW_REVIEW_REASON}` means the triage gate
 * already decided (and persisted to KV) that this exact SHA needs no review,
 * so it must be treated as handled too — retrying it would re-enter
 * `buildReview` with `lastReviewedSha` already equal to `headSha`, skip the
 * triage gate's guard, and post an unwanted full review. See Bug F.
 *
 * Note: if every retry and the fallback comment all fail, `maybeSubmitReview`
 * throws rather than returning a "posted" outcome — callers must handle both.
 */
export type SubmitReviewOutcome =
	| { status: "posted"; event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE" }
	| { status: "skipped"; reason: string }
	| { status: "rate_limited" }
	| { status: "quota_exhausted" };

/** The one `"skipped"` reason that represents a terminal, already-persisted
 * decision rather than a retryable skip — see `SubmitReviewOutcome`'s doc. */
export const NO_NEW_REVIEW_REASON = "no new review to post";

/** Hard ceiling on pages scanned by {@link hasExistingComment}: scans up to
 * {@link HAS_EXISTING_COMMENT_MAX_PAGES} × {@link HAS_EXISTING_COMMENT_PER_PAGE}
 * = 5,000 comments. In practice the loop exits earlier, as soon as a page
 * returns fewer than per_page items (no more pages) — this cap only exists to
 * bound the loop if GitHub's pagination sentinel misbehaves. Originally 10
 * pages (1,000 comments); codexreviewbot reviewing PR #67 found that on a
 * busy, long-lived watched PR a marker comment could live past page 10, so
 * the cap itself silently defeated the dedup it exists to provide — raised
 * 5x for headroom while still bounding the loop. */
const HAS_EXISTING_COMMENT_MAX_PAGES = 50;
const HAS_EXISTING_COMMENT_PER_PAGE = 100;

/** True when a PR comment with this EXACT body already exists — used to
 * dedupe the quota-exhausted/rate-limited warning comments so `watch`'s
 * indefinite retry loop doesn't repost an identical comment every cycle.
 * Matching the full body (not just the marker) is deliberate: the
 * rate-limited message embeds a reset time that changes between distinct
 * rate-limit windows, and marker-only matching would suppress a genuinely
 * updated warning as a false duplicate, pinning a stale timestamp in the PR
 * — found by codexreviewbot reviewing PR #67. Paginates at `per_page:100`
 * until a page returns fewer than that (no more pages) or a match is found —
 * a single unpaginated page (GitHub's default is only 30) silently missed
 * the match on any busier PR, defeating the dedup exactly on the threads it
 * exists to protect. A malformed or unexpected (non-array) response is
 * treated as "no existing comment" rather than thrown — this is a
 * best-effort dedup check, not a hard dependency of the review itself. */
async function hasExistingComment(
	octokit: Awaited<ReturnType<App["getInstallationOctokit"]>>,
	owner: string,
	repo: string,
	pullNumber: number,
	body: string,
): Promise<boolean> {
	const normalizedBody = body.trimEnd();
	for (let page = 1; page <= HAS_EXISTING_COMMENT_MAX_PAGES; page++) {
		// Only the request itself is best-effort — narrowed from wrapping the
		// whole loop so a bug in the LOCAL scan logic below (not the network
		// call) surfaces instead of being silently downgraded to "no existing
		// comment". Found by codexreviewbot reviewing PR #67
		// (PRRT_kwDOSM5cU86Z_cHu / ikk9l).
		let existing: Awaited<ReturnType<typeof octokit.request>>;
		try {
			existing = await octokit.request(
				"GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
				{
					owner,
					repo,
					issue_number: pullNumber,
					per_page: HAS_EXISTING_COMMENT_PER_PAGE,
					page,
				},
			);
		} catch (err) {
			// A network/Octokit failure here must not block the warning it's
			// gating — this is a best-effort dedup check, not a hard dependency.
			console.error("hasExistingComment: list request failed", err);
			return false;
		}
		const comments = Array.isArray(existing.data)
			? (existing.data as Array<{ body?: string | null }>)
			: [];
		// trimEnd() tolerates trailing-whitespace/newline drift between the
		// locally-constructed body and what GitHub's API echoes back, without
		// reintroducing the marker-substring bug this exact-match replaced —
		// found by anthropicreviewbot reviewing PR #67 (PRRT_kwDOSM5cU86Z_qoq).
		if (comments.some((c) => c.body?.trimEnd() === normalizedBody)) {
			return true;
		}
		if (comments.length < HAS_EXISTING_COMMENT_PER_PAGE) {
			return false;
		}
	}
	return false;
}

/** @internal Exported for unit testing only. */
export async function maybeSubmitReview(args: {
	app: App;
	installationId: number;
	owner: string;
	repo: string;
	pullNumber: number;
	pullRequest: PullRequestDetails;
	extraInstructions: string;
	force: boolean;
	config: AppConfig;
	auth?: ResolvedAuth;
}): Promise<SubmitReviewOutcome> {
	const {
		app,
		installationId,
		owner,
		repo,
		pullNumber,
		pullRequest,
		extraInstructions,
		force,
		config,
		auth,
	} = args;

	if (!config.reviewEnabled) {
		console.log("review skipped: REVIEW_ENABLED is not set to true");
		return { status: "skipped", reason: "REVIEW_ENABLED is not set to true" };
	}

	if (pullRequest.draft) {
		console.log("review skipped: pull request is a draft");
		return { status: "skipped", reason: "pull request is a draft" };
	}

	const headSha = pullRequest.head.sha;
	const octokit = await app.getInstallationOctokit(installationId);

	// Idempotency claim: take an atomic lock on this commit BEFORE running the
	// (expensive) agents, so a duplicate, concurrent, or redelivered invocation
	// can't run a second review and double-bill. Skipped when force=true (explicit
	// re-review) and when KV is not configured — in which case we fall back to the
	// marker check inside buildReview.
	// headSha is the only claim-key component sourced loosely from the webhook
	// payload; owner/repo are GitHub-validated names and provider is an internal
	// enum. Redis keys are opaque binary-safe strings (no injection surface), but
	// validate the SHA as defense-in-depth so a malformed value can't produce an
	// odd or colliding claim key — fall back to the marker check if it fails.
	const validSha = /^[0-9a-f]{7,40}$/.test(headSha);
	if (!validSha) {
		console.warn("idempotency claim skipped: headSha is not a valid git SHA", {
			headSha,
		});
	}
	// Two distinct uses of KV, decoupled on purpose:
	//  - claimKv: the per-commit idempotency claim. Force-gated (a manual
	//    /ai-review intentionally bypasses the claim) and SHA-gated.
	//  - stateKv: review-state persistence + the triage gate. Unconditional when
	//    KV is configured, so a forced review still persists fresh state (the gate
	//    itself is force-gated inside buildReview, so force still runs FULL). If
	//    these shared one var, a forced review would write no state and the next
	//    synchronize would triage against a stale snapshot (I1).
	const stateKv = getKv();
	const claimKv = force || !validSha ? null : stateKv;
	const claimKey = `review-claim:${config.provider}:${owner}/${repo}#${pullNumber}@${headSha}`;
	let claimed = false;
	if (claimKv) {
		try {
			claimed = await claimKv.setNx(
				claimKey,
				new Date().toISOString(),
				REVIEW_CLAIM_TTL_SECONDS,
			);
			if (!claimed) {
				console.log("review skipped: commit already claimed by another run", {
					owner,
					repo,
					pullNumber,
					headSha,
				});
				return {
					status: "skipped",
					reason: "commit already claimed by another run",
				};
			}
		} catch (claimErr) {
			// A KV blip must not block reviews — fall back to the marker check.
			console.error(
				"idempotency claim failed — proceeding without lock",
				claimErr,
			);
		}
	}

	// Releases the idempotency claim. Called from the finally below on every path
	// that does NOT post a review — a skip, a rate-limit, an invalid event, or ANY
	// thrown error (e.g. buildReview failing) — so a transient failure can't lock
	// this commit out of re-review until the TTL expires. No-op when we never held
	// the claim (KV absent, force=true, or setNx threw).
	const releaseClaim = async () => {
		if (claimKv && claimed) {
			await claimKv.del(claimKey).catch((delErr) => {
				// Non-fatal — the claim still auto-expires via TTL — but log it so a
				// stuck claim from a KV outage is diagnosable rather than silent.
				console.error("failed to release review claim", { claimKey, delErr });
			});
		}
	};

	// Everything below runs while holding the claim. On a successful post we keep
	// the claim (reviewPosted) and let it expire via TTL; the posted "Reviewed
	// commit:" marker then becomes the durable dedup.
	let reviewPosted = false;
	let review: Awaited<ReturnType<typeof buildReview>> | null = null;
	try {
		review = await buildReview({
			octokit,
			owner,
			repo,
			pullNumber,
			headSha,
			title: pullRequest.title,
			body: pullRequest.body,
			additions: pullRequest.additions,
			deletions: pullRequest.deletions,
			changedFiles: pullRequest.changed_files,
			labels: pullRequest.labels?.map((l) => l.name) ?? [],
			commentPrefix: config.reviewCommentPrefix,
			extraInstructions,
			force,
			provider: config.provider,
			feedbackEnabled: config.feedbackEnabled,
			agentConcurrency: config.agentConcurrency,
			agentBudgetMs: config.agentBudgetMs,
			tier2Enabled: config.tier2Enabled,
			// Unconditional KV (not the force-gated claim client) for review-state
			// persistence + the triage gate. Null only when KV is unconfigured. A
			// forced review still persists fresh state here; buildReview force-gates
			// the gate itself so force runs a FULL review but doesn't go stale (I1).
			kv: stateKv,
			auth,
		});

		if (!review) {
			return { status: "skipped", reason: NO_NEW_REVIEW_REASON };
		}

		if (review.event === "QUOTA_EXHAUSTED") {
			const quotaProvider = review.quotaProvider ?? "unknown";
			const billing = billingUrl(quotaProvider);
			// Fixed: the marker was previously keyed off `review.quotaProvider`,
			// which falls back to "unknown" when unset — a mismatch against any
			// marker already stored under `config.provider` that silently defeated
			// the dedup this PR exists to add. Always key off `config.provider` so
			// the lookup and the stored marker agree; quotaProvider is still used
			// for the human-readable message and billing link below. Reworded per
			// anthropicreviewbot reviewing PR #67 (PRRT_kwDOSM5cU86Z-uZS).
			const marker = quotaCommentMarker(config.provider);
			const body = [
				marker,
				`⛔ **[${config.reviewCommentPrefix}]** Review couldn't run — **the ${providerLabel(quotaProvider)} account is out of credits.**`,
				"",
				"This will **not** clear on its own and pushing again will not help — it needs payment.",
				"",
				billing
					? `→ ${billing}`
					: "→ Check that provider's billing page — no link is configured for it.",
				"",
				"The review will run normally on the next commit once the balance is topped up.",
			].join("\n");
			if (await hasExistingComment(octokit, owner, repo, pullNumber, body)) {
				console.log("quota-exhausted comment already posted; not duplicating", {
					owner,
					repo,
					pullNumber,
				});
			} else {
				await octokit.request(
					"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
					{ owner, repo, issue_number: pullNumber, body },
				);
			}
			console.error("PROVIDER BALANCE EXHAUSTED — payment required", {
				provider: quotaProvider,
				owner,
				repo,
				pullNumber,
				billing,
			});
			await notifyQuotaExhausted({
				octokit: octokit as never,
				provider: quotaProvider,
				owner,
				repo,
				pullNumber,
				// Deliberately unset: `owner` is the org slug on an org-owned repo,
				// not a user login, and the issues API 422s on that — which would
				// lose the notification entirely. An unassigned issue still emails
				// watchers, so the notification survives either way.
			});
			return { status: "quota_exhausted" };
		}

		if (review.event === "RATE_LIMITED") {
			const when = review.rateLimitResetAt
				? `resets at ${review.rateLimitResetAt}`
				: review.rateLimitRetryAfterSeconds
					? `retry in ~${review.rateLimitRetryAfterSeconds}s`
					: "will reset shortly";
			const marker = rateLimitCommentMarker(config.provider);
			const body = `${marker}\n⚠️ **[${config.reviewCommentPrefix}]** Review couldn't run — the model is rate-limited (input-token budget). Budget ${when}. Push again after that, or it will auto-retry on your next commit.`;
			// A throw here propagates to the outer finally, which releases the
			// claim. Intended: a rate-limited run spent no model budget, so the
			// commit must stay eligible for retry on the next delivery.
			if (await hasExistingComment(octokit, owner, repo, pullNumber, body)) {
				console.log("rate-limit comment already posted; not duplicating", {
					owner,
					repo,
					pullNumber,
				});
			} else {
				await octokit.request(
					"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
					{
						owner,
						repo,
						issue_number: pullNumber,
						body,
					},
				);
				console.log("posted rate-limit fallback comment", {
					owner,
					repo,
					pullNumber,
					when,
				});
			}
			return { status: "rate_limited" };
		}

		if (
			review.event !== "COMMENT" &&
			review.event !== "REQUEST_CHANGES" &&
			review.event !== "APPROVE"
		) {
			console.error(
				"unexpected review event, skipping review POST",
				review.event,
			);
			return {
				status: "skipped",
				reason: `unexpected review event: ${review.event}`,
			};
		}

		console.log("submitting review", {
			owner,
			repo,
			pullNumber,
			event: review.event,
			inlineComments: review.comments.length,
		});

		try {
			const reviewId = await postReviewWithRetry(octokit, {
				owner,
				repo,
				pullNumber,
				commitId: headSha,
				event: review.event,
				body: review.body,
				comments: review.comments,
			});
			// Review is live on GitHub — keep the claim so a duplicate delivery
			// can't post again; it expires via TTL and the marker takes over.
			reviewPosted = true;

			const summarySection = buildPRSummarySection(
				review.metadata,
				review.event,
				config.reviewCommentPrefix,
				config.provider,
			);
			const updatedBody = injectPRSection(
				pullRequest.body,
				summarySection,
				config.provider,
			);
			try {
				await octokit.request(
					"PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
					{
						owner,
						repo,
						pull_number: pullNumber,
						body: updatedBody,
					},
				);
			} catch (patchErr) {
				console.error("failed to update PR description", patchErr);
			}

			try {
				await createCheckRun(
					octokit,
					owner,
					repo,
					headSha,
					review,
					config.reviewCommentPrefix,
				);
			} catch (checkErr) {
				console.error("failed to create check run", checkErr);
			}

			try {
				await resolveStaleThreads(
					octokit,
					owner,
					repo,
					pullNumber,
					config.reviewCommentPrefix,
					review.validLinesByPath,
				);
			} catch (resolveErr) {
				console.error("failed to resolve stale threads", resolveErr);
			}

			if (
				config.feedbackEnabled &&
				review.comments.length > 0 &&
				review.commentProvenance &&
				review.commentProvenance.size > 0
			) {
				try {
					const fbKv = getKv();
					if (fbKv) {
						const stored = await persistPostedComments({
							kv: fbKv,
							octokit,
							owner,
							repo,
							pr: pullNumber,
							reviewId,
							headSha,
							installationId,
							provider: config.provider,
							provenance: review.commentProvenance,
							nowMs: Date.now(),
						});
						console.log("feedback: recorded posted comments", {
							owner,
							repo,
							pullNumber,
							stored,
						});
					}
					// Corpus capture is independent of the KV buffer: it writes the
					// join target (finding_catalog) that feedback is later matched
					// against, and posts the carrier comment that makes the
					// top-level verdict ratable at all — reviews themselves are
					// not reactable. Failing here must not fail a review that is
					// already published, so it is caught separately from the KV
					// path rather than sharing its catch.
					if (config.improveEnabled) {
						try {
							const captured = await capturePostedReview({
								db: getDb(),
								octokit: octokit as never,
								owner,
								repo,
								pr: pullNumber,
								reviewId,
								headSha,
								provider: config.provider,
								provenance: review.commentProvenance,
								summary: review.summary,
								commentPrefix: config.reviewCommentPrefix,
								postCarrier: config.improveCarrierEnabled,
								// Register the carrier for reaction polling; without
								// this it invites ratings that nothing ever reads.
								onCarrier: async (commentId) => {
									const carrierKv = getKv();
									if (!carrierKv) return;
									const now = Date.now();
									await recordPostedComment(
										carrierKv,
										{
											commentId,
											surface: "carrier",
											provider: config.provider,
											installationId,
											owner,
											repo,
											pr: pullNumber,
											headSha,
											path: "",
											line: 0,
											skills: [],
											title: "review summary",
											body: "",
											postedAtMs: now,
											expiresAtMs: now + 14 * 24 * 60 * 60 * 1000,
											lastSeenReactions: {},
										},
										now,
									);
								},
							});
							console.log("improve: captured posted review", {
								owner,
								repo,
								pullNumber,
								...captured,
							});
						} catch (captureErr) {
							console.error("improve: corpus capture failed", {
								owner,
								repo,
								pullNumber,
								error:
									captureErr instanceof Error
										? `${captureErr.name}: ${captureErr.message}`
										: String(captureErr),
							});
						}
					}
				} catch (feedbackErr) {
					// Drop the cached client so a transient failure (network blip, expired
					// token) doesn't poison the warm instance — the next review rebuilds it.
					kvSingleton = null;
					console.error(
						"feedback: failed to record posted comments",
						feedbackErr,
					);
				}
			}
		} catch (err) {
			console.error(
				"review POST failed after all retries — posting fallback comment",
				{
					owner,
					repo,
					pullNumber,
					err,
				},
			);
			const fallbackBody = buildFallbackCommentBody(
				review,
				err,
				config.reviewCommentPrefix,
			);
			try {
				await octokit.request(
					"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
					{
						owner,
						repo,
						issue_number: pullNumber,
						body: fallbackBody,
					},
				);
				console.log("fallback comment posted — review findings preserved");
				// The findings were delivered (as a comment) and the model budget was
				// already spent. Treat this as a posted review: keep the claim so a
				// redelivery or re-trigger of this same commit can't re-run the agents
				// and double-bill. A new commit gets a fresh claim key and re-reviews.
				reviewPosted = true;
			} catch (commentErr) {
				// Nothing was delivered. Rethrow so the finally releases the claim and
				// the commit stays eligible for a retry — and so the invocation is
				// marked failed for observability.
				console.error("failed to post fallback comment", commentErr);
				throw err;
			}
		}

		// Either the review POST succeeded, or it failed but the fallback comment
		// preserved the findings (reviewPosted is true in both cases) — both are a
		// real post to GitHub from the caller's perspective.
		return { status: "posted", event: review.event };
	} catch (err) {
		// hs1: buildReview throws when EVERY agent fails (e.g. an invalid provider
		// API key or an exhausted usage limit — see review.ts "All review agents
		// failed"). GitHub already returned 202 for the webhook, so without surfacing
		// this the run vanishes with zero signal on the PR — the silent failure that
		// hid a multi-day provider outage. Post a best-effort comment when NO review
		// was produced; the finally still releases the claim so the next push retries.
		// A POST-path failure (review already built) was surfaced by the inner
		// fallback above, so skip it here to avoid a double comment.
		if (!review) {
			console.error("buildReview failed — surfacing the failure on the PR", {
				owner,
				repo,
				pullNumber,
				err,
			});
			await octokit
				.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
					owner,
					repo,
					issue_number: pullNumber,
					body: `⚠️ **[${config.reviewCommentPrefix}]** Review couldn't complete — an internal or model-provider error occurred (for example an API key or usage-limit problem). It will retry on your next commit; maintainers can check the function logs.`,
				})
				.catch((commentErr) =>
					console.error("failed to post build-failure comment", commentErr),
				);
		}
		throw err;
	} finally {
		// Single release point for every non-posting exit from the try above:
		// a buildReview throw, the !review / RATE_LIMITED / unexpected-event
		// returns, and a throw from either fallback-comment POST. reviewPosted is
		// set true only once a review (or a findings-preserving fallback comment)
		// is live on GitHub, so this never releases a claim that produced output.
		if (!reviewPosted) await releaseClaim();
	}
}

// Runs a review that was scheduled via QStash. Fetches the PR once, then
// COALESCES concurrent pushes with a head-SHA staleness check: if the PR head
// has moved past the SHA this message was published for, a newer push already
// owns the review, so this one no-ops ("superseded"). deduplicationId can NOT
// cancel an already-scheduled older-SHA message — this check is the coalescing.
export async function runScheduledReview(
	message: ReviewRunMessage,
	app: App,
	config: AppConfig,
): Promise<{ status: "reviewed" | "superseded" | "waiting" }> {
	const { owner, repo, pullNumber, headSha, installationId } = message;
	const octokit = await app.getInstallationOctokit(installationId);
	const pullResponse = await octokit.request(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}",
		{ owner, repo, pull_number: pullNumber },
	);
	const pullRequest = pullResponse.data as PullRequestDetails;
	if (pullRequest.head.sha !== headSha) {
		console.log("skip scheduled review: head moved (superseded)", {
			owner,
			repo,
			pullNumber,
			scheduledSha: headSha,
			currentSha: pullRequest.head.sha,
		});
		return { status: "superseded" };
	}

	// The delay exists so peer bots post first and we can dedupe against them.
	// That condition is directly observable, so observe it rather than
	// approximating it with a fixed timer — a peer that never arrives used to
	// starve the review entirely, and a repo with no peer bots waited for
	// nothing at all.
	const attempt = (message.attempt ?? 0) + 1;
	let reviews: Awaited<ReturnType<typeof fetchPrReviews>>;
	let peerFetchFailed = false;
	try {
		reviews = await fetchPrReviews(
			octokit as unknown as PeerOctokit,
			owner,
			repo,
			pullNumber,
		);
	} catch (err) {
		reviews = [];
		peerFetchFailed = true;
		console.error("peers: failed to fetch PR reviews; skipping peer gate", {
			owner,
			repo,
			pullNumber,
			error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		});
	}
	const peers = summarizePeers(reviews, headSha);
	const decision = peerFetchFailed
		? { run: true as const, reason: "peer-fetch-failed" as const }
		: shouldRunNow({
				status: peers,
				peersExpectedInRepo:
					peers.seenOnPr.length > 0 ||
					(await peersExpectedInRepo(
						octokit as unknown as PeerOctokit,
						owner,
						repo,
					)),
				attempt,
				maxAttempts: config.peerMaxAttempts,
			});

	if (!decision.run) {
		const next = await scheduleReview(
			config,
			{ ...message, attempt },
			config.peerCheckIntervalMs / 1000,
		);
		console.log("review waiting on peers", {
			owner,
			repo,
			pullNumber,
			attempt,
			maxAttempts: config.peerMaxAttempts,
			arrived: peers.arrived,
			awaiting: peers.seenOnPr.filter((p) => !peers.arrived.includes(p)),
			rescheduled: next !== null,
		});
		// A failed re-publish must not silently drop the review: fall through and
		// review now rather than wait for a callback that will never come.
		if (next !== null) return { status: "waiting" };
	} else {
		console.log("review proceeding", {
			owner,
			repo,
			pullNumber,
			attempt,
			reason: decision.reason,
			arrived: peers.arrived,
		});
	}

	await maybeSubmitReview({
		app,
		installationId,
		owner,
		repo,
		pullNumber,
		pullRequest,
		extraInstructions: "",
		force: false,
		config,
	});
	return { status: "reviewed" };
}

function registerHandlers(app: App, configFn: () => AppConfig) {
	app.webhooks.on(
		[
			"pull_request.opened",
			"pull_request.reopened",
			"pull_request.synchronize",
			"pull_request.ready_for_review",
		],
		async ({ payload }) => {
			const prPayload = payload as PullRequestWebhookPayload;

			const installationId = prPayload.installation?.id;
			if (!installationId) {
				throw new Error("Webhook payload did not include an installation id");
			}

			const config = configFn();
			const owner = prPayload.repository.owner.login;
			const repo = prPayload.repository.name;
			const pullNumber = prPayload.number;
			const delayMs = selectReviewDelayMs(prPayload.action, config);

			// Publish a delayed review-run callback to QStash and return immediately
			// — don't burn the function's maxDuration budget sleeping in-process.
			// The /api/github/review-run endpoint invokes runScheduledReview after
			// the delay.
			const message: ReviewRunMessage = {
				provider: config.provider,
				owner,
				repo,
				pullNumber,
				headSha: prPayload.pull_request.head.sha,
				action: prPayload.action,
				installationId,
			};
			const scheduled = await scheduleReview(config, message, delayMs / 1000);
			if (scheduled) {
				console.log("scheduled review via QStash", {
					messageId: scheduled.messageId,
					owner,
					repo,
					pullNumber,
					delaySeconds: delayMs / 1000,
				});
				return;
			}

			// QStash unconfigured → fall back to today's inline behavior so a review
			// is never dropped.
			if (delayMs > 0) {
				console.log(`delaying review by ${delayMs / 1000}s (inline fallback)`, {
					owner,
					repo,
					pullNumber,
					action: prPayload.action,
				});
				await sleep(delayMs);
			}
			await maybeSubmitReview({
				app,
				installationId,
				owner,
				repo,
				pullNumber,
				pullRequest: prPayload.pull_request,
				extraInstructions: "",
				force: false,
				config,
			});
		},
	);

	app.webhooks.on("issue_comment.created", async ({ payload }) => {
		const config = configFn();
		const commentPayload = payload as IssueCommentWebhookPayload;

		console.log("issue_comment.created received", {
			association: commentPayload.comment.author_association,
			isPR: !!commentPayload.issue.pull_request,
			body: commentPayload.comment.body.slice(0, 100),
			reviewEnabled: config.reviewEnabled,
			reviewCommand: config.reviewCommand,
		});

		if (!commentPayload.issue.pull_request) {
			console.log("skip: not a PR comment");
			return;
		}

		if (
			!isTrustedAuthorAssociation(commentPayload.comment.author_association)
		) {
			console.log(
				"skip: untrusted association",
				commentPayload.comment.author_association,
			);
			return;
		}

		const command = parseReviewCommand(
			commentPayload.comment.body,
			config.reviewCommand,
		);
		if (!command) {
			console.log("skip: command not matched", {
				body: commentPayload.comment.body,
				reviewCommand: config.reviewCommand,
			});
			return;
		}

		console.log("command matched, proceeding with review", command);

		const installationId = commentPayload.installation?.id;
		if (!installationId) {
			throw new Error("Webhook payload did not include an installation id");
		}

		const owner = commentPayload.repository.owner.login;
		const repo = commentPayload.repository.name;
		const pullNumber = commentPayload.issue.number;
		const octokit = await app.getInstallationOctokit(installationId);
		const pullResponse = await octokit.request(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}",
			{
				owner,
				repo,
				pull_number: pullNumber,
			},
		);

		await maybeSubmitReview({
			app,
			installationId,
			owner,
			repo,
			pullNumber,
			pullRequest: pullResponse.data as PullRequestDetails,
			extraInstructions: command.extraInstructions,
			force: command.force,
			config,
		});
	});

	app.webhooks.onError((error) => {
		console.error("GitHub App webhook error", error);
	});
}

export function getGitHubApp(): App {
	if (appSingleton) {
		return appSingleton;
	}

	const config = getConfig();
	appSingleton = new App({
		appId: config.appId,
		privateKey: config.privateKey,
		webhooks: {
			secret: config.webhookSecret,
		},
	});

	registerHandlers(appSingleton, getConfig);
	return appSingleton;
}

export function getOpenAIGitHubApp(): App {
	if (openAIAppSingleton) {
		return openAIAppSingleton;
	}

	const config = getOpenAIAppConfig();
	openAIAppSingleton = new App({
		appId: config.appId,
		privateKey: config.privateKey,
		webhooks: {
			secret: config.webhookSecret,
		},
	});

	registerHandlers(openAIAppSingleton, getOpenAIAppConfig);
	return openAIAppSingleton;
}
