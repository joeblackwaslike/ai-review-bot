import { describe, expect, it } from "vitest";
import { computeCost } from "./models.js";

describe("computeCost", () => {
	it("computes cost for claude-haiku-4-5 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"claude-haiku-4-5",
		);
		expect(cost).toBeCloseTo(6.0); // $1 input + $5 output
	});

	it("computes cost for claude-sonnet-4-6 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"claude-sonnet-4-6",
		);
		expect(cost).toBeCloseTo(18.0); // $3 input + $15 output
	});

	it("computes cost for claude-opus-4-7 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"claude-opus-4-7",
		);
		expect(cost).toBeCloseTo(30.0); // $5 input + $25 output
	});

	it("computes cost for gpt-5 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"gpt-5",
		);
		expect(cost).toBeCloseTo(17.5); // $2.50 input + $15 output
	});

	it("computes cost for o4-mini at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"o4-mini",
		);
		expect(cost).toBeCloseTo(2.75); // $0.55 input + $2.20 output
	});

	it("computes cost for o3 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"o3",
		);
		expect(cost).toBeCloseTo(10.0); // $2 input + $8 output
	});

	it("returns 0 for an unknown model", () => {
		const cost = computeCost(
			{ promptTokens: 100_000, completionTokens: 50_000 },
			"unknown-model-xyz",
		);
		expect(cost).toBe(0);
	});

	it("scales correctly for small token counts (sonnet)", () => {
		// 1000 input tokens: 1000/1M * 3.00 = $0.003
		// 500 output tokens: 500/1M * 15.00 = $0.0075
		// total: $0.0105
		const cost = computeCost(
			{ promptTokens: 1_000, completionTokens: 500 },
			"claude-sonnet-4-6",
		);
		expect(cost).toBeCloseTo(0.0105, 5);
	});

	it("returns 0 when both token counts are 0", () => {
		const cost = computeCost(
			{ promptTokens: 0, completionTokens: 0 },
			"claude-sonnet-4-6",
		);
		expect(cost).toBe(0);
	});
});
