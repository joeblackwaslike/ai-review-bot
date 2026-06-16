import { App } from "octokit";
import { createCheckRun } from "./check-run.js";
import { isTrustedAuthorAssociation, parseReviewCommand } from "./commands.js";
import type { AppConfig } from "./config.js";
import { getConfig, getOpenAIAppConfig } from "./config.js";
import type { KvClient } from "./feedback/kv.js";
import { createUpstashKv } from "./feedback/kv.js";
import { persistPostedComments } from "./feedback/persist.js";
import { resolveStaleThreads } from "./resolve-threads.js";
import type { ReviewDecision, ReviewMetadata } from "./review.js";
import { buildReview } from "./review.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

const PR_SECTION_START = "<!-- ai-review-bot:start -->";
const PR_SECTION_END = "<!-- ai-review-bot:end -->";

export function buildPRSummarySection(
	metadata: ReviewMetadata,
	event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
	commentPrefix: string,
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

	return [
		PR_SECTION_START,
		`#### ${commentPrefix}`,
		"",
		"| | |",
		"|---|---|",
		`| Verdict | ${verdict} |`,
		`| Findings | ${metadata.generalFindings} general, ${metadata.inlineComments} inline |`,
		`| Model | \`${metadata.model}\` |`,
		`| Agents | ${metadata.tier1Count} Tier 1${metadata.tier2Skills.length > 0 ? ` + ${metadata.tier2Skills.length} Tier 2` : ""} |${tier2Line}`,
		`| Cost | $${metadata.cost.toFixed(6)} |`,
		PR_SECTION_END,
	].join("\n");
}

export function injectPRSection(
	existingBody: string | null,
	section: string,
): string {
	const body = existingBody ?? "";
	const startIdx = body.indexOf(PR_SECTION_START);
	const endIdx = body.indexOf(PR_SECTION_END);

	if (startIdx !== -1 && endIdx !== -1) {
		return (
			body.slice(0, startIdx) +
			section +
			body.slice(endIdx + PR_SECTION_END.length)
		);
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

type PullRequestDetails = {
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
}) {
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
	} = args;

	if (!config.reviewEnabled) {
		console.log("review skipped: REVIEW_ENABLED is not set to true");
		return;
	}

	if (pullRequest.draft) {
		console.log("review skipped: pull request is a draft");
		return;
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
	const kv = force || !validSha ? null : getKv();
	const claimKey = `review-claim:${config.provider}:${owner}/${repo}#${pullNumber}@${headSha}`;
	let claimed = false;
	if (kv) {
		try {
			claimed = await kv.setNx(
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
				return;
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
		if (kv && claimed) {
			await kv.del(claimKey).catch((delErr) => {
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
	try {
		const review = await buildReview({
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
		});

		if (!review) {
			return;
		}

		if (review.event === "RATE_LIMITED") {
			const when = review.rateLimitResetAt
				? `resets at ${review.rateLimitResetAt}`
				: review.rateLimitRetryAfterSeconds
					? `retry in ~${review.rateLimitRetryAfterSeconds}s`
					: "will reset shortly";
			const body = `⚠️ **[${config.reviewCommentPrefix}]** Review couldn't run — the model is rate-limited (input-token budget). Budget ${when}. Push again after that, or it will auto-retry on your next commit.`;
			// A throw here propagates to the outer finally, which releases the
			// claim. Intended: a rate-limited run spent no model budget, so the
			// commit must stay eligible for retry on the next delivery.
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
			return;
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
			return;
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
			);
			const updatedBody = injectPRSection(pullRequest.body, summarySection);
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
	} finally {
		// Single release point for every non-posting exit from the try above:
		// a buildReview throw, the !review / RATE_LIMITED / unexpected-event
		// returns, and a throw from either fallback-comment POST. reviewPosted is
		// set true only once a review (or a findings-preserving fallback comment)
		// is live on GitHub, so this never releases a claim that produced output.
		if (!reviewPosted) await releaseClaim();
	}
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
			// Re-reviews after a push (synchronize) use a shorter delay than the
			// initial pass: external bots re-review incrementally in ~1-3 min, while
			// an initial review (CodeRabbit especially) can take up to ~7.5 min. The
			// delay exists so other bots post first and our review can dedupe them.
			const delayMs =
				prPayload.action === "synchronize"
					? config.reviewResyncDelayMs
					: config.reviewDelayMs;
			if (delayMs > 0) {
				console.log(`delaying review by ${delayMs / 1000}s`, {
					owner,
					repo,
					pullNumber,
					action: prPayload.action,
				});
				await new Promise((resolve) => setTimeout(resolve, delayMs));
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
