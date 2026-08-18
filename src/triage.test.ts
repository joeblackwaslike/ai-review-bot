import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockCreateAIModel = vi.hoisted(() =>
	vi.fn((_selection?: unknown, _auth?: unknown) => ({})),
);
vi.mock("ai", () => ({ generateObject: mockGenerateObject }));
vi.mock("./models.js", () => ({ createAIModel: mockCreateAIModel }));

import type { DeltaFile } from "./triage.js";
import {
	COMPARE_FILE_CAP,
	isLikelyTruncated,
	triageReReview,
} from "./triage.js";

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

	// The gpt-5.1 rejection was confirmed only against the ChatGPT/Codex-account
	// subscription backend, not the raw API-key backend the hosted webhook bot
	// runs under — so API-key/unspecified triage calls (no authMode, or
	// "api-key") must keep gpt-5.1, the model known to work in production.
	it("routes openai triage calls to gpt-5.1 by default (api-key backend)", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { recommendation: "SKIP", resolved: [], newRisk: false },
		});
		await triageReReview(
			{ provider: "openai", model: "gpt-5.4-codex" } as never,
			"delta diff",
			openFindings,
		);
		expect(mockCreateAIModel).toHaveBeenCalledWith(
			{
				provider: "openai",
				model: "gpt-5.1",
				effort: "low",
			},
			undefined,
		);
	});

	// The ChatGPT-account Codex backend rejects gpt-5.1 outright (confirmed
	// live), and watch's re-review loop calls this triage gate on every push
	// under that OAuth-authenticated backend — a stale model name here breaks
	// every re-review, not just the first one.
	it("routes openai triage calls to gpt-5.4 under oauth auth", async () => {
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
			{ provider: "openai", model: "gpt-5.4-codex" } as never,
			"delta diff",
			openFindings,
			auth,
		);
		expect(mockCreateAIModel).toHaveBeenCalledWith(
			{
				provider: "openai",
				model: "gpt-5.4",
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
			{ provider: "anthropic", model: "claude-haiku-4-5-20251001" } as never,
			"delta diff",
			openFindings,
			auth,
		);
		expect(mockCreateAIModel.mock.calls.at(-1)?.[1]).toBe(auth);
	});

	// The schema must accept only bare open-finding ids and reject an echoed
	// "id — title" line (the format the prompt shows each finding in) — see
	// ai-review-bot-49n for the incident this protects against.
	it("constrains the resolved schema to the known open-finding ids, rejecting an id+title echo", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: {
				recommendation: "INCREMENTAL",
				resolved: ["src/a.ts:5:bug"],
				newRisk: false,
			},
		});
		await triageReReview(
			{ provider: "anthropic", model: "claude-haiku-4-5-20251001" } as never,
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
			{ provider: "anthropic", model: "claude-haiku-4-5-20251001" } as never,
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
