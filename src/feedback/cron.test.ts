import { describe, expect, it, vi } from "vitest";
import { pollFeedbackRequest } from "./cron.js";
import { createFakeKv } from "./kv.fake.js";

function buildDeps() {
	return { kv: createFakeKv(), getOctokit: vi.fn(), nowMs: 1_000_000 };
}

describe("pollFeedbackRequest", () => {
	it("401s when the authorization does not match the secret", async () => {
		const out = await pollFeedbackRequest({
			authorization: undefined,
			secret: "s3cret",
			feedbackEnabled: true,
			buildDeps,
		});
		expect(out.status).toBe(401);
	});

	it("401s when no secret is configured", async () => {
		const out = await pollFeedbackRequest({
			authorization: "Bearer x",
			secret: undefined,
			feedbackEnabled: true,
			buildDeps,
		});
		expect(out.status).toBe(401);
	});

	it("skips (200) when feedback is disabled, without building deps", async () => {
		const deps = vi.fn(buildDeps);
		const out = await pollFeedbackRequest({
			authorization: "Bearer s3cret",
			secret: "s3cret",
			feedbackEnabled: false,
			buildDeps: deps,
		});
		expect(out.status).toBe(200);
		expect(out.body).toMatchObject({ skipped: expect.any(String) });
		expect(deps).not.toHaveBeenCalled();
	});

	it("skips (200) when disabled even with no secret configured, without building deps", async () => {
		const deps = vi.fn(buildDeps);
		const out = await pollFeedbackRequest({
			authorization: undefined,
			secret: undefined,
			feedbackEnabled: false,
			buildDeps: deps,
		});
		expect(out.status).toBe(200);
		expect(out.body).toMatchObject({ skipped: expect.any(String) });
		expect(deps).not.toHaveBeenCalled();
	});

	it("runs the poll (200) when authorized and enabled", async () => {
		const out = await pollFeedbackRequest({
			authorization: "Bearer s3cret",
			secret: "s3cret",
			feedbackEnabled: true,
			buildDeps,
		});
		expect(out.status).toBe(200);
		expect(out.body).toEqual({ polled: 0, events: 0, pruned: 0 });
	});

	it("returns 500 (not a raw throw) when building deps or polling fails", async () => {
		const out = await pollFeedbackRequest({
			authorization: "Bearer s3cret",
			secret: "s3cret",
			feedbackEnabled: true,
			buildDeps: () => {
				throw new Error("KV down");
			},
		});
		expect(out.status).toBe(500);
		expect(out.body).toMatchObject({ error: expect.any(String) });
	});

	// A systemic failure here (KV unreachable, missing env, bad installation
	// auth) is the one thing Vercel Cron never surfaces on its own — nobody
	// inspects the HTTP body of a scheduled invocation. Before this test, the
	// 500 was constructed with zero console output, so an outage left no
	// server-side trace at all.
	it("logs a systemic poll failure, not just the 500 body", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const out = await pollFeedbackRequest({
				authorization: "Bearer s3cret",
				secret: "s3cret",
				feedbackEnabled: true,
				buildDeps: () => {
					throw new Error("KV down");
				},
			});
			expect(out.status).toBe(500);
			expect(errorSpy).toHaveBeenCalledWith(
				"feedback cron: poll failed",
				expect.objectContaining({ err: expect.any(Error) }),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
