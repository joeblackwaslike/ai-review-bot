import type { KvClient } from "./kv.js";
import { recordPostedComment } from "./store.js";
import type { Provider } from "./types.js";

const TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface OctokitLike {
	paginate: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<unknown[]>;
}

interface ReviewCommentResponse {
	id: number;
	path: string;
	line: number | null;
	body: string;
	pull_request_review_id: number | null;
}

/** List a review's created comments, match each to its provenance by path:line, and persist
 * the ones we recognize so the cron can later read their reactions. Returns the count stored. */
export async function persistPostedComments(opts: {
	kv: KvClient;
	octokit: OctokitLike;
	owner: string;
	repo: string;
	pr: number;
	reviewId: number;
	headSha: string;
	installationId: number;
	provider: Provider;
	provenance: Map<string, { skills: string[]; title: string }>;
	nowMs: number;
}): Promise<number> {
	const comments = (await opts.octokit.paginate(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
		{ owner: opts.owner, repo: opts.repo, pull_number: opts.pr, per_page: 100 },
	)) as ReviewCommentResponse[];

	let count = 0;
	for (const c of comments) {
		if (c.pull_request_review_id !== opts.reviewId) continue;
		const prov = opts.provenance.get(`${c.path}:${c.line}`);
		if (!prov) continue;
		await recordPostedComment(
			opts.kv,
			{
				commentId: c.id,
				provider: opts.provider,
				installationId: opts.installationId,
				owner: opts.owner,
				repo: opts.repo,
				pr: opts.pr,
				headSha: opts.headSha,
				path: c.path,
				line: c.line ?? 0,
				skills: prov.skills,
				title: prov.title,
				body: c.body,
				postedAtMs: opts.nowMs,
				expiresAtMs: opts.nowMs + TTL_MS,
				lastSeenReactions: {},
			},
			opts.nowMs,
		);
		count++;
	}
	return count;
}
