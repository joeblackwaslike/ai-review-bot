import { describe, expect, it, vi } from "vitest";
import { judgesFor, modelCall, SPIKE_JUDGES } from "./model.js";
import type { SpikeItem } from "./types.js";
import { PaidCallError } from "./types.js";

const item = (producer: "anthropic" | "openai"): SpikeItem => ({
	id: "fx:a",
	fixtureId: "fx",
	producer,
	confirmed: true,
	label: "rejected",
	owner: "o",
	repo: "r",
	headSha: "sha",
	path: "src/a.ts",
	line: 3,
	severity: "P2",
	title: "Token cache never expires",
	text: "The cache keeps tokens forever.",
});

describe("judgesFor", () => {
	it("judges an Anthropic finding with OpenAI models, cheap then mid", () => {
		const judges = judgesFor(item("anthropic"), ["cheap", "mid"]);
		expect(judges.map((j) => [j.vendor, j.tier, j.model])).toEqual([
			["openai", "cheap", "gpt-6-luna"],
			["openai", "mid", "gpt-6.1-sol"],
		]);
	});

	it("judges an OpenAI finding with Anthropic models", () => {
		const judges = judgesFor(item("openai"), ["cheap", "mid"]);
		expect(judges.map((j) => [j.vendor, j.tier, j.model])).toEqual([
			["anthropic", "cheap", "claude-haiku-5-5"],
			["anthropic", "mid", "claude-sonnet-5-5"],
		]);
	});

	it("honours a single requested tier", () => {
		expect(judgesFor(item("openai"), ["mid"]).map((j) => j.tier)).toEqual([
			"mid",
		]);
	});

	it("gives each judge a distinct id", () => {
		const ids = Object.values(SPIKE_JUDGES).flatMap((byTier) =>
			Object.values(byTier).map((j) => j.id),
		);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("modelCall", () => {
	const judge = SPIKE_JUDGES.openai.cheap;
	const generate = vi.fn(async (_args: unknown) => ({
		object: {
			refuted: true,
			reason: "pure_style" as const,
			rationale: "style only",
		},
		usage: { inputTokens: 1_000_000, outputTokens: 0 },
	}));
	const deps = {
		generate: generate as never,
		resolveAuth: vi.fn(async () => ({}) as never),
		createModel: vi.fn(() => ({}) as never),
		costOf: vi.fn(() => 0.42),
	};

	it("sends the finding and the file and returns the verdict with its cost", async () => {
		const call = modelCall(deps);
		const result = await call({
			judge,
			item: item("anthropic"),
			fileText: "const x = 1;",
		});
		expect(result).toEqual({
			refuted: true,
			reason: "pure_style",
			rationale: "style only",
			costUsd: 0.42,
		});
		const sent = generate.mock.calls[0]?.[0] as { prompt: string };
		expect(sent.prompt).toContain("Token cache never expires");
		expect(sent.prompt).toContain("const x = 1;");
		expect(deps.costOf).toHaveBeenCalledWith(
			{
				promptTokens: 1_000_000,
				completionTokens: 0,
				cachedInputTokens: undefined,
			},
			"gpt-6-luna",
		);
	});

	it("authenticates each vendor once", async () => {
		deps.resolveAuth.mockClear();
		const call = modelCall(deps);
		await call({ judge, item: item("anthropic"), fileText: "a" });
		await call({ judge, item: item("anthropic"), fileText: "b" });
		expect(deps.resolveAuth).toHaveBeenCalledTimes(1);
	});

	it("costs nothing, not NaN, when the model has no price", async () => {
		const call = modelCall({ ...deps, costOf: () => undefined });
		const result = await call({
			judge,
			item: item("anthropic"),
			fileText: "a",
		});
		expect(result.costUsd).toBe(0);
	});

	it("keeps the cost of a generation that was paid for but failed validation", async () => {
		const { NoObjectGeneratedError } = await import("ai");
		const failing = vi.fn(async (_args: unknown) => {
			throw new NoObjectGeneratedError({
				message: "bad object",
				text: "{}",
				response: { id: "r", timestamp: new Date(), modelId: "m" },
				usage: { inputTokens: 500, outputTokens: 40 } as never,
				finishReason: "stop",
			});
		});
		const call = modelCall({
			...deps,
			generate: failing as never,
			costOf: () => 0.07,
		});
		const err = await call({
			judge,
			item: item("anthropic"),
			fileText: "a",
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PaidCallError);
		expect((err as PaidCallError).costUsd).toBe(0.07);
		expect((err as PaidCallError).message).toContain("bad object");
	});

	it("rethrows an error that carries no usage unchanged", async () => {
		const failing = vi.fn(async (_args: unknown) => {
			throw new Error("429 rate limited");
		});
		const call = modelCall({ ...deps, generate: failing as never });
		await expect(
			call({ judge, item: item("anthropic"), fileText: "a" }),
		).rejects.toThrow("429 rate limited");
		await expect(
			call({ judge, item: item("anthropic"), fileText: "a" }),
		).rejects.not.toBeInstanceOf(PaidCallError);
	});
});
