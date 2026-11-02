import { describe, expect, it } from "vitest";
import { computeCost, createAIModel } from "./models.js";

describe("computeCost", () => {
	it("computes cost for claude-haiku-5-5 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"claude-haiku-5-5",
		);
		expect(cost).toBeCloseTo(0.6); // $0.10 input + $0.50 output
	});

	it("computes cost for claude-sonnet-5-5 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"claude-sonnet-5-5",
		);
		expect(cost).toBeCloseTo(12.0); // $2 input + $10 output
	});

	it("computes cost for claude-opus-5-5 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"claude-opus-5-5",
		);
		expect(cost).toBeCloseTo(24.0); // $4 input + $20 output
	});

	it("computes cost for gpt-6-luna at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"gpt-6-luna",
		);
		expect(cost).toBeCloseTo(0.6); // $0.10 input + $0.50 output
	});

	it("computes cost for gpt-6.1-sol at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"gpt-6.1-sol",
		);
		expect(cost).toBeCloseTo(12.0); // $2 input + $10 output
	});

	it("returns 0 for an unknown model", () => {
		const cost = computeCost(
			{ promptTokens: 100_000, completionTokens: 50_000 },
			"unknown-model-xyz",
		);
		expect(cost).toBe(0);
	});

	it("scales correctly for small token counts (sonnet)", () => {
		// 1000 input tokens: 1000/1M * 2.00 = $0.002
		// 500 output tokens: 500/1M * 10.00 = $0.005
		// total: $0.007
		const cost = computeCost(
			{ promptTokens: 1_000, completionTokens: 500 },
			"claude-sonnet-5-5",
		);
		expect(cost).toBeCloseTo(0.007, 5);
	});

	it("returns 0 when both token counts are 0", () => {
		const cost = computeCost(
			{ promptTokens: 0, completionTokens: 0 },
			"claude-sonnet-5-5",
		);
		expect(cost).toBe(0);
	});
});

describe("computeCost with config pricing", () => {
	it("computeCost matches the old rates for all five models", () => {
		const expected: Record<string, number> = {
			"claude-haiku-5-5": 0.6,
			"claude-sonnet-5-5": 12,
			"claude-opus-5-5": 24,
			"gpt-6-luna": 0.6,
			"gpt-6.1-sol": 12,
		};
		for (const [model, cost] of Object.entries(expected)) {
			expect(
				computeCost(
					{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
					model,
				),
			).toBeCloseTo(cost);
		}
	});

	it("returns 0 for an unknown model", () => {
		expect(
			computeCost({ promptTokens: 1000, completionTokens: 1000 }, "nope"),
		).toBe(0);
	});

	it("computeCost bills cached tokens at cachedInput", () => {
		const cost = computeCost(
			{
				promptTokens: 1_000_000,
				cachedPromptTokens: 500_000,
				completionTokens: 0,
			},
			"claude-sonnet-5-5",
		);
		expect(cost).toBeCloseTo(0.5 * 2.0 + 0.5 * 0.2);
	});

	it("clamps cached tokens to the prompt size", () => {
		const cost = computeCost(
			{
				promptTokens: 1_000_000,
				cachedPromptTokens: 2_000_000,
				completionTokens: 0,
			},
			"claude-sonnet-5-5",
		);
		expect(cost).toBeCloseTo(0.2);
	});
});

describe("createAIModel auth binding", () => {
	const anthropic = {
		provider: "anthropic",
		model: "claude-haiku-5-5",
		effort: "low",
	} as const;

	it("createAIModel rejects a credential for a different provider", () => {
		expect(() =>
			createAIModel(anthropic, {
				mode: "api-key",
				provider: "openai",
				apiKey: "k",
			}),
		).toThrow("auth for openai cannot be used with a anthropic model");
	});

	it("createAIModel accepts matching provider auth", () => {
		expect(() =>
			createAIModel(anthropic, {
				mode: "api-key",
				provider: "anthropic",
				apiKey: "k",
			}),
		).not.toThrow();
	});
});
