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
	const origin = (config.publicUrl ?? "").trim().replace(/\/+$/, "");
	return `${origin}/api/github/review-run`;
}

// Publish a delayed review-run callback. Returns null when QStash can't be used
// — either the config is incomplete OR the publish itself fails — so the caller
// always falls back to running the review inline. NEVER silently drops a review.
export async function scheduleReview(
	config: AppConfig,
	message: ReviewRunMessage,
	delaySeconds: number,
): Promise<{ messageId: string } | null> {
	// Require the FULL config (token, public URL, AND both signing keys) before
	// publishing. A partial config would publish a message the callback can't
	// verify (401) — dropping the review with no inline fallback. Treating partial
	// config as "unconfigured" keeps the symmetric inline fallback path.
	if (
		!config.qstashToken ||
		!config.publicUrl ||
		!config.qstashCurrentSigningKey ||
		!config.qstashNextSigningKey
	)
		return null;
	const client = new Client({ token: config.qstashToken });
	try {
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
	} catch (error) {
		// Publish failed (QStash outage / network). Fall back to the inline review
		// path instead of dropping the review. The per-(pr,headSha) idempotency
		// claim in maybeSubmitReview still guards against a double-post.
		console.error("QStash publish failed; falling back to inline review", {
			provider: message.provider,
			owner: message.owner,
			repo: message.repo,
			pullNumber: message.pullNumber,
			error,
		});
		return null;
	}
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
