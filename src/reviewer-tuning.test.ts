import { describe, expect, it } from "vitest";
import { REVIEWER_TUNING } from "./reviewer-tuning.js";

describe("REVIEWER_TUNING", () => {
	// These landed anthropic-only because anthropicreviewbot filed rounds of
	// non-defect findings on PRs it had already reviewed while codexreviewbot
	// was not doing that (measured across #43/#45). PR #44 (2026-08-09)
	// overturned that premise: codexreviewbot independently produced the same
	// class of unfounded, confidently-false findings (a fabricated
	// compilation-break claim, a fabricated invalid-JSON claim), so the
	// signal-quality settings are provider-agnostic prompt/merge mechanics —
	// unified for both providers rather than re-forking per bot.
	it("turns the signal-quality changes on unconditionally", () => {
		expect(REVIEWER_TUNING).toEqual({
			dedupeNearDuplicateClaims: true,
			showPriorOwnFindings: true,
			strictEvidenceRules: true,
		});
	});
});
