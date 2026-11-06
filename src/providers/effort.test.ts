import { describe, expect, it } from "vitest";
import {
	anthropicOptions,
	googleOptions,
	mergeProviderOptions,
	openaiOptions,
	supportedEfforts,
} from "./effort.js";

describe("anthropicOptions", () => {
	it("sets effort and fallbacks", () => {
		expect(anthropicOptions("high", true)).toEqual({
			effort: "high",
			fallbacks: "default",
		});
	});
	it("returns undefined with nothing to send", () => {
		expect(anthropicOptions(undefined, false)).toBeUndefined();
	});
});

describe("openaiOptions", () => {
	it("forwards none", () => {
		expect(openaiOptions("none")).toEqual({ reasoningEffort: "none" });
	});
	it("returns undefined without effort", () => {
		expect(openaiOptions(undefined)).toBeUndefined();
	});
});

describe("googleOptions", () => {
	it("maps level", () => {
		expect(googleOptions("low")).toEqual({
			thinkingConfig: { thinkingLevel: "low", includeThoughts: false },
		});
	});
	it("maps none to minimal", () => {
		expect(googleOptions("none")?.thinkingConfig.thinkingLevel).toBe("minimal");
	});
	it("maps budget", () => {
		expect(googleOptions("medium", "budget")).toEqual({
			thinkingConfig: { thinkingBudget: 8192, includeThoughts: false },
		});
		expect(googleOptions("none", "budget")?.thinkingConfig.thinkingBudget).toBe(
			0,
		);
	});
	it("throws on unsupported effort, naming it", () => {
		expect(() => googleOptions("xhigh")).toThrow(/xhigh/);
		expect(() => googleOptions("max", "budget")).toThrow(/max/);
	});
	it("returns undefined without effort", () => {
		expect(googleOptions(undefined)).toBeUndefined();
	});
});

describe("supportedEfforts", () => {
	it("lists the sets per provider and control", () => {
		expect(supportedEfforts("anthropic")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(supportedEfforts("openai")).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		const google = ["none", "low", "medium", "high"];
		expect(supportedEfforts("google")).toEqual(google);
		expect(supportedEfforts("google", "level")).toEqual(google);
		expect(supportedEfforts("google", "budget")).toEqual(google);
	});
});

describe("mergeProviderOptions", () => {
	it("lets extra override the computed block per key", () => {
		const base = googleOptions("high");
		expect(
			mergeProviderOptions(
				{ google: base ?? {} },
				{ google: { thinkingConfig: { thinkingBudget: 42 } } },
			),
		).toEqual({ google: { thinkingConfig: { thinkingBudget: 42 } } });
	});
	it("keeps other keys and handles undefined sides", () => {
		expect(
			mergeProviderOptions({ openai: { a: 1 } }, { openai: { b: 2 } }),
		).toEqual({ openai: { a: 1, b: 2 } });
		expect(mergeProviderOptions(undefined, undefined)).toBeUndefined();
		expect(mergeProviderOptions(undefined, { x: { y: 1 } })).toEqual({
			x: { y: 1 },
		});
	});
});
