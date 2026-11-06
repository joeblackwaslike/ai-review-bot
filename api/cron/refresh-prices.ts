import { createHash, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { KvClient } from "../../src/feedback/kv.js";
import { createUpstashKv } from "../../src/feedback/kv.js";
import { primePrices } from "../../src/pricing.js";

function isAuthorized(authorization: string | undefined): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret || !authorization) return false;
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}

function optionalKv(): KvClient | null {
	try {
		return createUpstashKv();
	} catch {
		return null;
	}
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (!isAuthorized(req.headers.authorization)) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	const models = await primePrices({ kv: optionalKv(), force: true });
	console.log("price refresh", { models });
	res.status(200).json({ models });
}
