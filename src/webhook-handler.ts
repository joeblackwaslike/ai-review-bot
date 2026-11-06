import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getReviewerGitHubApp } from "./github-app.js";
import { readRawBody } from "./http.js";
import type { ReviewerId } from "./reviewer-id.js";
import {
	listReviewerIds,
	logReviewerReadiness,
	reviewerReadiness,
} from "./reviewers.js";

const REVIEWER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function resolveReviewerId(
	req: VercelRequest,
	fixedId: ReviewerId | undefined,
): ReviewerId | undefined {
	const id = fixedId ?? req.query?.id;
	if (typeof id !== "string" || !REVIEWER_ID_PATTERN.test(id)) return undefined;
	return listReviewerIds().includes(id) ? id : undefined;
}

export function createReviewerWebhookHandler(fixedId?: ReviewerId) {
	return async function handler(
		req: VercelRequest,
		res: VercelResponse,
	): Promise<void> {
		if (req.method !== "POST") {
			res.setHeader("Allow", "POST");
			res.status(405).json({ error: "Method not allowed" });
			return;
		}

		logReviewerReadiness();

		const id = resolveReviewerId(req, fixedId);
		if (id === undefined) {
			res.status(404).json({ error: "Unknown reviewer" });
			return;
		}

		const readiness = reviewerReadiness(id, "hosted");
		if (!readiness.ready) {
			res.status(503).json({
				error: "Reviewer unavailable",
				missing: readiness.missing,
			});
			return;
		}

		const deliveryId = req.headers["x-github-delivery"];
		const eventName = req.headers["x-github-event"];
		const signature = req.headers["x-hub-signature-256"];

		if (
			typeof deliveryId !== "string" ||
			typeof eventName !== "string" ||
			typeof signature !== "string"
		) {
			res.status(400).json({ error: "Missing required GitHub headers" });
			return;
		}

		let app: ReturnType<typeof getReviewerGitHubApp>;
		try {
			app = getReviewerGitHubApp(id);
		} catch (error) {
			console.error("Reviewer app unavailable", {
				reviewerId: id,
				message: error instanceof Error ? error.message : "unknown error",
			});
			res.status(503).json({ error: "Reviewer unavailable" });
			return;
		}

		const body = await readRawBody(req);
		const payload = body.toString("utf8");

		const valid = await app.webhooks
			.verify(payload, signature)
			.catch(() => false);
		if (!valid) {
			res.status(400).json({ error: "Invalid webhook signature" });
			return;
		}

		res.status(202).json({ ok: true });

		waitUntil(
			app.webhooks
				.verifyAndReceive({
					id: deliveryId,
					name: eventName as never,
					signature,
					payload,
				})
				.catch((error) => {
					console.error("Webhook processing failed", {
						deliveryId,
						eventName,
						error,
					});
				}),
		);
	};
}
