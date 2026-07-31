import { describe, expect, it, vi } from "vitest";
import { improveRequest } from "./cron.js";

describe("improveRequest", () => {
	// The flag is checked before the secret because Vercel only sends the Bearer
	// header once CRON_SECRET is set — a deployment that never opted in would
	// otherwise emit a failed cron run forever.
	it("skips before authenticating when the feature is off", async () => {
		const run = vi.fn();
		const res = await improveRequest({
			authorization: undefined,
			secret: undefined,
			improveEnabled: false,
			run,
		});
		expect(res.status).toBe(200);
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects a missing or wrong secret once enabled", async () => {
		const run = vi.fn();
		for (const authorization of [undefined, "Bearer wrong"]) {
			const res = await improveRequest({
				authorization,
				secret: "right",
				improveEnabled: true,
				run,
			});
			expect(res.status).toBe(401);
		}
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses to authorize when no secret is configured", async () => {
		const res = await improveRequest({
			authorization: "Bearer anything",
			secret: undefined,
			improveEnabled: true,
			run: vi.fn(),
		});
		expect(res.status).toBe(401);
	});

	it("runs the cycle and returns its result", async () => {
		const res = await improveRequest({
			authorization: "Bearer right",
			secret: "right",
			improveEnabled: true,
			run: async () => ({ classified: 3 }),
		});
		expect(res).toEqual({ status: 200, body: { classified: 3 } });
	});

	it("returns the status contract rather than throwing a raw stack", async () => {
		const res = await improveRequest({
			authorization: "Bearer right",
			secret: "right",
			improveEnabled: true,
			run: async () => {
				throw new Error("no database");
			},
		});
		expect(res.status).toBe(500);
		expect(res.body).toMatchObject({ message: "no database" });
	});
});
