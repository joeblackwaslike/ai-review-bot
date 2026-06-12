import type { VercelRequest, VercelResponse } from "@vercel/node";
import { pollFeedbackRequest } from "../../src/feedback/cron.js";
import { createUpstashKv } from "../../src/feedback/kv.js";
import type { OctokitLike } from "../../src/feedback/reactions.js";
import type { Provider } from "../../src/feedback/types.js";
import { getGitHubApp, getOpenAIGitHubApp } from "../../src/github-app.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
	const { status, body } = await pollFeedbackRequest({
		authorization: req.headers.authorization,
		secret: process.env.CRON_SECRET,
		feedbackEnabled: process.env.FEEDBACK_ENABLED === "true",
		buildDeps: () => ({
			kv: createUpstashKv(),
			getOctokit: async (
				provider: Provider,
				installationId: number,
			): Promise<OctokitLike> => {
				const app =
					provider === "anthropic" ? getGitHubApp() : getOpenAIGitHubApp();
				return (await app.getInstallationOctokit(
					installationId,
				)) as unknown as OctokitLike;
			},
			nowMs: Date.now(),
		}),
	});
	console.log("feedback poll request", { status, body });
	res.status(status).json(body);
}
