import { generateObject } from "ai";
import { describe, expect, it } from "vitest";
import { ModelReviewSchema } from "../review.js";
import { reasoningProviderOptions } from "../router.js";
import { buildModelReview } from "../testing.js";
import { createModelRegistry } from "./registry.js";

const REJECTED_KEYS = [
	"additionalProperties",
	"$schema",
	"$ref",
	"$defs",
	"const",
];

function findKeys(node: unknown, found: string[] = []): string[] {
	if (Array.isArray(node)) {
		for (const item of node) findKeys(item, found);
	} else if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (REJECTED_KEYS.includes(key)) found.push(key);
			findKeys(value, found);
		}
	}
	return found;
}

interface GeminiRequest {
	generationConfig: {
		responseMimeType: string;
		responseSchema: unknown;
		thinkingConfig: { thinkingLevel: string };
	};
}

describe("Gemini structured output", () => {
	it("sends ModelReviewSchema as a Gemini-safe responseSchema and parses the reply", async () => {
		const requests: { url: string; body: GeminiRequest }[] = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input),
				body: JSON.parse(String(init?.body)),
			});
			return new Response(
				JSON.stringify({
					candidates: [
						{
							content: {
								role: "model",
								parts: [{ text: JSON.stringify(buildModelReview()) }],
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						totalTokenCount: 15,
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		const selection = {
			provider: "google" as const,
			model: "gemini-3.1-flash-lite",
			effort: "low" as const,
		};
		const model = createModelRegistry(
			{ google: { apiKey: "k" } },
			{ fetch: fakeFetch },
		).languageModel(`${selection.provider}/${selection.model}`);

		const result = await generateObject({
			model,
			schema: ModelReviewSchema,
			providerOptions: reasoningProviderOptions(selection),
			messages: [{ role: "user", content: "review" }],
		});

		expect(requests).toHaveLength(1);
		const { url, body } = requests[0];
		expect(url).toContain("models/gemini-3.1-flash-lite:generateContent");
		expect(body.generationConfig.responseMimeType).toBe("application/json");
		expect(body.generationConfig.responseSchema).toBeDefined();
		expect(findKeys(body.generationConfig.responseSchema)).toEqual([]);
		expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
		expect(ModelReviewSchema.safeParse(result.object).success).toBe(true);
		expect(result.usage.inputTokens).toBe(10);
	});
});
