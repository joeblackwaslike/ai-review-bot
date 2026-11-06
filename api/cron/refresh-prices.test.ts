import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kv from "../../src/feedback/kv.js";
import { clearPriceTable } from "../../src/pricing.js";
import handler from "./refresh-prices.js";

const SECRET = "cron-secret-value";

beforeEach(() => {
	vi.stubEnv("CRON_SECRET", SECRET);
	clearPriceTable();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function call(authorization?: string) {
	let status = 0;
	let body: unknown;
	const res = {
		status: (s: number) => {
			status = s;
			return res;
		},
		json: (b: unknown) => {
			body = b;
			return res;
		},
	};
	await handler(
		{ headers: { authorization } } as VercelRequest,
		res as unknown as VercelResponse,
	);
	return { status, body };
}

describe("GET /api/cron/refresh-prices", () => {
	it("rejects a missing or wrong bearer token", async () => {
		expect((await call()).status).toBe(401);
		expect((await call("Bearer nope")).status).toBe(401);
	});

	function stubOpenRouter() {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "openai/gpt-6-luna",
								pricing: { prompt: "0.0000001", completion: "0.0000005" },
							},
						],
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("forces a fetch on every call and reports the model count", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchMock = stubOpenRouter();
		const first = await call(`Bearer ${SECRET}`);
		const second = await call(`Bearer ${SECRET}`);
		expect(first).toEqual({ status: 200, body: { models: 1 } });
		expect(second).toEqual({ status: 200, body: { models: 1 } });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [url] of fetchMock.mock.calls as unknown as [string][]) {
			expect(url).toBe("https://openrouter.ai/api/v1/models");
		}
	});

	it("logs an unexpected KV init failure when credentials are set", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("KV_REST_API_URL", "https://kv.example");
		vi.stubEnv("KV_REST_API_TOKEN", "token");
		vi.spyOn(kv, "createUpstashKv").mockImplementation(() => {
			throw new Error("bad kv url");
		});
		stubOpenRouter();
		const r = await call(`Bearer ${SECRET}`);
		expect(r.status).toBe(200);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("KV"),
			expect.objectContaining({ error: "bad kv url" }),
		);
	});

	it("stays quiet when KV credentials are absent", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("KV_REST_API_URL", "");
		vi.stubEnv("KV_REST_API_TOKEN", "");
		stubOpenRouter();
		await call(`Bearer ${SECRET}`);
		expect(warn).not.toHaveBeenCalled();
	});
});
