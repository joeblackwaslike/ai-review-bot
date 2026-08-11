import { App } from "octokit";

/** Build an Octokit authenticated as one GitHub App's installation on a repo.
 * Shared by the CLI (`ai-review propose`/`ready`/`backfill`), the weekly cron
 * (`api/cron/improve.ts`), and the dashboard's "open issue from metric" action. */
export async function installationOctokit(
	appId: string,
	privateKey: string,
	owner: string,
	repo: string,
) {
	const app = new App({
		appId,
		privateKey: privateKey.replaceAll(String.raw`\n`, "\n"),
	});
	const { data: inst } = await app.octokit.request(
		"GET /repos/{owner}/{repo}/installation",
		{ owner, repo },
	);
	return app.getInstallationOctokit(inst.id);
}
