import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getConfig, getOpenAIAppConfig } from "../../src/config.js";
import {
	getGitHubApp,
	getOpenAIGitHubApp,
	runScheduledReview,
} from "../../src/github-app.js";
import { readRawBody } from "../../src/http.js";
import type { ReviewRunMessage } from "../../src/scheduler.js";
import { verifyQStashSignature } from "../../src/scheduler.js";

// QStash delayed-callback endpoint. The pull_request webhook publishes a
// ReviewRunMessage here with a delay; QStash invokes this after the delay so the
// wait costs zero function time and the review runs with the full maxDuration
// budget. We verify the Upstash signature before any side effect, then hand off
// to runScheduledReview (which coalesces stale pushes via a head-SHA check).
export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		res.status(405).json({ error: "Method not allowed" });
		return;
	}

	const signature = req.headers["upstash-signature"];
	if (typeof signature !== "string") {
		res.status(400).json({ error: "Missing Upstash-Signature header" });
		return;
	}

	const rawBody = (await readRawBody(req)).toString("utf8");

	// Parse before verifying ONLY to select the right provider's signing keys.
	// Verification gates every side effect below — an unverified body is inert.
	let message: ReviewRunMessage;
	try {
		message = JSON.parse(rawBody) as ReviewRunMessage;
	} catch {
		res.status(400).json({ error: "Invalid JSON body" });
		return;
	}

	const isOpenAI = message.provider === "openai";
	const config = isOpenAI ? getOpenAIAppConfig() : getConfig();
	const app = isOpenAI ? getOpenAIGitHubApp() : getGitHubApp();

	const verified = await verifyQStashSignature(config, rawBody, signature);
	if (!verified) {
		res.status(401).json({ error: "Invalid QStash signature" });
		return;
	}

	try {
		// Awaited directly (not waitUntil): we WANT the function to stay alive for
		// the full review (up to maxDuration) and respond only after it finishes.
		const result = await runScheduledReview(message, app, config);
		res.status(200).json({ ok: true, status: result.status });
	} catch (error) {
		// Non-2xx makes QStash retry, which is the desired resilience.
		console.error("Scheduled review run failed", {
			provider: message.provider,
			owner: message.owner,
			repo: message.repo,
			pullNumber: message.pullNumber,
			error,
		});
		res.status(500).json({ error: "Scheduled review run failed" });
	}
}
