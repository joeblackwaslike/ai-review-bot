import { describe, expect, it, vi } from "vitest";

vi.mock("../router.js", async (orig) => ({
	...(await orig<typeof import("../router.js")>()),
	routeReviewerModel: vi.fn(),
}));
vi.mock("../auth.js", async (orig) => ({
	...(await orig<typeof import("../auth.js")>()),
	resolveAnthropicAuth: vi.fn(),
	resolveOpenAIAuth: vi.fn(),
}));
vi.mock("../audit.js", async (orig) => ({
	...(await orig<typeof import("../audit.js")>()),
	runAuditPass: vi.fn(),
}));

import { runAuditPass } from "../audit.js";
import { resolveAnthropicAuth, resolveOpenAIAuth } from "../auth.js";
import { routeReviewerModel } from "../router.js";
import type { GhClient } from "./gh.js";
import {
	buildLiveWiring,
	resolveSelectionAuth,
	toLiveFindings,
} from "./live-wiring.js";
import { makeFixture } from "./testkit.js";

describe("toLiveFindings", () => {
	const finding = {
		category: "style" as const,
		confidence: 0.8,
		evidence: "See diff.",
		suppressible: true,
	};

	it("carries body, severity and suppressible from inline and general findings", () => {
		const out = toLiveFindings({
			event: "COMMENT",
			inline_comments: [
				{
					...finding,
					title: "Inline",
					body: "inline body",
					severity: "P2",
					path: "src/a.ts",
					line: 7,
					start_line: null,
					suggestion: null,
				},
			],
			general_findings: [
				{
					...finding,
					title: "General",
					body: "general body",
					severity: "P0",
					suppressible: false,
				},
			],
		});
		expect(out).toEqual([
			{
				title: "Inline",
				path: "src/a.ts",
				line: 7,
				body: "inline body",
				severity: "P2",
				suppressible: true,
			},
			{
				title: "General",
				path: null,
				line: null,
				body: "general body",
				severity: "P0",
				suppressible: false,
			},
		]);
	});
});

describe("resolveSelectionAuth", () => {
	const deps = () => ({
		anthropic: vi.fn().mockResolvedValue({ provider: "anthropic" }),
		openai: vi.fn().mockResolvedValue({ provider: "openai" }),
	});

	it("resolves anthropic and openai selections exactly as before", async () => {
		const d = deps();
		await expect(resolveSelectionAuth("anthropic", d)).resolves.toEqual({
			provider: "anthropic",
		});
		await expect(resolveSelectionAuth("openai", d)).resolves.toEqual({
			provider: "openai",
		});
		expect(d.anthropic).toHaveBeenCalledTimes(1);
		expect(d.openai).toHaveBeenCalledTimes(1);
	});

	it("a google selection with no key names the missing env var and uses no other credential", async () => {
		const d = deps();
		await expect(resolveSelectionAuth("google", d, {})).rejects.toThrow(
			/GOOGLE_GENERATIVE_AI_API_KEY/,
		);
		expect(d.anthropic).not.toHaveBeenCalled();
		expect(d.openai).not.toHaveBeenCalled();
	});

	it("a google selection with a key resolves to the registry path", async () => {
		const d = deps();
		await expect(
			resolveSelectionAuth("google", d, { GOOGLE_GENERATIVE_AI_API_KEY: "k" }),
		).resolves.toBeUndefined();
	});
});

describe("buildLiveWiring review auth", () => {
	const emptyReview = {
		event: "COMMENT" as const,
		inline_comments: [],
		general_findings: [],
	};

	function wiringFor(provider: string, model: string) {
		vi.mocked(routeReviewerModel).mockReturnValue({
			selection: { provider, model },
			tier: "normal",
		} as never);
		vi.mocked(resolveAnthropicAuth)
			.mockReset()
			.mockResolvedValue({
				provider: "anthropic",
			} as never);
		vi.mocked(resolveOpenAIAuth)
			.mockReset()
			.mockResolvedValue({
				provider: "openai",
			} as never);
		vi.mocked(runAuditPass)
			.mockReset()
			.mockResolvedValue({ review: emptyReview } as never);
		return buildLiveWiring(makeFixture([["a"]]), {} as GhClient);
	}

	it("a google selection with no key errors naming the env var and receives no other provider's credentials", async () => {
		const saved = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
		delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
		try {
			const w = wiringFor("google", "gemini-3-pro");
			await expect(w.review("diff")).rejects.toThrow(
				/GOOGLE_GENERATIVE_AI_API_KEY/,
			);
			expect(resolveAnthropicAuth).not.toHaveBeenCalled();
			expect(resolveOpenAIAuth).not.toHaveBeenCalled();
			expect(runAuditPass).not.toHaveBeenCalled();
		} finally {
			if (saved !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = saved;
		}
	});

	it("a google selection with a key runs with undefined auth", async () => {
		const saved = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
		process.env.GOOGLE_GENERATIVE_AI_API_KEY = "k";
		try {
			const w = wiringFor("google", "gemini-3-pro");
			await w.review("diff");
			expect(vi.mocked(runAuditPass).mock.calls[0][0].auth).toBeUndefined();
			expect(resolveOpenAIAuth).not.toHaveBeenCalled();
		} finally {
			if (saved === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
			else process.env.GOOGLE_GENERATIVE_AI_API_KEY = saved;
		}
	});

	it("anthropic and openai selections resolve their own auth as before", async () => {
		await wiringFor("anthropic", "m").review("diff");
		expect(vi.mocked(runAuditPass).mock.calls[0][0].auth).toEqual({
			provider: "anthropic",
		});
		await wiringFor("openai", "m").review("diff");
		expect(vi.mocked(runAuditPass).mock.calls[0][0].auth).toEqual({
			provider: "openai",
		});
	});
});
