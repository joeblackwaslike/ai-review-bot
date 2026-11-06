import { describe, expect, it, vi } from "vitest";
import { resolveSelectionAuth, toLiveFindings } from "./live-wiring.js";

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
