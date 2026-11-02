import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { ResolvedAuth } from "./auth.js";
import { getConfigTree } from "./config/load.js";
import type { ModelSelection } from "./router.js";

interface TokenUsage {
	promptTokens: number;
	cachedPromptTokens?: number;
	completionTokens: number;
}

export function computeCost(usage: TokenUsage, model: string): number {
	const models = getConfigTree().models;
	const entry = Object.entries(models).find(
		([key]) => key === model || key.endsWith(`/${model}`),
	)?.[1];
	if (!entry) return 0;
	const { input, cachedInput, output } = entry.pricing;
	const cached = Math.min(usage.cachedPromptTokens ?? 0, usage.promptTokens);
	return (
		((usage.promptTokens - cached) / 1_000_000) * input +
		(cached / 1_000_000) * cachedInput +
		(usage.completionTokens / 1_000_000) * output
	);
}

/**
 * Build a language model for a provider. When `auth` is omitted (the hosted
 * webhook path), the providers read their API key from the environment exactly
 * as before. When `auth` is supplied (local CLI), it carries either an explicit
 * API key or an OAuth token + custom `fetch` for subscription billing.
 */
export function createAIModel(selection: ModelSelection, auth?: ResolvedAuth) {
	if (auth && auth.provider !== selection.provider) {
		throw new Error(
			`auth for ${auth.provider} cannot be used with a ${selection.provider} model`,
		);
	}
	switch (selection.provider) {
		case "anthropic": {
			if (!auth || auth.mode === "api-key") {
				const provider = createAnthropic(
					auth ? { apiKey: auth.apiKey, baseURL: auth.baseURL } : {},
				);
				return provider(selection.model);
			}
			// OAuth: token is asserted by the custom fetch; pass a placeholder key
			// so the SDK initialises (the fetch deletes the resulting x-api-key).
			const provider = createAnthropic({
				apiKey: "oauth",
				baseURL: auth.baseURL,
				headers: auth.headers,
				fetch: auth.fetch,
			});
			return provider(selection.model);
		}
		case "openai": {
			if (!auth || auth.mode === "api-key") {
				const provider = createOpenAI(
					auth ? { apiKey: auth.apiKey, baseURL: auth.baseURL } : {},
				);
				return provider(selection.model);
			}
			// Codex subscription backend is Responses-API only.
			const provider = createOpenAI({
				apiKey: auth.token,
				baseURL: auth.baseURL,
				headers: auth.headers,
				fetch: auth.fetch,
			});
			return provider.responses(selection.model);
		}
	}
}
