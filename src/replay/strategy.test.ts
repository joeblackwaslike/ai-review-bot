import { beforeEach, describe, expect, it } from "vitest";
import {
	getStrategy,
	type ReviewStrategy,
	registerStrategy,
	resetStrategiesForTest,
	strategyNames,
	UnknownStrategyError,
} from "./strategy.js";

function stub(name: string): ReviewStrategy {
	return {
		name,
		version: "1",
		needsCheckout: false,
		estimateCost: () => 0,
		run: async () => ({
			findings: [],
			candidates: [],
			posted: [],
			usage: {},
			toolCalls: [],
			agentReviews: [],
			wallMs: 0,
		}),
	};
}

describe("strategy registry", () => {
	beforeEach(() => resetStrategiesForTest());

	it("returns a registered strategy", () => {
		const s = stub("a");
		registerStrategy(s);
		expect(getStrategy("a")).toBe(s);
	});

	it("throws UnknownStrategyError naming every registered strategy", () => {
		registerStrategy(stub("beta"));
		registerStrategy(stub("alpha"));
		expect(() => getStrategy("nope")).toThrow(UnknownStrategyError);
		expect(() => getStrategy("nope")).toThrow(/alpha.*beta/);
	});

	it("rejects duplicate registration", () => {
		registerStrategy(stub("a"));
		expect(() => registerStrategy(stub("a"))).toThrow(/already registered/);
	});

	it("lists names sorted", () => {
		registerStrategy(stub("b"));
		registerStrategy(stub("a"));
		expect(strategyNames()).toEqual(["a", "b"]);
	});
});
