import { describe, expect, it } from "vitest";
import { tuningFor } from "./reviewer-tuning.js";

describe("tuningFor", () => {
	// These landed because anthropicreviewbot filed rounds of non-defect findings
	// on PRs it had already reviewed. codexreviewbot was not doing that.
	it("turns the signal-quality changes on for anthropic", () => {
		expect(tuningFor("anthropic")).toEqual({
			dedupeNearDuplicateClaims: true,
			showPriorOwnFindings: true,
			strictEvidenceRules: true,
		});
	});

	// Changing a reviewer that works, on the evidence of one that does not, is
	// how the good one stops working.
	it("leaves openai on the behaviour it had before this shipped", () => {
		expect(tuningFor("openai")).toEqual({
			dedupeNearDuplicateClaims: false,
			showPriorOwnFindings: false,
			strictEvidenceRules: false,
		});
	});
});
