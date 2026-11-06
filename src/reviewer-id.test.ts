import { describe, expect, it } from "vitest";
import { legacyProviderOf, reviewerFromLegacy } from "./reviewer-id.js";

describe("reviewer id mapping", () => {
	it.each([
		["claude", "anthropic"],
		["codex", "openai"],
		["gemini", "gemini"],
	])("round trips %s", (id, legacy) => {
		expect(legacyProviderOf(id)).toBe(legacy);
		expect(reviewerFromLegacy(legacy)).toBe(id);
	});

	it("passes gemini through unchanged", () => {
		expect(reviewerFromLegacy("gemini")).toBe("gemini");
	});

	it("does not resolve prototype keys", () => {
		expect(legacyProviderOf("constructor")).toBe("constructor");
		expect(reviewerFromLegacy("__proto__")).toBe("__proto__");
	});
});
