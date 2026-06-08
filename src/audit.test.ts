import { describe, expect, it, vi } from "vitest";

vi.mock("./review.js", async (orig) => {
	const actual = await orig<typeof import("./review.js")>();
	return { ...actual, runAgent: vi.fn() };
});
vi.mock("./prompt.js", () => ({
	buildAuditUserMessage: vi.fn(() => "USER_MSG"),
	buildAgentSystemPrompt: vi.fn(() => "SYS"),
	buildUserMessage: vi.fn(() => "U"),
}));

import { runAuditPass } from "./audit.js";
import { runAgent, TIER1_SKILLS } from "./review.js";
import type { ModelSelection } from "./router.js";
import { buildModelReview } from "./testing.js";

const selection: ModelSelection = {
	provider: "anthropic",
	model: "test-model",
};

describe("runAuditPass", () => {
	it("runs every Tier-1 skill and merges into one ModelReview", async () => {
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({
				event: "COMMENT",
				general_findings: [{ title: "F", body: "b", severity: "low" }],
				inline_comments: [],
			}),
			usage: { promptTokens: 1, completionTokens: 1 },
		});

		const merged = await runAuditPass({
			files: [{ path: "a.ts", content: "x" }],
			selection,
			extraInstructions: "",
			meta: { owner: "o", repo: "r", ref: "local" },
		});

		expect(runAgent).toHaveBeenCalledTimes(TIER1_SKILLS.length);
		expect(merged.general_findings).toHaveLength(1); // deduped by title
	});

	it("returns empty review when every agent fails", async () => {
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		const merged = await runAuditPass({
			files: [{ path: "a.ts", content: "x" }],
			selection,
			extraInstructions: "",
			meta: { owner: "o", repo: "r", ref: "local" },
		});
		expect(merged.general_findings).toHaveLength(0);
		expect(merged.inline_comments).toHaveLength(0);
	});
});
