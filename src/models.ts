import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { ResolvedAuth } from "./auth.js";
import type { ModelSelection } from "./router.js";

interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
}

// $/1M tokens. Anthropic rates confirmed from platform.claude.com/docs/en/about-claude/models/overview;
// OpenAI rates confirmed from developers.openai.com/api/docs/models/gpt-5.6-{sol,terra,luna} (Aug 2026).
const TOKEN_RATES: Record<string, { input: number; output: number }> = {
	"claude-haiku-4-5": { input: 1.0, output: 5.0 },
	"claude-sonnet-5": { input: 2.0, output: 10.0 },
	"claude-opus-5": { input: 5.0, output: 25.0 },
	// GPT-5.6's three durable capability tiers, used across both the API-key
	// and OAuth/subscription backends (see router.ts / triage.ts) — gpt-5.4
	// (the model that previously required an auth-mode split) retires from
	// the Codex/ChatGPT-OAuth backend on 2026-08-31.
	"gpt-5.6-luna": { input: 0.2, output: 1.2 },
	"gpt-5.6-terra": { input: 2.0, output: 12.0 },
	"gpt-5.6-sol": { input: 5.0, output: 30.0 },
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
