import { describe, expect, it } from "vitest";
import {
	SKILL_NAMES,
	TIER1_SKILL_FILES,
	TIER2_SKILL_FILES,
} from "./skill-names.js";
import { TIER2_DETECTORS } from "./tier2.js";

describe("skill-names", () => {
	it("TIER2_SKILL_FILES matches the tier 2 detectors", () => {
		expect(TIER2_SKILL_FILES).toEqual(TIER2_DETECTORS.map((d) => d.skillPath));
	});

	it("TIER1_SKILL_FILES lists the five tier 1 files", () => {
		expect(TIER1_SKILL_FILES).toEqual([
			"code-reviewer.md",
			"silent-failure-hunter.md",
			"pr-test-analyzer.md",
			"security-sast.md",
			"code-review-and-quality.md",
		]);
	});

	it("SKILL_NAMES holds base names without the extension", () => {
		expect(SKILL_NAMES.has("code-reviewer")).toBe(true);
		expect(SKILL_NAMES.has("architect-review")).toBe(true);
		expect(SKILL_NAMES.has("code-reviewer.md")).toBe(false);
	});
});
