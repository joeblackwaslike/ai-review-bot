import type { VercelRequest, VercelResponse } from "@vercel/node";
import { describeConfig, getLoadedConfig } from "../src/config/load.js";

const REDACTED_PATHS = new Set(["review.customPrompt"]);

export default function handler(_req: VercelRequest, res: VercelResponse) {
	const loaded = getLoadedConfig();
	res.status(200).json({
		config: describeConfig(loaded).map((row) =>
			REDACTED_PATHS.has(row.path) && row.value !== undefined
				? { ...row, value: "[set]" }
				: row,
		),
		warnings: loaded.warnings,
		reviewEnabled: loaded.config.review.enabled,
		reviewCommand: loaded.config.review.command,
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
