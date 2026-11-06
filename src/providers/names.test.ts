import { describe, expect, it } from "vitest";
import { isProviderName, splitModelId } from "./names.js";

describe("isProviderName", () => {
	it("accepts the supported providers only", () => {
		expect(isProviderName("google")).toBe(true);
		expect(isProviderName("gemini")).toBe(false);
	});
});

describe("splitModelId", () => {
	it("splits provider and model", () => {
		expect(splitModelId("google/gemini-3.8-flash")).toEqual({
			provider: "google",
			model: "gemini-3.8-flash",
		});
	});

	it("throws naming the id when there is no provider prefix", () => {
		expect(() => splitModelId("claude-sonnet-5-5")).toThrow(
			/claude-sonnet-5-5/,
		);
	});

	it("throws naming the id and allowed providers for an unknown provider", () => {
		expect(() => splitModelId("moonshot/kimi")).toThrow(/moonshot\/kimi/);
		expect(() => splitModelId("moonshot/kimi")).toThrow(
			/anthropic, openai, google/,
		);
	});
});
