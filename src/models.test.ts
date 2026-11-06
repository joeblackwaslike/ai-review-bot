import { describe, expect, it, vi } from "vitest";
import { computeCost, createAIModel, modelLabel, sumCost } from "./models.js";
import { setPriceTable } from "./pricing.js";

const pins = vi.hoisted(() => ({
	models: undefined as Record<string, unknown> | undefined,
}));
vi.mock("./config/load.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./config/load.js")>();
	return {
		...real,
		getConfigTree: () => {
			const tree = real.getConfigTree();
			return pins.models ? { ...tree, models: pins.models } : tree;
		},
	};
});

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

	it("returns undefined for an unknown model", () => {
		const cost = computeCost(
			{ promptTokens: 100_000, completionTokens: 50_000 },
			"unknown-model-xyz",
		);
		expect(cost).toBeUndefined();
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

	it("prices cached input tokens below uncached ones", () => {
		const cold = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 0 },
			"claude-sonnet-5-5",
		);
		const warm = computeCost(
			{
				promptTokens: 1_000_000,
				completionTokens: 0,
				cachedInputTokens: 800_000,
			},
			"claude-sonnet-5-5",
		);
		expect(cold).toBeCloseTo(2.0);
		expect(warm).toBeCloseTo(0.2 * 2.0 + 0.8 * 0.2);
	});

	it("prices a call without cachedInputTokens as before", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"gpt-6.1-sol",
		);
		expect(cost).toBeCloseTo(12.0);
	});

	it("clamps cached tokens above the prompt to the prompt", () => {
		const cost = computeCost(
			{
				promptTokens: 1_000_000,
				completionTokens: 0,
				cachedInputTokens: 5_000_000,
			},
			"claude-sonnet-5-5",
		);
		expect(cost).toBeCloseTo(0.2);
	});

	it("is unavailable for an unknown model with cached tokens", () => {
		expect(
			computeCost(
				{ promptTokens: 10, completionTokens: 10, cachedInputTokens: 5 },
				"nope",
			),
		).toBeUndefined();
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

	it("returns undefined for an unknown model", () => {
		expect(
			computeCost({ promptTokens: 1000, completionTokens: 1000 }, "nope"),
		).toBeUndefined();
	});

	it("applies the tier price for large prompts", () => {
		setPriceTable({
			"anthropic/claude-haiku-5-5": {
				input: 0.1,
				cachedInput: 0.01,
				output: 0.5,
				tiers: [
					{
						minPromptTokens: 100_000,
						input: 0.5,
						cachedInput: 0.05,
						output: 2.5,
					},
				],
			},
		});
		const usage = { promptTokens: 200_000, completionTokens: 0 };
		expect(computeCost(usage, "claude-haiku-5-5")).toBeCloseTo(0.1);
	});

	it("lets a config pin beat the price table", () => {
		pins.models = {
			"anthropic/claude-sonnet-5-5": {
				pricing: { input: 1, cachedInput: 1, output: 1 },
			},
		};
		try {
			expect(
				computeCost(
					{ promptTokens: 1_000_000, completionTokens: 0 },
					"claude-sonnet-5-5",
				),
			).toBeCloseTo(1);
		} finally {
			pins.models = undefined;
		}
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

describe("createAIModel google", () => {
	it("builds a google model from the env key", () => {
		vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "k");
		const model = createAIModel({
			provider: "google",
			model: "gemini-3.8-flash",
		});
		expect((model as { provider: string }).provider).toMatch(/^google/);
		vi.unstubAllEnvs();
	});

	it("rejects an anthropic auth for a google model", () => {
		expect(() =>
			createAIModel({ provider: "google", model: "gemini-3.8-flash" }, {
				provider: "anthropic",
				mode: "api-key",
				apiKey: "x",
			} as never),
		).toThrow(/cannot be used with a google model/);
	});
});

describe("sumCost and modelLabel", () => {
	const usage = (promptTokens: number, completionTokens: number) => ({
		promptTokens,
		completionTokens,
	});

	it("sums computeCost per model", () => {
		const byModel = new Map([
			["claude-haiku-5-5", usage(1_000_000, 1_000_000)],
			["claude-sonnet-5-5", usage(1_000_000, 0)],
		]);
		const expected =
			(computeCost(usage(1_000_000, 1_000_000), "claude-haiku-5-5") ?? NaN) +
			(computeCost(usage(1_000_000, 0), "claude-sonnet-5-5") ?? NaN);
		expect(sumCost(byModel)).toBeCloseTo(expected);
		expect(expected).toBeGreaterThan(0);
	});

	it("is undefined when any model has no price", () => {
		const byModel = new Map([
			["claude-haiku-5-5", usage(10, 10)],
			["no-such-model", usage(10, 10)],
		]);
		expect(sumCost(byModel)).toBeUndefined();
	});

	it("is 0 for an empty map", () => {
		expect(sumCost(new Map())).toBe(0);
	});

	it("labels unique sorted models joined with a comma", () => {
		expect(modelLabel(["b", "a", "b"])).toBe("a,b");
		expect(modelLabel(["only"])).toBe("only");
	});
});
