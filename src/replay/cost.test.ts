import { describe, expect, it } from "vitest";
import { roundCostUsd, usageSummary } from "./cost.js";
import type { RoundUsage } from "./types.js";

const usage: RoundUsage = {
	"a.md": {
		promptTokens: 1_000_000,
		completionTokens: 100_000,
		cachedInputTokens: 500_000,
		reasoningTokens: 10,
	},
	"b.md": { promptTokens: 1_000_000, completionTokens: 0 },
};

describe("roundCostUsd", () => {
	it("sums per-skill cost with cache pricing", () => {
		// a: 0.5M*2 + 0.5M*0.2 + 0.1M*10 = 2.1 ; b: 2.0
		expect(roundCostUsd(usage, "claude-sonnet-5-5")).toBeCloseTo(4.1);
	});

	it("is unavailable for an unknown model and 0 for empty usage", () => {
		expect(roundCostUsd(usage, "nope")).toBeUndefined();
		expect(roundCostUsd({}, "claude-sonnet-5-5")).toBe(0);
	});
});

describe("usageSummary", () => {
	it("totals prompt, cached, completion and reasoning", () => {
		expect(usageSummary(usage)).toEqual({
			promptTokens: 2_000_000,
			cachedInputTokens: 500_000,
			completionTokens: 100_000,
			reasoningTokens: 10,
		});
	});
});
