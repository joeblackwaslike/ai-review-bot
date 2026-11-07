export const PROVIDER_NAMES = ["anthropic", "openai", "google"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(value: string): value is ProviderName {
	return (PROVIDER_NAMES as readonly string[]).includes(value);
}

export function splitModelId(id: string): {
	provider: ProviderName;
	model: string;
} {
	const slash = id.indexOf("/");
	const provider = slash > 0 ? id.slice(0, slash) : "";
	const model = id.slice(slash + 1);
	if (!isProviderName(provider) || !model) {
		throw new Error(
			`model id "${id}" must be "<provider>/<model>" with provider one of ${PROVIDER_NAMES.join(", ")}`,
		);
	}
	return { provider, model };
}
