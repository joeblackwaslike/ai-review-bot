import { Client, Receiver } from "@upstash/qstash";
import type { AppConfig } from "./config.js";

export interface ReviewRunMessage {
	provider: "anthropic" | "openai";
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	action: string;
	installationId: number;
}

export function reviewRunCallbackUrl(config: AppConfig): string {
	// Strip any trailing slash so the publish URL and the verify URL are
	// byte-identical however PUBLIC_URL is written — QStash signs this exact
	// string into the JWT, so a stray "//" would break Receiver.verify.
	const origin = (config.publicUrl ?? "").replace(/\/+$/, "");
	return `${origin}/api/github/review-run`;
}

// Publish a delayed review-run callback. Returns null when QStash isn't
// configured (or PUBLIC_URL is missing) so the caller can fall back to running
// the review inline — never silently drops the review.
export async function scheduleReview(
	config: AppConfig,
	message: ReviewRunMessage,
	delaySeconds: number,
): Promise<{ messageId: string } | null> {
	if (!config.qstashToken || !config.publicUrl) return null;
	const client = new Client({ token: config.qstashToken });
	const res = await client.publishJSON({
		url: reviewRunCallbackUrl(config),
		body: message,
		delay: Math.max(0, Math.floor(delaySeconds)),
		// Dedups GitHub webhook REDELIVERIES of the same push only. Cross-push
		// coalescing is handled by the head-SHA staleness check in the callback —
		// deduplicationId cannot cancel an already-scheduled older-SHA message.
		deduplicationId: `${message.provider}:${message.owner}/${message.repo}:${message.pullNumber}:${message.headSha}`,
		// Cap retries: the callback returns 500 on a failed review so QStash
		// retries, but a review releases its idempotency claim on failure, so each
		// retry RE-RUNS the full agent suite (~8 with Tier 2 on). One retry covers
		// a transient blip without fanning out model spend on a flapping provider.
		retries: 1,
	});
	return { messageId: res.messageId };
}

export async function verifyQStashSignature(
	config: AppConfig,
	rawBody: string,
	signature: string,
): Promise<boolean> {
	if (
		!config.qstashCurrentSigningKey ||
		!config.qstashNextSigningKey ||
		!config.publicUrl
	)
		return false;
	const receiver = new Receiver({
		currentSigningKey: config.qstashCurrentSigningKey,
		nextSigningKey: config.qstashNextSigningKey,
	});
	try {
		return await receiver.verify({
			body: rawBody,
			signature,
			url: reviewRunCallbackUrl(config),
		});
	} catch {
		return false;
	}
}
