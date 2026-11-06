import { describe, expect, it } from "vitest";
import { resolveProviderCredentials } from "./credentials.js";

describe("resolveProviderCredentials", () => {
	it("reads the standard google key", () => {
		expect(
			resolveProviderCredentials("google", {
				GOOGLE_GENERATIVE_AI_API_KEY: "k",
			}),
		).toEqual({ apiKey: "k" });
	});

	it("treats a blank value as unset", () => {
		expect(
			resolveProviderCredentials("anthropic", { ANTHROPIC_API_KEY: "  " }),
		).toEqual({});
	});

	it("returns the derived-name key first, then the standard name", () => {
		expect(
			resolveProviderCredentials("openai", {
				OPENAI_API_KEY: "std",
				AI_REVIEW_PROVIDERS__OPENAI__API_KEY: "derived",
			}),
		).toEqual({ apiKey: "derived" });
	});

	it("adds baseURL from the providers block", () => {
		expect(
			resolveProviderCredentials(
				"google",
				{ GOOGLE_GENERATIVE_AI_API_KEY: "k" },
				{ google: { baseURL: "https://proxy.example" } },
			),
		).toEqual({ apiKey: "k", baseURL: "https://proxy.example" });
	});
});
