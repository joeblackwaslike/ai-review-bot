import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("forces a fetch and reports the model count", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(
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
			),
		);
		const r = await call(`Bearer ${SECRET}`);
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ models: 1 });
	});
});
