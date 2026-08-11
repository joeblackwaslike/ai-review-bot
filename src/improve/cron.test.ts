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

	// Same gap as feedback/cron.ts had: a systemic failure here (no database,
	// bad credentials) is exactly the kind of outage nobody inspects the cron
	// HTTP body for. Before this test, the 500 carried zero console output.
	it("logs a systemic cycle failure, not just the 500 body", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await improveRequest({
				authorization: "Bearer right",
				secret: "right",
				improveEnabled: true,
				run: async () => {
					throw new Error("no database");
				},
			});
			expect(res.status).toBe(500);
			expect(errorSpy).toHaveBeenCalledWith(
				"improve cron: cycle failed",
				expect.objectContaining({ err: expect.any(Error) }),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("runImproveCycle stage containment", () => {
	const base = {
		db: {} as never,
		octokit: { request: async () => ({ data: { items: [] } }) } as never,
		owner: "o",
		repo: "r",
		selection: { provider: "anthropic", model: "m" } as const,
	};

	// A drain failure must not stop classification or proposals — the corpus is
	// the source of truth and KV is only a buffer.
	it("continues past a failing drain", async () => {
		const { runImproveCycle } = await import("./run.js");
		const kv = {
			lrange: async () => {
				throw new Error("kv down");
			},
		} as never;
		const result = await runImproveCycle({ ...base, kv, dryRun: true });
		expect(result.drained).toBeNull();
		expect(result).toHaveProperty("proposals");
	});

	// A classifier outage must not stop proposals being filed from what is
	// already classified.
	it("still reports a result when classification throws", async () => {
		const { runImproveCycle } = await import("./run.js");
		const result = await runImproveCycle({ ...base, dryRun: true });
		expect(result.classified).toBe(0);
		expect(Array.isArray(result.proposals)).toBe(true);
	});

	it("skips the drain entirely when no KV client is supplied", async () => {
		const { runImproveCycle } = await import("./run.js");
		const result = await runImproveCycle({ ...base, kv: null, dryRun: true });
		expect(result.drained).toBeNull();
	});
});
