import { describe, expect, it, vi } from "vitest";
import {
	ensureOrphanBase,
	openDraftPr,
	postProviderReview,
} from "./audit-pr.js";
import { buildModelReview, buildPullFile } from "./testing.js";

function octokitWith(handlers: Record<string, (params: unknown) => unknown>) {
	return {
		request: vi.fn(async (route: string, params: unknown) => {
			const h = handlers[route];
			if (!h) throw Object.assign(new Error("not found"), { status: 404 });
			return { data: h(params) };
		}),
	};
}

describe("ensureOrphanBase", () => {
	it("creates the orphan branch when missing", async () => {
		const created: string[] = [];
		const octokit = octokitWith({
			"GET /repos/{owner}/{repo}/git/ref/{ref}": () => {
				throw Object.assign(new Error("no ref"), { status: 404 });
			},
			"POST /repos/{owner}/{repo}/git/trees": () => ({ sha: "TREE" }),
			"POST /repos/{owner}/{repo}/git/commits": () => ({ sha: "COMMIT" }),
			"POST /repos/{owner}/{repo}/git/refs": (p) => {
				created.push((p as { ref: string }).ref);
				return { ref: (p as { ref: string }).ref };
			},
		});
		await ensureOrphanBase(octokit as never, "o", "r", "ai-review/empty");
		expect(created).toEqual(["refs/heads/ai-review/empty"]);
	});

	it("is a no-op when the orphan branch already exists", async () => {
		const octokit = octokitWith({
			"GET /repos/{owner}/{repo}/git/ref/{ref}": () => ({
				object: { sha: "X" },
			}),
		});
		await ensureOrphanBase(octokit as never, "o", "r", "ai-review/empty");
		expect(octokit.request).toHaveBeenCalledTimes(1);
	});
});

describe("createHeadBranch", () => {
	it("GETs base ref + commit, POSTs tree with base_tree, POSTs commit with parents, POSTs head ref", async () => {
		const { createHeadBranch } = await import("./audit-pr.js");
		let treeRequest: unknown;
		let commitRequest: unknown;
		const octokit = octokitWith({
			"GET /repos/{owner}/{repo}/git/ref/{ref}": () => ({
				object: { sha: "BASE_SHA" },
			}),
			"GET /repos/{owner}/{repo}/git/commits/{commit_sha}": () => ({
				tree: { sha: "BASE_TREE_SHA" },
			}),
			"POST /repos/{owner}/{repo}/git/trees": (p) => {
				treeRequest = p;
				return { sha: "NEW_TREE_SHA" };
			},
			"POST /repos/{owner}/{repo}/git/commits": (p) => {
				commitRequest = p;
				return { sha: "NEW_COMMIT_SHA" };
			},
			"POST /repos/{owner}/{repo}/git/refs": () => ({
				ref: "refs/heads/ai-review/audit-1",
			}),
		});
		await createHeadBranch({
			octokit: octokit as never,
			owner: "o",
			repo: "r",
			branch: "ai-review/audit-1",
			baseBranch: "main",
			files: [{ path: "a.ts", content: "code here" }],
		});
		expect(treeRequest).toMatchObject({
			base_tree: "BASE_TREE_SHA",
			tree: [expect.objectContaining({ path: "a.ts", content: "code here" })],
		});
		expect(commitRequest).toMatchObject({
			parents: ["BASE_SHA"],
		});
	});
});

describe("openDraftPr", () => {
	it("opens a draft PR and applies the AI audit label", async () => {
		const labels: string[] = [];
		const octokit = octokitWith({
			"POST /repos/{owner}/{repo}/pulls": () => ({
				number: 42,
				html_url: "URL",
			}),
			"POST /repos/{owner}/{repo}/issues/{issue_number}/labels": (p) => {
				labels.push(...(p as { labels: string[] }).labels);
				return [];
			},
		});
		const out = await openDraftPr({
			octokit: octokit as never,
			owner: "o",
			repo: "r",
			head: "ai-review/audit-1",
			base: "ai-review/empty",
			title: "AI audit",
		});
		expect(out).toEqual({ number: 42, url: "URL" });
		expect(labels).toEqual(["AI audit"]);
	});
});

describe("postProviderReview", () => {
	it("submits inline comments validated against the orphan (full-file) diff", async () => {
		let submitted: { event: string; comments: unknown[] } | undefined;
		const octokit = octokitWith({
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": (p) => {
				submitted = p as never;
				return { id: 1 };
			},
		});
		// Orphan diff: file fully added → every line valid.
		const files = [buildPullFile("a.ts", "@@ -0,0 +1,3 @@\n+l1\n+l2\n+l3")];
		const review = buildModelReview({
			event: "REQUEST_CHANGES",
			general_findings: [],
			inline_comments: [
				{
					title: "T",
					body: "b",
					path: "a.ts",
					line: 2,
					start_line: null,
					suggestion: null,
				},
			],
		});
		await postProviderReview({
			octokit: octokit as never,
			owner: "o",
			repo: "r",
			pullNumber: 42,
			headSha: "SHA",
			files,
			review,
			prefix: "ai-review-bot",
		});
		expect(submitted?.event).toBe("REQUEST_CHANGES");
		expect(submitted?.comments).toHaveLength(1);
	});
});
