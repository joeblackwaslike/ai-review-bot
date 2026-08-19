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

	it("computes cost for claude-sonnet-5 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"claude-sonnet-5",
		);
		expect(cost).toBeCloseTo(12.0); // $2 input + $10 output
	});

	it("computes cost for claude-opus-5 at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"claude-opus-5",
		);
		expect(cost).toBeCloseTo(30.0); // $5 input + $25 output
	});

	it("computes cost for gpt-5.6-luna at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"gpt-5.6-luna",
		);
		expect(cost).toBeCloseTo(1.4); // $0.20 input + $1.20 output
	});

	it("computes cost for gpt-5.6-terra at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"gpt-5.6-terra",
		);
		expect(cost).toBeCloseTo(14.0); // $2 input + $12 output
	});

	it("computes cost for gpt-5.6-sol at 1M tokens each", () => {
		const cost = computeCost(
			{ promptTokens: 1_000_000, completionTokens: 1_000_000 },
			"gpt-5.6-sol",
		);
		expect(cost).toBeCloseTo(35.0); // $5 input + $30 output
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
			"claude-sonnet-5",
		);
		expect(cost).toBeCloseTo(0.007, 5);
	});

	it("returns 0 when both token counts are 0", () => {
		const cost = computeCost(
			{ promptTokens: 0, completionTokens: 0 },
			"claude-sonnet-5",
		);
		expect(cost).toBe(0);
	});
});
