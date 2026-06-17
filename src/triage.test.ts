import { describe, expect, it, vi } from "vitest";

const mockGenerateObject = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateObject: mockGenerateObject }));
vi.mock("./models.js", () => ({ createAIModel: vi.fn(() => ({})) }));

import { triageReReview } from "./triage.js";

const openFindings = [
	{
		id: "src/a.ts:5:bug",
		path: "src/a.ts",
		line: 5,
		title: "Bug",
		severity: "high",
		status: "open" as const,
	},
];

describe("triageReReview", () => {
	it("returns the model's SKIP decision with resolved ids", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: {
				recommendation: "SKIP",
				resolved: ["src/a.ts:5:bug"],
				newRisk: false,
			},
		});
		const d = await triageReReview(
			{ provider: "anthropic", model: "claude-haiku-4-5-20251001" } as never,
			"delta diff",
			openFindings,
		);
		expect(d).toEqual({
			recommendation: "SKIP",
			resolved: ["src/a.ts:5:bug"],
			newRisk: false,
		});
	});

	it("fails safe to INCREMENTAL (never SKIP) when the model call throws", async () => {
		mockGenerateObject.mockRejectedValueOnce(new Error("boom"));
		const d = await triageReReview(
			{ provider: "anthropic", model: "claude-haiku-4-5-20251001" } as never,
			"delta diff",
			openFindings,
		);
		expect(d.recommendation).toBe("INCREMENTAL");
		expect(d.resolved).toEqual([]);
	});
});
