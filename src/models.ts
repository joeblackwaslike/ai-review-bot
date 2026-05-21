import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { ModelSelection } from "./router.js";

interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
}

const TOKEN_RATES: Record<string, { input: number; output: number }> = {
	"claude-haiku-4-5": { input: 1.0, output: 5.0 },
	"claude-sonnet-4-6": { input: 3.0, output: 15.0 },
	"claude-opus-4-7": { input: 5.0, output: 25.0 },
	"gpt-5": { input: 2.5, output: 15.0 },
	"o4-mini": { input: 0.55, output: 2.2 },
	o3: { input: 2.0, output: 8.0 },
};

export function computeCost(usage: TokenUsage, model: string): number {
	const rates = TOKEN_RATES[model];
	if (!rates) return 0;
	return (
		(usage.promptTokens / 1_000_000) * rates.input +
		(usage.completionTokens / 1_000_000) * rates.output
	);
}

export function createAIModel(selection: ModelSelection) {
	switch (selection.provider) {
		case "anthropic":
			return anthropic(selection.model);
		case "openai":
			return openai(selection.model);
	}
}
