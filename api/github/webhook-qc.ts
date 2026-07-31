import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readRawBody } from "../../src/http.js";
import { getQcApp } from "../../src/qc-app.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		res.status(405).json({ error: "Method not allowed" });
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

	const body = await readRawBody(req);
	const payload = body.toString("utf8");

	// Verify before acknowledging so a forged request is never acked. The QC app
	// has its own secret, so this must use its own App instance — verifying
	// against the review app's secret would reject every genuine delivery.
	const app = getQcApp();
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
				console.error("QC webhook processing failed", {
					deliveryId,
					eventName,
					error,
				});
			}),
	);
}
