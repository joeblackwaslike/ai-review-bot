import { App } from "octokit";
import { isTrustedAuthorAssociation, parseReviewCommand } from "./commands.js";
import type { AppConfig } from "./config.js";
import { getConfig, getOpenAIAppConfig } from "./config.js";
import { buildReview } from "./review.js";

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
		await octokit.request(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{
				owner,
				repo,
				pull_number: pullNumber,
				commit_id: headSha,
				event: review.event,
				body: review.body,
				comments: review.comments,
			},
		);
	} catch (err) {
		if (review.comments.length === 0) {
			throw err;
		}
		console.error(
			"review POST with inline comments failed, retrying without comments",
			err,
		);
		await octokit.request(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{
				owner,
				repo,
				pull_number: pullNumber,
				commit_id: headSha,
				event: review.event,
				body: review.body,
				comments: [],
			},
		);
	}
}

function registerHandlers(app: App, configFn: () => AppConfig) {
	app.webhooks.on(
		[
			"pull_request.opened",
			"pull_request.reopened",
			"pull_request.synchronize",
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
