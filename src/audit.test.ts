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
vi.mock("./audit-pr.js", () => ({
	ensureOrphanBase: vi.fn(),
	createHeadBranch: vi.fn(),
	openDraftPr: vi.fn(async () => ({ number: 7, url: "U7" })),
	postProviderReview: vi.fn(),
	makeReady: vi.fn(),
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

describe("runLocalAudit (PR path)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("opens a PR and returns its number/url when findings exist", async () => {
		const { collectFilesFromLocal } = await import("./sources.js");
		(collectFilesFromLocal as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ path: "a.ts", content: "x" },
		]);
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [],
				inline_comments: [
					{
						title: "T",
						body: "b",
						path: "a.ts",
						line: 1,
						start_line: null,
						suggestion: null,
					},
				],
			}),
			usage: { promptTokens: 1, completionTokens: 1 },
		});
		const fs = await import("node:fs/promises");
		(fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(fs.mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const octokit = {
			request: vi.fn(async () => ({ data: { object: { sha: "HEAD_SHA" } } })),
		};

		const { runLocalAudit } = await import("./audit.js");
		const result = await runLocalAudit({
			cwd: "/repo",
			mode: "changed",
			outDir: ".ai-review",
			dryRun: false,
			resolvePr: async () => ({
				octokit: octokit as never,
				owner: "o",
				repo: "r",
				baseBranch: "main",
				postAs: [
					{ provider: "anthropic", prefix: "ai-review-bot" },
					{ provider: "openai", prefix: "codex-review-bot" },
				],
			}),
		});
		expect(result.pr).toBe(7);
		expect(result.url).toBe("U7");

		const auditPr = await import("./audit-pr.js");
		expect(auditPr.ensureOrphanBase).toHaveBeenCalled();
		expect(auditPr.createHeadBranch).toHaveBeenCalled();
		expect(auditPr.openDraftPr).toHaveBeenCalled();
		expect(auditPr.postProviderReview).toHaveBeenCalledTimes(2); // one per provider in postAs
	});

	it("falls back to artifacts only when branch creation 403s", async () => {
		const auditPr = await import("./audit-pr.js");
		(
			auditPr.createHeadBranch as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(
			Object.assign(new Error("no perms"), { status: 403 }),
		);
		const { collectFilesFromLocal } = await import("./sources.js");
		(collectFilesFromLocal as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ path: "a.ts", content: "x" },
		]);
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [{ title: "F", body: "b", severity: "high" }],
				inline_comments: [],
			}),
			usage: { promptTokens: 1, completionTokens: 1 },
		});
		const fs = await import("node:fs/promises");
		(fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(fs.mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const octokit = {
			request: vi.fn(async () => ({ data: [] })),
		};

		const { runLocalAudit } = await import("./audit.js");
		const result = await runLocalAudit({
			cwd: "/repo",
			mode: "changed",
			outDir: ".ai-review",
			dryRun: false,
			resolvePr: async () => ({
				octokit: octokit as never,
				owner: "o",
				repo: "r",
				baseBranch: "main",
				postAs: [],
			}),
		});
		expect(result.pr).toBeUndefined(); // degraded; artifacts still written
	});

	it("propagates non-403 errors instead of falling back", async () => {
		const auditPr = await import("./audit-pr.js");
		(
			auditPr.createHeadBranch as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }));
		const { collectFilesFromLocal } = await import("./sources.js");
		(collectFilesFromLocal as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ path: "a.ts", content: "x" },
		]);
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [{ title: "F", body: "b", severity: "high" }],
				inline_comments: [],
			}),
			usage: { promptTokens: 1, completionTokens: 1 },
		});
		const fs = await import("node:fs/promises");
		(fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(fs.mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const octokit = {
			request: vi.fn(async () => ({ data: [] })),
		};

		const { runLocalAudit } = await import("./audit.js");
		await expect(
			runLocalAudit({
				cwd: "/repo",
				mode: "changed",
				outDir: ".ai-review",
				dryRun: false,
				resolvePr: async () => ({
					octokit: octokit as never,
					owner: "o",
					repo: "r",
					baseBranch: "main",
					postAs: [],
				}),
			}),
		).rejects.toThrow();
	});
});
