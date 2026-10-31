import { describe, expect, it } from "vitest";
import { findingId, parseBodyFindings } from "./review-state.js";

describe("parseBodyFindings", () => {
	it("returns the rows of a review body", () => {
		const body = [
			"<!-- ai-review:sha=abc1234567890 -->",
			"| Sev | Category | Finding |",
			"|---|---|---|",
			"| 🟠 | bug | **Missing null check** |",
			"| 🟡 | **Unused import** |",
		].join("\n");
		expect(parseBodyFindings(body)).toEqual([
			{
				id: findingId(null, null, "Missing null check"),
				path: null,
				line: null,
				title: "Missing null check",
				severity: "P1",
				status: "open",
			},
			{
				id: findingId(null, null, "Unused import"),
				path: null,
				line: null,
				title: "Unused import",
				severity: "P2",
				status: "open",
			},
		]);
	});
});
