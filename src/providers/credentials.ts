import { providerKeySpec, readSecret } from "../config/env.js";
import type { Config } from "../config/schema.js";
import type { ProviderName } from "./names.js";

export interface ProviderCredentials {
	apiKey?: string;
	baseURL?: string;
}

export function resolveProviderCredentials(
	provider: ProviderName,
	env: Readonly<Record<string, string | undefined>> = process.env,
	providers: Config["providers"] = {},
): ProviderCredentials {
	const { value: apiKey } = readSecret(providerKeySpec(provider), env);
	const baseURL = providers[provider]?.baseURL;
	return {
		...(apiKey ? { apiKey } : {}),
		...(baseURL ? { baseURL } : {}),
	};
}
