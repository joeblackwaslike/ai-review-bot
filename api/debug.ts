import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
	res.status(200).json({
		reviewEnabled: process.env.REVIEW_ENABLED !== "false",
		reviewCommand: process.env.REVIEW_COMMAND ?? "/ai-review",
		hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
		hasAppId: !!process.env.GITHUB_APP_ID,
		hasPrivateKey: !!process.env.GITHUB_APP_PRIVATE_KEY,
		hasWebhookSecret: !!process.env.GITHUB_WEBHOOK_SECRET,
		hasOpenAIKey: !!process.env.OPENAI_API_KEY,
		hasOpenAIAppId: !!process.env.OPENAI_APP_ID,
		hasOpenAIPrivateKey: !!process.env.OPENAI_APP_PRIVATE_KEY,
		hasOpenAIWebhookSecret: !!process.env.OPENAI_APP_WEBHOOK_SECRET,
	});
}
