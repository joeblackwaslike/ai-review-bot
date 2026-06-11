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
});
