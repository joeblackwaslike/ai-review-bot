import type { VercelRequest, VercelResponse } from "@vercel/node";
import { describeConfig, getLoadedConfig } from "../src/config/load.js";

const REDACTED_PATHS = new Set(["review.customPrompt"]);
const MAX_CONFIG_ERROR_LENGTH = 300;

export function sanitizeConfigError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = message.split("\n")[0] ?? "";
	const withoutPaths = firstLine.replace(
		/(^|[\s"'(=:])\/[^\s"']+/g,
		(match, boundary: string) => {
			const path = match.slice(boundary.length);
			const base = path.split("/").pop();
			return base && base.length > 0 ? `${boundary}${base}` : match;
		},
	);
	return withoutPaths.slice(0, MAX_CONFIG_ERROR_LENGTH);
}

export default function handler(_req: VercelRequest, res: VercelResponse) {
	const hasFields = {
		hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
		hasAppId: !!process.env.GITHUB_APP_ID,
		hasPrivateKey: !!process.env.GITHUB_APP_PRIVATE_KEY,
		hasWebhookSecret: !!process.env.GITHUB_WEBHOOK_SECRET,
		hasOpenAIKey: !!process.env.OPENAI_API_KEY,
		hasOpenAIAppId: !!process.env.OPENAI_APP_ID,
		hasOpenAIPrivateKey: !!process.env.OPENAI_APP_PRIVATE_KEY,
		hasOpenAIWebhookSecret: !!process.env.OPENAI_APP_WEBHOOK_SECRET,
	};
	let loaded: ReturnType<typeof getLoadedConfig>;
	try {
		loaded = getLoadedConfig();
	} catch (error) {
		res.status(200).json({
			configError: sanitizeConfigError(error),
			...hasFields,
		});
		return;
	}
	res.status(200).json({
		config: describeConfig(loaded).map((row) =>
			REDACTED_PATHS.has(row.path) && row.value !== undefined
				? { ...row, value: "[set]" }
				: row,
		),
		warnings: loaded.warnings,
		reviewEnabled: loaded.config.review.enabled,
		reviewCommand: loaded.config.review.command,
		...hasFields,
	});
}
