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
	cachedInputTokens?: number;
}

function priceFor(model: string, tierPromptTokens: number) {
	const pinned = Object.entries(getConfigTree().models).find(
		([key]) => key === model || key.endsWith(`/${model}`),
	)?.[1]?.pricing;
	return pinned ?? lookupPrice(model, tierPromptTokens);
}

/** Cost in USD of ONE request, or undefined when no price is known. The
 * OpenRouter long-prompt tier is chosen from this request's own prompt size.
 * A `pricing` pin in the config wins over the table. Unknown is never $0. */
export function computeCost(
	usage: TokenUsage,
	model: string,
): number | undefined {
	return costAt(usage, model, usage.promptTokens);
}

/** Cost in USD of `count` identical requests, with the tier chosen from one
 * request's prompt size. For estimates that model N similar calls. */
export function computeRepeatedCost(
	request: TokenUsage,
	model: string,
	count: number,
): number | undefined {
	return costAt(
		{
			promptTokens: request.promptTokens * count,
			completionTokens: request.completionTokens * count,
			cachedInputTokens:
				request.cachedInputTokens === undefined
					? undefined
					: request.cachedInputTokens * count,
			cachedPromptTokens:
				request.cachedPromptTokens === undefined
					? undefined
					: request.cachedPromptTokens * count,
		},
		model,
		request.promptTokens,
	);
}

/** Cost in USD of usage summed over several requests, priced at the base rate.
 * A prompt-size tier applies to a single request, which a sum cannot tell, so
 * no tier is guessed. Use `computeRequestsCost` when per-request usage exists. */
export function computeAggregateCost(
	usage: TokenUsage,
	model: string,
): number | undefined {
	return costAt(usage, model, 0);
}

/** Sum of per-request costs, each request tiered by its own prompt size. */
export function computeRequestsCost(
	requests: readonly TokenUsage[],
	model: string,
): number | undefined {
	let total = 0;
	for (const request of requests) {
		const cost = computeCost(request, model);
		if (cost === undefined) return undefined;
		total += cost;
	}
	return total;
}

function costAt(
	usage: TokenUsage,
	model: string,
	tierPromptTokens: number,
): number | undefined {
	const price = priceFor(model, tierPromptTokens);
	if (!price) return undefined;
	const { input, cachedInput, output } = price;
	const cached = Math.min(
		Math.max(usage.cachedInputTokens ?? usage.cachedPromptTokens ?? 0, 0),
		usage.promptTokens,
	);
	return (
		((usage.promptTokens - cached) / 1_000_000) * input +
		(cached / 1_000_000) * cachedInput +
		(usage.completionTokens / 1_000_000) * output
	);
}

export function sumCost(
	byModel: ReadonlyMap<string, readonly TokenUsage[]>,
): number | undefined {
	let total = 0;
	for (const [model, requests] of byModel) {
		const cost = computeRequestsCost(requests, model);
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
