import { App } from "octokit";
import { isTrustedAuthorAssociation, parseReviewCommand } from "./commands.js";
import type { AppConfig } from "./config.js";
import { getConfig, getOpenAIAppConfig } from "./config.js";
import { resolveStaleThreads } from "./resolve-threads.js";
import type { ReviewDecision, ReviewMetadata } from "./review.js";
import { buildReview } from "./review.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
): Promise<void> {
	const delays = [3000, 6000];
	let lastError: unknown;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			await octokit.request(
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
			return;
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
	event: ReviewDecision["event"],
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
	});

	if (!review) {
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
		await postReviewWithRetry(octokit, {
			owner,
			repo,
			pullNumber,
			commitId: headSha,
			event: review.event,
			body: review.body,
			comments: review.comments,
		});

		const summarySection = buildPRSummarySection(
			review.metadata,
			review.event,
			config.reviewCommentPrefix,
		);
		const updatedBody = injectPRSection(pullRequest.body, summarySection);
		try {
			await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
				owner,
				repo,
				pull_number: pullNumber,
				body: updatedBody,
			});
		} catch (patchErr) {
			console.error("failed to update PR description", patchErr);
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
		} catch (commentErr) {
			console.error("failed to post fallback comment", commentErr);
		}
		throw err;
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
			if (config.reviewDelayMs > 0) {
				console.log(`delaying review by ${config.reviewDelayMs / 1000}s`, {
					owner,
					repo,
					pullNumber,
				});
				await new Promise((resolve) =>
					setTimeout(resolve, config.reviewDelayMs),
				);
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
