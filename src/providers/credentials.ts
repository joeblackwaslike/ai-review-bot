import type { ProviderName } from "./names.js";

export interface ProviderCredentials {
	apiKey?: string;
	baseURL?: string;
}

const KEY_ENV: Record<ProviderName, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export function resolveProviderCredentials(
	provider: ProviderName,
	env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderCredentials {
	const apiKey = env[KEY_ENV[provider]]?.trim();
	return apiKey ? { apiKey } : {};
}
