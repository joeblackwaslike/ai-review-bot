import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getEffectiveConfig } from "../../src/config/edge.js";
import type { AppConfig } from "../../src/config.js";
import {
	getReviewerGitHubApp,
	runScheduledReview,
} from "../../src/github-app.js";
import { readRawBody } from "../../src/http.js";
import {
	getLiveReviewerAppConfig,
	listReviewerIds,
	logReviewerReadiness,
	reviewerReadiness,
} from "../../src/reviewers.js";
import type { ReviewRunMessage } from "../../src/scheduler.js";
import {
	reviewerOfMessage,
	verifyQStashSignature,
} from "../../src/scheduler.js";

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

	logReviewerReadiness();

	const signature = req.headers["upstash-signature"];
	if (typeof signature !== "string") {
		res.status(400).json({ error: "Missing Upstash-Signature header" });
		return;
	}

	const rawBody = (await readRawBody(req)).toString("utf8");

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		res.status(400).json({ error: "Invalid JSON body" });
		return;
	}

	const message =
		typeof parsed === "object" && parsed !== null
			? (parsed as ReviewRunMessage)
			: undefined;
	const reviewerId = message ? reviewerOfMessage(message) : null;
	if (!message || reviewerId === null) {
		res.status(400).json({ error: "Invalid or missing reviewer" });
		return;
	}

	if (!listReviewerIds().includes(reviewerId)) {
		res.status(404).json({ error: "Unknown reviewer" });
		return;
	}
	const readiness = reviewerReadiness(
		reviewerId,
		"hosted",
		process.env,
		(await getEffectiveConfig()).config,
	);
	if (!readiness.ready) {
		console.warn("Reviewer not ready", {
			reviewer: reviewerId,
			missing: readiness.missing,
		});
		res.status(503).json({ error: "Reviewer unavailable" });
		return;
	}

	let config: AppConfig;
	try {
		config = await getLiveReviewerAppConfig(reviewerId);
	} catch (error) {
		console.error("Reviewer config unavailable", {
			reviewer: reviewerId,
			message: error instanceof Error ? error.message : "unknown error",
		});
		res.status(503).json({ error: "Reviewer unavailable" });
		return;
	}

	const verified = await verifyQStashSignature(config, rawBody, signature);
	if (!verified) {
		res.status(401).json({ error: "Invalid QStash signature" });
		return;
	}

	let app: ReturnType<typeof getReviewerGitHubApp>;
	try {
		app = getReviewerGitHubApp(reviewerId);
	} catch (error) {
		console.error("Reviewer app unavailable", {
			reviewer: reviewerId,
			message: error instanceof Error ? error.message : "unknown error",
		});
		res.status(503).json({ error: "Reviewer unavailable" });
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
			reviewer: reviewerId,
			owner: message.owner,
			repo: message.repo,
			pullNumber: message.pullNumber,
			error,
		});
		res.status(500).json({ error: "Scheduled review run failed" });
	}
}
