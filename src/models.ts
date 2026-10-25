import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { ResolvedAuth } from "./auth.js";
import type { ModelSelection } from "./router.js";

interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
}

// $/1M tokens. Anthropic rates from platform.claude.com/docs/en/about-claude/models/overview;
// OpenAI rates from developers.openai.com/api/docs/models/gpt-6{-luna,.1-sol} (Oct 2026).
// ponytail: flat rates — Haiku 5.5 bills $0.50/$2.50 above 100K prompt tokens,
// so huge trivial-tier diffs are under-reported; add a tier split if that matters.
const TOKEN_RATES: Record<string, { input: number; output: number }> = {
	"claude-haiku-5-5": { input: 0.1, output: 0.5 },
	"claude-sonnet-5-5": { input: 2.0, output: 10.0 },
	"claude-opus-5-5": { input: 4.0, output: 20.0 },
	"gpt-6-luna": { input: 0.1, output: 0.5 },
	"gpt-6.1-sol": { input: 2.0, output: 10.0 },
};

export function computeCost(usage: TokenUsage, model: string): number {
	const rates = TOKEN_RATES[model];
	if (!rates) return 0;
	return (
		(usage.promptTokens / 1_000_000) * rates.input +
		(usage.completionTokens / 1_000_000) * rates.output
	);
}

/**
 * Build a language model for a provider. When `auth` is omitted (the hosted
 * webhook path), the providers read their API key from the environment exactly
 * as before. When `auth` is supplied (local CLI), it carries either an explicit
 * API key or an OAuth token + custom `fetch` for subscription billing.
 */
export function createAIModel(selection: ModelSelection, auth?: ResolvedAuth) {
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
