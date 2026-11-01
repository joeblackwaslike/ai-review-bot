import { describe, expect, it } from "vitest";
import { ADVISORY_SKILLS, capAdvisory } from "./advisory.js";
import { buildInlineComment, buildModelReview } from "./testing.js";

const general = (severity: "P0" | "P1" | "P2" | "P3") => ({
	title: "Layering",
	body: "Split it.",
	severity,
	category: "architecture" as const,
	confidence: 0.8,
	evidence: "See diff.",
	suppressible: false,
});

describe("capAdvisory", () => {
	it("lowers P0 and P1 to P2, tags every finding and forces COMMENT", () => {
		const out = capAdvisory(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [general("P1")],
				inline_comments: [buildInlineComment({ severity: "P0" })],
			}),
		);
		expect(out.event).toBe("COMMENT");
		expect(out.general_findings[0]).toMatchObject({
			severity: "P2",
			advisory: true,
		});
		expect(out.inline_comments[0]).toMatchObject({
			severity: "P2",
			advisory: true,
		});
	});

	it("keeps P2 and P3 severities", () => {
		const out = capAdvisory(
			buildModelReview({ general_findings: [general("P3"), general("P2")] }),
		);
		expect(out.general_findings.map((f) => f.severity)).toEqual(["P3", "P2"]);
	});

	it("names the quality and architecture skills only", () => {
		expect([...ADVISORY_SKILLS].sort()).toEqual([
			"architect-review.md",
			"code-review-and-quality.md",
		]);
	});
});
