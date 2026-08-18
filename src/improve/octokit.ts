import { App } from "octokit";

/** Build an App instance plus its resolved installation id for one GitHub App
 * on a repo. Base for installationOctokit() below and for any caller (e.g.
 * `ai-review watch`) that needs the App object itself rather than a
 * ready-made Octokit — maybeSubmitReview() takes {app, installationId}
 * directly, not an Octokit. */
export async function installationApp(
	appId: string,
	privateKey: string,
	owner: string,
	repo: string,
): Promise<{ app: App; installationId: number }> {
	const app = new App({
		appId,
		privateKey: privateKey.replaceAll(String.raw`\n`, "\n"),
	});
	const { data: inst } = await app.octokit.request(
		"GET /repos/{owner}/{repo}/installation",
		{ owner, repo },
	);
	return { app, installationId: inst.id };
}

/** Build an Octokit authenticated as one GitHub App's installation on a repo.
 * Shared by the CLI (`ai-review propose`/`ready`/`backfill`), the
 * weekly cron (`api/cron/improve.ts`), and the dashboard's "open issue from
 * metric" action. */
export async function installationOctokit(
	appId: string,
	privateKey: string,
	owner: string,
	repo: string,
) {
	const { app, installationId } = await installationApp(
		appId,
		privateKey,
		owner,
		repo,
	);
	return app.getInstallationOctokit(installationId);
}
