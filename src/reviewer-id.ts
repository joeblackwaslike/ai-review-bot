export type ReviewerId = string;
export type LegacyProvider = "anthropic" | "openai";

const LEGACY_PROVIDER_BY_REVIEWER: Readonly<Record<string, LegacyProvider>> = {
	claude: "anthropic",
	codex: "openai",
};

const REVIEWER_BY_LEGACY_PROVIDER: Readonly<Record<string, ReviewerId>> = {
	anthropic: "claude",
	openai: "codex",
};

export function legacyProviderOf(id: ReviewerId): string {
	return Object.hasOwn(LEGACY_PROVIDER_BY_REVIEWER, id)
		? (LEGACY_PROVIDER_BY_REVIEWER[id] as string)
		: id;
}

export function reviewerFromLegacy(identity: string): ReviewerId {
	return Object.hasOwn(REVIEWER_BY_LEGACY_PROVIDER, identity)
		? (REVIEWER_BY_LEGACY_PROVIDER[identity] as string)
		: identity;
}
