import { describe, expect, it } from "vitest";
import { computeCost } from "./models.js";

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
