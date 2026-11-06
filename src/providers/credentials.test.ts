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
});
