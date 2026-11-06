import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ResolvedAuth } from "./auth.js";
import { getConfigTree } from "./config/load.js";
import { lookupPrice } from "./pricing.js";
import { resolveProviderCredentials } from "./providers/credentials.js";
import { createModelRegistry } from "./providers/registry.js";
import type { ModelSelection } from "./router.js";

export interface TokenUsage {
	promptTokens: number;
	cachedPromptTokens?: number;
	completionTokens: number;
}

/** Cost in USD, or undefined when no price is known. A `pricing` pin in the
 * config wins over the OpenRouter table. Unknown is never reported as $0. */
export function computeCost(
	usage: TokenUsage,
	model: string,
): number | undefined {
	const pinned = Object.entries(getConfigTree().models).find(
		([key]) => key === model || key.endsWith(`/${model}`),
	)?.[1]?.pricing;
	const price = pinned ?? lookupPrice(model, usage.promptTokens);
	if (!price) return undefined;
	const { input, cachedInput, output } = price;
	const cached = Math.min(usage.cachedPromptTokens ?? 0, usage.promptTokens);
	return (
		((usage.promptTokens - cached) / 1_000_000) * input +
		(cached / 1_000_000) * cachedInput +
		(usage.completionTokens / 1_000_000) * output
	);
}

export function sumCost(
	byModel: ReadonlyMap<string, TokenUsage>,
): number | undefined {
	let total = 0;
	for (const [model, usage] of byModel) {
		const cost = computeCost(usage, model);
		if (cost === undefined) return undefined;
		total += cost;
	}
	return total;
}

export function modelLabel(models: readonly string[]): string {
	return [...new Set(models)].sort().join(",");
}

function fromRegistry(selection: ModelSelection): LanguageModel {
	const creds = {
		[selection.provider]: resolveProviderCredentials(
			selection.provider,
			process.env,
			getConfigTree().providers,
		),
	};
	return createModelRegistry(creds).languageModel(
		`${selection.provider}/${selection.model}`,
	);
}

/**
 * Build a language model for a provider. When `auth` is omitted (the hosted
 * webhook path), the providers read their API key from the environment exactly
 * as before. When `auth` is supplied (local CLI), it carries either an explicit
 * API key or an OAuth token + custom `fetch` for subscription billing.
 */
export function createAIModel(
	selection: ModelSelection,
	auth?: ResolvedAuth,
): LanguageModel {
	if (auth && auth.provider !== selection.provider) {
		throw new Error(
			`auth for ${auth.provider} cannot be used with a ${selection.provider} model`,
		);
	}
	switch (selection.provider) {
		case "anthropic": {
			if (!auth) return fromRegistry(selection);
			if (auth.mode === "api-key") {
				const provider = createAnthropic({
					apiKey: auth.apiKey,
					baseURL: auth.baseURL,
				});
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
			if (!auth) return fromRegistry(selection);
			if (auth.mode === "api-key") {
				const provider = createOpenAI({
					apiKey: auth.apiKey,
					baseURL: auth.baseURL,
				});
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
		case "google":
			return fromRegistry(selection);
	}
}
