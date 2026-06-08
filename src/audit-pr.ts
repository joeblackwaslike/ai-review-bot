import type { AuditFile } from "./sources.js";

export type OctokitLike = {
	request: <T>(
		route: string,
		params: Record<string, unknown>,
	) => Promise<{ data: T }>;
};

function isStatus(err: unknown, code: number): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { status?: number }).status === code
	);
}

export async function ensureOrphanBase(
	octokit: OctokitLike,
	owner: string,
	repo: string,
	branch: string,
): Promise<void> {
	try {
		await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
			owner,
			repo,
			ref: `heads/${branch}`,
		});
		return; // already exists
	} catch (err) {
		if (!isStatus(err, 404)) throw err;
	}
	// Empty tree → root commit with no parents → orphan ref.
	const { data: tree } = await octokit.request<{ sha: string }>(
		"POST /repos/{owner}/{repo}/git/trees",
		{ owner, repo, tree: [] },
	);
	const { data: commit } = await octokit.request<{ sha: string }>(
		"POST /repos/{owner}/{repo}/git/commits",
		{
			owner,
			repo,
			message: "ai-review: empty base",
			tree: tree.sha,
			parents: [],
		},
	);
	await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
		owner,
		repo,
		ref: `refs/heads/${branch}`,
		sha: commit.sha,
	});
}

export async function createHeadBranch(opts: {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	branch: string;
	baseBranch: string;
	files: AuditFile[];
}): Promise<void> {
	const { octokit, owner, repo, branch, baseBranch, files } = opts;
	const { data: baseRef } = await octokit.request<{ object: { sha: string } }>(
		"GET /repos/{owner}/{repo}/git/ref/{ref}",
		{ owner, repo, ref: `heads/${baseBranch}` },
	);
	const baseSha = baseRef.object.sha;
	const { data: baseCommit } = await octokit.request<{ tree: { sha: string } }>(
		"GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
		{ owner, repo, commit_sha: baseSha },
	);
	const tree = files.map((f) => ({
		path: f.path,
		mode: "100644" as const,
		type: "blob" as const,
		content: f.content,
	}));
	const { data: newTree } = await octokit.request<{ sha: string }>(
		"POST /repos/{owner}/{repo}/git/trees",
		{ owner, repo, base_tree: baseCommit.tree.sha, tree },
	);
	const { data: commit } = await octokit.request<{ sha: string }>(
		"POST /repos/{owner}/{repo}/git/commits",
		{
			owner,
			repo,
			message: "ai-review: audit snapshot",
			tree: newTree.sha,
			parents: [baseSha],
		},
	);
	await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
		owner,
		repo,
		ref: `refs/heads/${branch}`,
		sha: commit.sha,
	});
}
