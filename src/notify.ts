/** Marker carried in the PR comment body so a persistent quota-exhausted
 * condition, retried every `watch` cycle, finds its own prior warning instead
 * of reposting an identical comment each time. */
export function quotaCommentMarker(provider: string): string {
	return `<!-- ai-review:quota-exhausted-comment:${provider} -->`;
}

/** Marker carried in the PR comment body so a persistent rate-limit
 * condition, retried every `watch` cycle, finds its own prior warning instead
 * of reposting an identical comment each time. */
export function rateLimitCommentMarker(provider: string): string {
	return `<!-- ai-review:rate-limited-comment:${provider} -->`;
}

/** Display name for a provider. Unknown values are surfaced as-is rather than
 * folded into a default: this label appears in the message telling someone
 * WHICH account to pay, so guessing wrong is worse than admitting ignorance. */
export function providerLabel(provider: string): string {
	if (provider === "openai") return "OpenAI";
	if (provider === "anthropic") return "Anthropic";
	return `provider "${provider}"`;
}

export function billingUrl(provider: string): string | null {
	if (provider === "openai")
		return "https://platform.openai.com/settings/organization/billing";
	if (provider === "anthropic")
		return "https://console.anthropic.com/settings/billing";
	return null;
}
