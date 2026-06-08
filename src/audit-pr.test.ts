import { describe, expect, it, vi } from "vitest";
import { ensureOrphanBase } from "./audit-pr.js";

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
			"POST /repos/{owner}/{repo}/git/blobs": () => ({ sha: "BLOB" }),
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
