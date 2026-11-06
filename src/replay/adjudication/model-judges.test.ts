import { describe, expect, it, vi } from "vitest";
import type { ResolvedAuth } from "../../auth.js";

const generate = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateObject: generate }));
vi.mock("../../models.js", () => ({ createAIModel: () => ({}) }));

import { MAX_AUDIT_DIFF_CHARS, modelAuditJudge } from "./model-judges.js";

const judge = () =>
	modelAuditJudge(
		{ provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
		{} as ResolvedAuth,
	);

describe("modelAuditJudge", () => {
	it("refuses a diff over the limit instead of cutting it, before any model call", async () => {
		generate.mockReset();
		const size = MAX_AUDIT_DIFF_CHARS + 1;
		await expect(
			judge().run({ diff: "x".repeat(size), claims: [] }),
		).rejects.toThrow(String(size));
		expect(generate).not.toHaveBeenCalled();
	});

	it("sends a diff at the limit whole", async () => {
		generate.mockReset();
		generate.mockResolvedValue({ object: { findings: [] } });
		await judge().run({ diff: "x".repeat(MAX_AUDIT_DIFF_CHARS), claims: [] });
		const prompt = generate.mock.calls[0]?.[0].prompt as string;
		expect(prompt).toContain("x".repeat(MAX_AUDIT_DIFF_CHARS));
	});
});
