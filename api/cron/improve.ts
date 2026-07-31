import type { VercelRequest, VercelResponse } from "@vercel/node";
import { App } from "octokit";
import { getConfig } from "../../src/config.js";
import type { KvClient } from "../../src/feedback/kv.js";
import { createUpstashKv } from "../../src/feedback/kv.js";
import { improveRequest } from "../../src/improve/cron.js";
import { getDb } from "../../src/improve/db/client.js";
import type { IssueOctokit } from "../../src/improve/issues.js";
import { thresholdsFromEnv } from "../../src/improve/issues.js";
import { runImproveCycle } from "../../src/improve/run.js";

function optionalKv(): KvClient | null {
	try {
		return createUpstashKv();
	} catch {
		// KV is only the reaction buffer; the corpus is the source of truth, so a
		// cycle without it still classifies and proposes from what is already
		// captured.
		return null;
	}
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
	const { status, body } = await improveRequest({
		authorization: req.headers.authorization,
		secret: process.env.CRON_SECRET,
		improveEnabled: process.env.IMPROVE_ENABLED === "true",
		run: async () => {
			const slug =
				process.env.IMPROVE_TARGET_REPO ?? "joeblackwaslike/ai-review-bot";
			const [owner, repo] = slug.split("/");
			const config = getConfig();
			const app = new App({
				appId: config.appId,
				privateKey: config.privateKey.replaceAll(String.raw`\n`, "\n"),
			});
			const { data: inst } = await app.octokit.request(
				"GET /repos/{owner}/{repo}/installation",
				{ owner, repo },
			);
			const octokit = (await app.getInstallationOctokit(
				inst.id,
			)) as unknown as IssueOctokit;

			return runImproveCycle({
				db: getDb(),
				kv: optionalKv(),
				octokit,
				owner,
				repo,
				selection: { provider: "anthropic", model: "claude-haiku-4-5" },
				thresholds: thresholdsFromEnv(process.env),
			});
		},
	});
	console.log("improve cron request", { status, body });
	res.status(status).json(body);
}
