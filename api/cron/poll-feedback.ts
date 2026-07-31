import type { VercelRequest, VercelResponse } from "@vercel/node";
import { pollFeedbackRequest } from "../../src/feedback/cron.js";
import { createUpstashKv } from "../../src/feedback/kv.js";
import type { OctokitLike } from "../../src/feedback/reactions.js";
import type { Provider } from "../../src/feedback/types.js";
import { getGitHubApp, getOpenAIGitHubApp } from "../../src/github-app.js";
import { getDb } from "../../src/improve/db/client.js";
import { drainKvEvents } from "../../src/improve/drain.js";

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

	// Drain the KV buffer into the corpus after the poll, so reactions observed
	// on this pass land in the same run. LLM-free and idempotent, so it stays
	// well inside the 60s budget and a failure costs nothing — the buffer is not
	// consumed, and the next run picks up whatever this one missed.
	if (status === 200 && process.env.IMPROVE_ENABLED === "true") {
		try {
			const drained = await drainKvEvents({
				kv: createUpstashKv(),
				db: getDb(),
			});
			console.log("improve: drained KV events", drained);
		} catch (err) {
			console.error("improve: drain failed", {
				error:
					err instanceof Error ? `${err.name}: ${err.message}` : String(err),
			});
		}
	}

	res.status(status).json(body);
}
