export interface AppConfig {
	appId: string;
	privateKey: string;
	webhookSecret: string;
	reviewEnabled: boolean;
	reviewDelayMs: number;
	reviewCommentPrefix: string;
	reviewCommand: string;
	provider: "anthropic" | "openai";
}

function getRequiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function normalizePrivateKey(raw: string): string {
	return raw.replaceAll(String.raw`\n`, "\n");
}

function validatePrivateKey(key: string): string {
	if (key.includes("BEGIN RSA PRIVATE KEY")) {
		throw new Error(
			"GITHUB_APP_PRIVATE_KEY is in PKCS#1 format (BEGIN RSA PRIVATE KEY). " +
				"Convert to PKCS#8 before storing:\n" +
				"openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key.pkcs8.pem",
		);
	}
	return key;
}

export function getConfig(): AppConfig {
	return {
		appId: getRequiredEnv("GITHUB_APP_ID"),
		privateKey: validatePrivateKey(
			normalizePrivateKey(getRequiredEnv("GITHUB_APP_PRIVATE_KEY")),
		),
		webhookSecret: getRequiredEnv("GITHUB_WEBHOOK_SECRET"),
		reviewEnabled: process.env.REVIEW_ENABLED !== "false",
		reviewDelayMs: Number(process.env.REVIEW_DELAY_SECONDS ?? "450") * 1000,
		reviewCommentPrefix:
			process.env.REVIEW_COMMENT_PREFIX ?? "claude-review-bot",
		reviewCommand: process.env.REVIEW_COMMAND ?? "/claude-review",
		provider: "anthropic",
	};
}

export function getOpenAIAppConfig(): AppConfig {
	return {
		appId: getRequiredEnv("OPENAI_APP_ID"),
		privateKey: validatePrivateKey(
			normalizePrivateKey(getRequiredEnv("OPENAI_APP_PRIVATE_KEY")),
		),
		webhookSecret: getRequiredEnv("OPENAI_APP_WEBHOOK_SECRET"),
		reviewEnabled: process.env.REVIEW_ENABLED !== "false",
		reviewDelayMs: Number(process.env.REVIEW_DELAY_SECONDS ?? "450") * 1000,
		reviewCommentPrefix:
			process.env.REVIEW_COMMENT_PREFIX ?? "codex-review-bot",
		reviewCommand: process.env.REVIEW_COMMAND ?? "/claude-review",
		provider: "openai",
	};
}
