import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeKv } from "./feedback/kv.fake.js";
import {
	clearPriceTable,
	FETCH_RETRY_MS,
	lookupPrice,
	normalizeModelId,
	parseOpenRouterPrices,
	primePrices,
	setPriceTable,
} from "./pricing.js";

const SAMPLE = {
	data: [
		{
			id: "anthropic/claude-sonnet-5.5",
			pricing: {
				prompt: "0.000002",
				completion: "0.00001",
				input_cache_read: "0.0000001",
			},
		},
		{
			id: "anthropic/claude-haiku-5.5",
			pricing: {
				prompt: "0.0000001",
				completion: "0.0000005",
				input_cache_read: "0.00000001",
				overrides: [
					{
						min_prompt_tokens: 100000,
						prompt: "0.0000005",
						completion: "0.0000025",
						input_cache_read: "0.00000005",
					},
				],
			},
		},
		{
			id: "anthropic/claude-sonnet-5.5:batch",
			pricing: { prompt: "0.000001", completion: "0.000005" },
		},
		{
			id: "~anthropic/claude-latest",
			pricing: { prompt: "1", completion: "1" },
		},
		{
			id: "openai/no-cache",
			pricing: { prompt: "0.000003", completion: "0.000006" },
		},
		{ id: "bad/entry", pricing: { prompt: "abc", completion: "1" } },
		{ id: 42 },
		null,
	],
};

function okFetch(body: unknown = SAMPLE) {
	return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => {
	clearPriceTable();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("normalizeModelId", () => {
	it("lowercases and maps dots to dashes", () => {
		expect(normalizeModelId("Anthropic/Claude-Sonnet-5.5")).toBe(
			"anthropic/claude-sonnet-5-5",
		);
		expect(normalizeModelId("claude-sonnet-5.5")).toBe(
			normalizeModelId("claude-sonnet-5-5"),
		);
	});
});

describe("parseOpenRouterPrices", () => {
	const table = parseOpenRouterPrices(SAMPLE);

	it("converts per-token strings to USD per million", () => {
		expect(table["anthropic/claude-sonnet-5-5"]).toMatchObject({
			input: 2,
			cachedInput: 0.1,
			output: 10,
		});
	});

	it("skips batch, tilde and malformed entries without throwing", () => {
		expect(Object.keys(table).sort()).toEqual([
			"anthropic/claude-haiku-5-5",
			"anthropic/claude-sonnet-5-5",
			"openai/no-cache",
		]);
		expect(parseOpenRouterPrices(null)).toEqual({});
		expect(parseOpenRouterPrices({ data: "x" })).toEqual({});
	});

	it("falls back cachedInput to input", () => {
		expect(table["openai/no-cache"]?.cachedInput).toBe(3);
	});

	it("keeps tier overrides", () => {
		expect(table["anthropic/claude-haiku-5-5"]?.tiers).toEqual([
			{ minPromptTokens: 100000, input: 0.5, cachedInput: 0.05, output: 2.5 },
		]);
	});
});

describe("lookupPrice", () => {
	beforeEach(() => setPriceTable(parseOpenRouterPrices(SAMPLE)));

	it("matches dotted and dashed ids, full or bare", () => {
		expect(lookupPrice("claude-sonnet-5.5", 10)?.input).toBe(2);
		expect(lookupPrice("anthropic/claude-sonnet-5-5", 10)?.input).toBe(2);
	});

	it("selects the tier by prompt size", () => {
		expect(lookupPrice("claude-haiku-5-5", 100000)?.input).toBeCloseTo(0.5);
		expect(lookupPrice("claude-haiku-5-5", 99999)?.input).toBeCloseTo(0.1);
	});

	it("does not guess a vendor for a provider-qualified id", () => {
		setPriceTable({
			"openai/shared-model": { input: 1, cachedInput: 1, output: 1 },
			"other/shared-model": { input: 9, cachedInput: 9, output: 9 },
		});
		expect(lookupPrice("other/shared-model", 1)?.input).toBe(9);
		expect(lookupPrice("openai/shared-model", 1)?.input).toBe(1);
		expect(lookupPrice("google/shared-model", 1)).toBeUndefined();
	});

	it("returns undefined for unknown models", () => {
		expect(lookupPrice("google/gemini-3.1-flash-lite", 10)).toBeUndefined();
	});
});

describe("primePrices", () => {
	it("fetches once, then serves from memory", async () => {
		const fetchImpl = okFetch();
		await primePrices({ fetchImpl, nowMs: 1000 });
		await primePrices({ fetchImpl, nowMs: 2000 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(lookupPrice("claude-sonnet-5-5", 1)?.output).toBe(10);
	});

	it("uses a fresh KV entry instead of fetching", async () => {
		const kv = createFakeKv();
		await kv.set(
			"pricing:openrouter",
			JSON.stringify({
				fetchedAt: 1000,
				table: parseOpenRouterPrices(SAMPLE),
			}),
		);
		const fetchImpl = okFetch();
		await primePrices({ kv, fetchImpl, nowMs: 5000 });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(lookupPrice("claude-sonnet-5-5", 1)?.input).toBe(2);
	});

	it("fetches and writes KV when nothing is cached", async () => {
		const kv = createFakeKv();
		await primePrices({ kv, fetchImpl: okFetch(), nowMs: 1000 });
		const stored = JSON.parse((await kv.get("pricing:openrouter")) ?? "{}");
		expect(stored.fetchedAt).toBe(1000);
		expect(Object.keys(stored.table)).toHaveLength(3);
	});

	it("keeps the stale table when the fetch fails and never throws", async () => {
		await primePrices({ fetchImpl: okFetch(), nowMs: 0 });
		const failing = vi.fn(async () => {
			throw new Error("boom");
		});
		const day = 24 * 3600 * 1000;
		await expect(
			primePrices({ fetchImpl: failing, nowMs: 2 * day }),
		).resolves.toBeDefined();
		expect(failing).toHaveBeenCalled();
		expect(lookupPrice("claude-sonnet-5-5", 1)?.input).toBe(2);
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	it("survives a failing fetch with no table at all", async () => {
		const failing = vi.fn(async () => new Response("no", { status: 500 }));
		await primePrices({ fetchImpl: failing, nowMs: 1 });
		expect(lookupPrice("claude-sonnet-5-5", 1)).toBeUndefined();
	});

	it("uses a stale KV table when the fetch fails", async () => {
		const kv = createFakeKv();
		await kv.set(
			"pricing:openrouter",
			JSON.stringify({
				fetchedAt: 0,
				table: parseOpenRouterPrices(SAMPLE),
			}),
		);
		const failing = vi.fn(async () => new Response("no", { status: 500 }));
		await primePrices({ kv, fetchImpl: failing, nowMs: 40 * 3600 * 1000 });
		expect(lookupPrice("claude-sonnet-5-5", 1)?.input).toBe(2);
	});

	it("does not retry a failed fetch until the retry window passes", async () => {
		const failing = vi.fn(async () => new Response("no", { status: 500 }));
		await primePrices({ fetchImpl: failing, nowMs: 1000 });
		await primePrices({ fetchImpl: failing, nowMs: 1000 + FETCH_RETRY_MS - 1 });
		expect(failing).toHaveBeenCalledTimes(1);
		await primePrices({ fetchImpl: failing, nowMs: 1000 + FETCH_RETRY_MS });
		expect(failing).toHaveBeenCalledTimes(2);
	});

	it("force bypasses fresh caches", async () => {
		const fetchImpl = okFetch();
		await primePrices({ fetchImpl, nowMs: 1000 });
		await primePrices({ fetchImpl, nowMs: 2000, force: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});
