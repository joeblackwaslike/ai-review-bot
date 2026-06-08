import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./review.js", async (orig) => {
	const actual = await orig<typeof import("./review.js")>();
	return { ...actual, runAgent: vi.fn() };
});
vi.mock("./prompt.js", () => ({
	buildAuditUserMessage: vi.fn(() => "USER_MSG"),
	buildAgentSystemPrompt: vi.fn(() => "SYS"),
	buildUserMessage: vi.fn(() => "U"),
}));
vi.mock("./sources.js", async (orig) => {
	const actual = await orig<typeof import("./sources.js")>();
	return { ...actual, collectFilesFromLocal: vi.fn() };
});
vi.mock("node:fs/promises", () => ({
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	readFile: vi.fn(),
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
	beforeEach(() => {
		vi.clearAllMocks();
	});

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

	it("splits files across batches when content exceeds BATCH_BYTES", async () => {
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			usage: { promptTokens: 1, completionTokens: 1 },
		});
		const largeFiles = [
			{ path: "huge1.ts", content: "x".repeat(100 * 1024) },
			{ path: "huge2.ts", content: "y".repeat(100 * 1024) },
		];
		await runAuditPass({
			files: largeFiles,
			selection,
			extraInstructions: "",
			meta: { owner: "o", repo: "r", ref: "local" },
		});
		// 2 batches × TIER1_SKILLS agents each
		expect(runAgent).toHaveBeenCalledTimes(TIER1_SKILLS.length * 2);
	});
});

describe("formatAuditJson", () => {
	it("emits untruncated {meta, review} with full inline bodies", async () => {
		const { formatAuditJson } = await import("./audit.js");
		const longBody = "x".repeat(500);
		const review = buildModelReview({
			event: "REQUEST_CHANGES",
			general_findings: [],
			inline_comments: [
				{
					title: "T",
					body: longBody,
					path: "a.ts",
					line: 3,
					start_line: null,
					suggestion: null,
				},
			],
		});
		const json = JSON.parse(
			formatAuditJson({
				review,
				meta: {
					owner: "o",
					repo: "r",
					ref: "local",
					provider: "anthropic",
					model: "m",
					fileCount: 1,
				},
			}),
		);
		expect(json.meta.provider).toBe("anthropic");
		expect(json.review.inline_comments[0].body).toHaveLength(500); // untruncated
	});
});

describe("runLocalAudit (dry-run)", () => {
	it("runs both providers and writes one artifact per provider", async () => {
		// Mock sources.collectFilesFromLocal
		const { collectFilesFromLocal } = await import("./sources.js");
		(collectFilesFromLocal as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ path: "a.ts", content: "x" },
		]);

		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({
				event: "COMMENT",
				general_findings: [],
				inline_comments: [],
			}),
			usage: { promptTokens: 1, completionTokens: 1 },
		});

		const fs = await import("node:fs/promises");
		const writeSpy = fs.writeFile as ReturnType<typeof vi.fn>;
		const mkdirSpy = fs.mkdir as ReturnType<typeof vi.fn>;
		writeSpy.mockResolvedValue(undefined);
		mkdirSpy.mockResolvedValue(undefined);

		const { runLocalAudit } = await import("./audit.js");
		const result = await runLocalAudit({
			cwd: "/repo",
			mode: "changed",
			outDir: ".ai-review",
			dryRun: true,
		});

		expect(result.providers.map((p) => p.provider).sort()).toEqual([
			"anthropic",
			"openai",
		]);
		expect(writeSpy).toHaveBeenCalled(); // audit-anthropic.json, audit-openai.json, audit.md
		expect(result.pr).toBeUndefined();
	});
});
