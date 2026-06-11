import { describe, expect, it, vi } from "vitest";
import { createFakeKv } from "./kv.fake.js";
import { persistPostedComments } from "./persist.js";
import { listActiveComments } from "./store.js";

const NOW = 1_000_000;

describe("persistPostedComments", () => {
	it("records only this review's comments that have provenance, with TTL and provenance", async () => {
		const kv = createFakeKv();
		const octokit = {
			paginate: vi.fn(async () => [
				{
					id: 100,
					path: "src/x.ts",
					line: 10,
					body: "b1",
					pull_request_review_id: 55,
				},
				{
					id: 101,
					path: "src/y.ts",
					line: 20,
					body: "b2",
					pull_request_review_id: 55,
				},
				{
					id: 102,
					path: "src/z.ts",
					line: 30,
					body: "b3",
					pull_request_review_id: 999,
				}, // other review
			]),
		};
		const provenance = new Map([
			["src/x.ts:10", { skills: ["code-reviewer.md"], title: "Bug" }],
			["src/y.ts:20", { skills: ["security-sast.md"], title: "XSS" }],
		]);

		const count = await persistPostedComments({
			kv,
			octokit,
			owner: "o",
			repo: "r",
			pr: 7,
			reviewId: 55,
			headSha: "sha",
			installationId: 5,
			provider: "anthropic",
			provenance,
			nowMs: NOW,
		});

		expect(count).toBe(2); // 102 excluded (different review)
		const active = await listActiveComments(kv, NOW);
		const byId = Object.fromEntries(active.map((a) => [a.commentId, a]));
		expect(byId[100]?.skills).toEqual(["code-reviewer.md"]);
		expect(byId[100]?.title).toBe("Bug");
		expect(byId[100]?.expiresAtMs).toBe(NOW + 14 * 24 * 60 * 60 * 1000);
		expect(byId[101]?.skills).toEqual(["security-sast.md"]);
		expect(byId[102]).toBeUndefined();
	});
});
