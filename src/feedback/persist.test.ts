import { describe, expect, it, vi } from "vitest";
import { commentKey } from "../comment-key.js";
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
					body: "**Bug**\n\nb1",
					pull_request_review_id: 55,
				},
				{
					id: 101,
					path: "src/y.ts",
					line: 20,
					body: "**XSS**\n\nb2",
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
			[
				commentKey({ path: "src/x.ts", line: 10, title: "Bug" }),
				{ skills: ["code-reviewer.md"], title: "Bug" },
			],
			[
				commentKey({ path: "src/y.ts", line: 20, title: "XSS" }),
				{ skills: ["security-sast.md"], title: "XSS" },
			],
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

	it("matches each comment to its own entry when two share a line", async () => {
		const kv = createFakeKv();
		const octokit = {
			paginate: vi.fn(async () => [
				{
					id: 200,
					path: "src/x.ts",
					line: 10,
					body: "**Second**\n\nb",
					pull_request_review_id: 55,
				},
				{
					id: 201,
					path: "src/x.ts",
					line: 10,
					body: "**First**\n\nb",
					pull_request_review_id: 55,
				},
			]),
		};
		const provenance = new Map([
			[
				commentKey({ path: "src/x.ts", line: 10, title: "First" }),
				{ skills: ["a.md"], title: "First" },
			],
			[
				commentKey({ path: "src/x.ts", line: 10, title: "Second" }),
				{ skills: ["b.md"], title: "Second" },
			],
		]);
		await persistPostedComments({
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
		const active = await listActiveComments(kv, NOW);
		const byId = Object.fromEntries(active.map((a) => [a.commentId, a]));
		expect(byId[200]?.skills).toEqual(["b.md"]);
		expect(byId[201]?.skills).toEqual(["a.md"]);
	});

	it("warns with path, line and title for a comment that has no provenance", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const octokit = {
			paginate: vi.fn(async () => [
				{
					id: 300,
					path: "src/q.ts",
					line: 4,
					body: "**Orphan**\n\nb",
					pull_request_review_id: 55,
				},
			]),
		};
		await persistPostedComments({
			kv: createFakeKv(),
			octokit,
			owner: "o",
			repo: "r",
			pr: 7,
			reviewId: 55,
			headSha: "sha",
			installationId: 5,
			provider: "anthropic",
			provenance: new Map(),
			nowMs: NOW,
		});
		expect(warn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ path: "src/q.ts", line: 4, title: "Orphan" }),
		);
		warn.mockRestore();
	});
});
