import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
	res.status(200).json({
		reviewEnabled: process.env.REVIEW_ENABLED,
		reviewEnabledBool: process.env.REVIEW_ENABLED === "true",
		reviewCommand: process.env.REVIEW_COMMAND ?? "/claude-review (default)",
		anthropicModel:
			process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6 (default)",
		hasAppId: !!process.env.GITHUB_APP_ID,
		hasPrivateKey: !!process.env.GITHUB_APP_PRIVATE_KEY,
		hasWebhookSecret: !!process.env.GITHUB_WEBHOOK_SECRET,
		hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
	});
}
