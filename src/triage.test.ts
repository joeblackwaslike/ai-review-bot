import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockCreateAIModel = vi.hoisted(() =>
	vi.fn((_selection?: unknown, _auth?: unknown) => ({})),
);
vi.mock("ai", () => ({ generateObject: mockGenerateObject }));
vi.mock("./models.js", () => ({ createAIModel: mockCreateAIModel }));

import { buildStrictOctokit } from "./testing.js";
import type { DeltaFile } from "./triage.js";
import {
	COMPARE_FILE_CAP,
	fetchDeltaMeta,
	isLikelyTruncated,
	revalidateFindings,
	triageReReview,
} from "./triage.js";

const openFindings = [
	{
		id: "src/a.ts:5:bug",
		path: "src/a.ts",
		line: 5,
		title: "Bug",
		severity: "P1",
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
			{ provider: "anthropic", model: "claude-haiku-5-5" } as never,
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
			{ provider: "anthropic", model: "claude-haiku-5-5" } as never,
			"delta diff",
			openFindings,
		);
		expect(d.recommendation).toBe("INCREMENTAL");
		expect(d.resolved).toEqual([]);
	});

	// gpt-6-luna is confirmed available on both the API-key and
	// OAuth/subscription backends, so triage no longer needs an auth-mode
	// split — no-auth and explicit-oauth calls must resolve identically.
	it("routes openai triage calls to gpt-6-luna by default (api-key backend)", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { recommendation: "SKIP", resolved: [], newRisk: false },
		});
		await triageReReview(
			{ provider: "openai", model: "gpt-6.1-sol" } as never,
			"delta diff",
			openFindings,
		);
		expect(mockCreateAIModel).toHaveBeenCalledWith(
			{
				provider: "openai",
				model: "gpt-6-luna",
				effort: "low",
			},
			undefined,
		);
	});

	it("routes anthropic triage calls to claude-haiku-5-5 at low effort with a reasoning-sized cap", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { recommendation: "SKIP", resolved: [], newRisk: false },
		});
		await triageReReview(
			{ provider: "anthropic", model: "claude-sonnet-5-5" } as never,
			"delta diff",
			openFindings,
		);
		expect(mockCreateAIModel).toHaveBeenCalledWith(
			{ provider: "anthropic", model: "claude-haiku-5-5", effort: "low" },
			undefined,
		);
		// Haiku 5.5 bills thinking against maxOutputTokens; a 2000 cap can starve
		// the structured object (AI_NoObjectGeneratedError).
		expect(mockGenerateObject.mock.lastCall?.[0].maxOutputTokens).toBe(16000);
	});

	// watch's re-review loop calls this triage gate on every push under the
	// OAuth-authenticated backend — a stale model name here breaks every
	// re-review, not just the first one.
	it("routes openai triage calls to gpt-6-luna under oauth auth too", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { recommendation: "SKIP", resolved: [], newRisk: false },
		});
		const auth = {
			mode: "oauth" as const,
			provider: "openai" as const,
			token: "t",
			baseURL: "https://example.test",
			headers: {},
			fetch: (async () => new Response()) as typeof fetch,
		};
		await triageReReview(
			{ provider: "openai", model: "gpt-6.1-sol" } as never,
			"delta diff",
			openFindings,
			auth,
		);
		expect(mockCreateAIModel).toHaveBeenCalledWith(
			{
				provider: "openai",
				model: "gpt-6-luna",
				effort: "low",
			},
			auth,
		);
	});

	// anthropicreviewbot/chatgpt-codex-connector finding on PR #65: watch's
	// re-review loop runs under subscription auth with no funded
	// ANTHROPIC_API_KEY/OPENAI_API_KEY. Before this fix, triageReReview only
	// received the derived `authMode` string (for gpt-5.1 vs gpt-5.4 model
	// selection) and never passed the resolved ResolvedAuth object itself to
	// createAIModel — so createAIModel's `auth` param was always undefined
	// here, and the triage request would attempt an unauthenticated model
	// call, throw, and the catch in triageReReview silently converts that to
	// a fail-safe INCREMENTAL — masking every triage call under watch as a
	// (misleadingly "safe") failure instead of actually triaging.
	it("passes the resolved auth object through to createAIModel, not just the derived mode", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { recommendation: "SKIP", resolved: [], newRisk: false },
		});
		const auth = {
			mode: "oauth" as const,
			provider: "anthropic" as const,
			token: "t",
			baseURL: "https://example.test",
			headers: {},
			fetch: (async () => new Response()) as typeof fetch,
		};
		await triageReReview(
			{ provider: "anthropic", model: "claude-haiku-5-5" } as never,
			"delta diff",
			openFindings,
			auth,
		);
		expect(mockCreateAIModel.mock.calls.at(-1)?.[1]).toBe(auth);
	});

	// The schema must accept only bare open-finding ids and reject an echoed
	// "id — title" line: the prompt shows each finding as "id — title", so a
	// model that judges it resolved naturally echoes that whole line back
	// instead of isolating the bare id.
	it("constrains the resolved schema to the known open-finding ids, rejecting an id+title echo", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: {
				recommendation: "INCREMENTAL",
				resolved: ["src/a.ts:5:bug"],
				newRisk: false,
			},
		});
		await triageReReview(
			{ provider: "anthropic", model: "claude-haiku-5-5" } as never,
			"delta diff",
			openFindings,
		);
		const { schema } = mockGenerateObject.mock.calls.at(-1)?.[0] as {
			schema: z.ZodTypeAny;
		};

		expect(
			schema.safeParse({
				recommendation: "INCREMENTAL",
				resolved: ["src/a.ts:5:bug"],
				newRisk: false,
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				recommendation: "INCREMENTAL",
				resolved: ["src/a.ts:5:bug — Bug"],
				newRisk: false,
			}).success,
		).toBe(false);
	});

	it("constrains resolved to an empty array when there are no open findings to resolve", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { recommendation: "INCREMENTAL", resolved: [], newRisk: true },
		});
		await triageReReview(
			{ provider: "anthropic", model: "claude-haiku-5-5" } as never,
			"some new diff with no prior findings",
			[],
		);
		const { schema } = mockGenerateObject.mock.calls.at(-1)?.[0] as {
			schema: z.ZodTypeAny;
		};

		expect(
			schema.safeParse({
				recommendation: "INCREMENTAL",
				resolved: [],
				newRisk: true,
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				recommendation: "INCREMENTAL",
				resolved: ["anything"],
				newRisk: true,
			}).success,
		).toBe(false);
	});
});

function makeFiles(n: number): DeltaFile[] {
	return Array.from({ length: n }, (_, i) => ({
		filename: `src/file${i}.ts`,
		status: "modified",
	}));
}

describe("isLikelyTruncated", () => {
	it("returns false for an empty file list", () => {
		expect(isLikelyTruncated([])).toBe(false);
	});

	it("returns false for fewer than COMPARE_FILE_CAP files", () => {
		expect(isLikelyTruncated(makeFiles(COMPARE_FILE_CAP - 1))).toBe(false);
	});

	it("returns true at exactly COMPARE_FILE_CAP files", () => {
		expect(isLikelyTruncated(makeFiles(COMPARE_FILE_CAP))).toBe(true);
	});

	it("returns true for more than COMPARE_FILE_CAP files", () => {
		expect(isLikelyTruncated(makeFiles(COMPARE_FILE_CAP + 50))).toBe(true);
	});
});

const SEL = { provider: "anthropic", model: "claude-haiku-5-5" } as never;
const COMPARE = "GET /repos/{owner}/{repo}/compare/{basehead}";

describe("fetchDeltaMeta compare outcomes", () => {
	it("passes basehead old...new and returns status", async () => {
		const octokit = buildStrictOctokit({
			[COMPARE]: (p) => {
				expect(p).toEqual({ owner: "o", repo: "r", basehead: "old...new" });
				return {
					status: "ahead",
					files: [{ filename: "a.ts", status: "modified", patch: "p" }],
				};
			},
		});
		const meta = await fetchDeltaMeta(octokit, "o", "r", "old", "new");
		expect(meta).toMatchObject({ status: "ahead", truncated: false });
		expect(meta?.diff).toContain("FILE: a.ts");
	});

	it("returns null when the compare request throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const octokit = buildStrictOctokit({
			[COMPARE]: () => {
				throw Object.assign(new Error("Not Found"), { status: 404 });
			},
		});
		expect(await fetchDeltaMeta(octokit, "o", "r", "old", "new")).toBeNull();
		expect(warn).toHaveBeenCalledWith(expect.any(String), {
			owner: "o",
			repo: "r",
			basehead: "old...new",
			status: 404,
			reason: "Not Found",
		});
		warn.mockRestore();
	});

	it("returns null when status is diverged", async () => {
		const octokit = buildStrictOctokit({
			[COMPARE]: () => ({ status: "diverged", files: [] }),
		});
		expect(await fetchDeltaMeta(octokit, "o", "r", "old", "new")).toBeNull();
	});
});

describe("revalidateFindings", () => {
	const f = (id: string, path: string | null = null) => ({
		id,
		path,
		line: 1,
		title: id,
		severity: "P1",
		status: "open" as const,
	});

	it("sends a path-bearing finding with only its named file's patch", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { recommendation: "SKIP", resolved: ["a"], newRisk: false },
		});
		const out = await revalidateFindings(
			SEL,
			[f("a", "a.ts"), f("c", "c.ts")],
			[
				{ filename: "a.ts", status: "modified", patch: "PATCH_A" },
				{ filename: "z.ts", status: "modified", patch: "PATCH_Z" },
			],
		);
		expect(out).toEqual(["a"]);
		const { prompt } = mockGenerateObject.mock.calls.at(-1)?.[0] as {
			prompt: string;
		};
		expect(prompt).toContain("PATCH_A");
		expect(prompt).not.toContain("PATCH_Z");
		expect(prompt).not.toContain("c.ts");
	});

	it("sends a path-less finding with the PR's patches in file order", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { resolved: ["nopath"] },
		});
		const out = await revalidateFindings(
			SEL,
			[f("a", "a.ts"), f("nopath")],
			[
				{ filename: "z.ts", status: "modified", patch: "PATCH_Z" },
				{ filename: "a.ts", status: "modified", patch: "PATCH_A" },
				{ filename: "m.ts", status: "modified", patch: "PATCH_M" },
			],
		);
		expect(out).toEqual(["nopath"]);
		const { prompt } = mockGenerateObject.mock.calls.at(-1)?.[0] as {
			prompt: string;
		};
		expect(prompt).toContain("- nopath \u2014");
		expect(prompt.match(/PATCH_A/g)).toHaveLength(1);
		expect(prompt.indexOf("PATCH_Z")).toBeLessThan(prompt.indexOf("PATCH_M"));
	});

	it("leaves a path-less finding carried when the PR's patches exceed the cap", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { resolved: [] },
		});
		const files = ["a", "b", "c"].map((n) => ({
			filename: `${n}.ts`,
			status: "modified",
			patch: n.repeat(25000),
		}));
		await revalidateFindings(SEL, [f("a.ts", "a.ts"), f("nopath")], files);
		const { prompt } = mockGenerateObject.mock.calls.at(-1)?.[0] as {
			prompt: string;
		};
		const patchChars = prompt.match(/[abc]{1000,}/g)?.join("").length ?? 0;
		expect(patchChars).toBeLessThanOrEqual(60000);
		expect(prompt).toContain("FILE: a.ts");
		expect(prompt).not.toContain("nopath");
	});

	it("returns [] on model error for a path-less finding", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		mockGenerateObject.mockClear();
		mockGenerateObject.mockRejectedValueOnce(new Error("boom"));
		expect(
			await revalidateFindings(
				SEL,
				[f("nopath")],
				[{ filename: "a.ts", status: "modified", patch: "p" }],
			),
		).toEqual([]);
		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		err.mockRestore();
	});

	it("stays under the character cap", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { recommendation: "SKIP", resolved: [], newRisk: false },
		});
		const files = ["a", "b", "c", "d"].map((n) => ({
			filename: `${n}.ts`,
			status: "modified",
			patch: n.repeat(30000),
		}));
		await revalidateFindings(
			SEL,
			files.map((x) => f(x.filename, x.filename)),
			files,
		);
		const { prompt } = mockGenerateObject.mock.calls.at(-1)?.[0] as {
			prompt: string;
		};
		const patchChars =
			prompt
				.split("\n")
				.join("")
				.match(/[abcd]{1000,}/g)
				?.join("").length ?? 0;
		expect(patchChars).toBeLessThanOrEqual(60000);
		expect(prompt).not.toContain("FILE: d.ts");
		expect(prompt).not.toContain("- d.ts \u2014");
		expect(prompt).not.toContain("- c.ts \u2014");
		expect(prompt).toContain("- a.ts \u2014");
		expect(prompt).toContain("FILE: a.ts");
	});

	it("makes no model call when nothing is sendable", async () => {
		mockGenerateObject.mockClear();
		expect(await revalidateFindings(SEL, [f("nopath")], [])).toEqual([]);
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("returns [] on model error", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		mockGenerateObject.mockRejectedValueOnce(new Error("boom"));
		expect(
			await revalidateFindings(
				SEL,
				[f("a", "a.ts")],
				[{ filename: "a.ts", status: "modified", patch: "p" }],
			),
		).toEqual([]);
		err.mockRestore();
	});
});
