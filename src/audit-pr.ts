import type { ModelReview } from "./review.js";
import { buildReviewComments } from "./review.js";
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

const AI_AUDIT_LABEL = "AI audit";

export async function openDraftPr(opts: {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	head: string;
	base: string;
	title: string;
	body?: string;
}): Promise<{ number: number; url: string }> {
	const { octokit, owner, repo, head, base, title, body } = opts;
	const { data: pr } = await octokit.request<{
		number: number;
		html_url: string;
	}>("POST /repos/{owner}/{repo}/pulls", {
		owner,
		repo,
		head,
		base,
		title,
		body: body ?? "Automated AI audit.",
		draft: true,
	});
	await octokit.request(
		"POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
		{
			owner,
			repo,
			issue_number: pr.number,
			labels: [AI_AUDIT_LABEL],
		},
	);
	return { number: pr.number, url: pr.html_url };
}

interface PullFileLike {
	filename: string;
	status: string;
	patch?: string;
}

export async function postProviderReview(opts: {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	files: PullFileLike[];
	review: ModelReview;
	prefix: string;
}): Promise<void> {
	const { octokit, owner, repo, pullNumber, headSha, files, review, prefix } =
		opts;
	const comments = buildReviewComments(files, review.inline_comments);
	if (comments.length === 0 && review.general_findings.length === 0) {
		// Nothing to report — don't POST an empty-body review.
		return;
	}
	const event =
		review.event === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "COMMENT";
	const findingLines = review.general_findings.map(
		(f) => `- **[${f.severity}] ${f.title}** — ${f.body}`,
	);
	const body = [`### ${prefix}`, "", ...findingLines].join("\n");
	await octokit.request(
		"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		{
			owner,
			repo,
			pull_number: pullNumber,
			commit_id: headSha,
			event,
			body,
			comments,
		},
	);
}

export async function makeReady(opts: {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	pullNumber: number;
	base: string;
}): Promise<void> {
	const { octokit, owner, repo, pullNumber, base } = opts;
	// 1. Retarget base → default branch (collapses the diff to fixes-only).
	await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
		owner,
		repo,
		pull_number: pullNumber,
		base,
	});
	// 2. Mark ready — REST has no draft toggle; use the GraphQL mutation.
	// Only run the mutation when the PR is actually a draft; the mutation throws
	// "Pull request is not in draft state" otherwise.
	const { data: pr } = await octokit.request<{
		node_id: string;
		draft: boolean;
	}>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
		owner,
		repo,
		pull_number: pullNumber,
	});
	if (pr.draft) {
		await octokit.request("POST /graphql", {
			query:
				"mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ clientMutationId } }",
			variables: { id: pr.node_id },
		});
	}
}
