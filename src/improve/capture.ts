import type { Db } from "./db/client.js";
import { upsertFinding } from "./db/repo.js";
import { findingNaturalKey } from "./findings.js";

export interface CaptureOctokit {
	request: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<{ data: unknown }>;
	paginate: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<unknown[]>;
}

export interface PostedComment {
	id: number;
	path: string | null;
	line: number | null;
	pull_request_review_id: number | null;
}

export type Provenance = Map<
	string,
	{ skills: string[]; title: string; severity: string | null }
>;

/** Pure: pair each comment GitHub actually created with the provenance recorded
 * for its location. A comment with no matching entry is skipped rather than
 * catalogued with an empty title — the catalog is a join target, and a row that
 * names nothing cannot be matched to feedback later. */
export function pairWithProvenance(
	comments: PostedComment[],
	reviewId: number,
	provenance: Provenance,
): {
	comment: PostedComment;
	skills: string[];
	title: string;
	severity: string | null;
}[] {
	const paired = [];
	for (const comment of comments) {
		if (comment.pull_request_review_id !== reviewId) continue;
		const prov = provenance.get(`${comment.path}:${comment.line}`);
		if (!prov) continue;
		paired.push({ comment, ...prov });
	}
	return paired;
}

/** The body of the carrier comment. PR *reviews* are not reactable, so the
 * top-level verdict needs a normal issue comment to carry reactions — its id is
 * what the daily poll reads from `issues/comments/{id}/reactions`. */
export function carrierBody(prefix: string, summary: string): string {
	return [
		`### ${prefix} — review summary`,
		"",
		summary.trim() || "_(no summary)_",
		"",
		"---",
		"React on **this comment** to rate the review as a whole: 👍 useful, 👎 wrong, 😕 it didn't land. For 😕, a reply saying why is what we actually learn from.",
	].join("\n");
}

/** Record a posted review in the corpus: catalog every inline finding, and post
 * one carrier comment so the review-level verdict can be rated too.
 *
 * Best-effort by design — the review is already published, so a capture failure
 * must not surface as a review failure. Returns what it managed to record. */
export async function capturePostedReview(deps: {
	db: Db;
	octokit: CaptureOctokit;
	owner: string;
	repo: string;
	pr: number;
	reviewId: number;
	headSha: string;
	provider: "anthropic" | "openai";
	provenance: Provenance;
	summary: string;
	commentPrefix: string;
	postCarrier: boolean;
}): Promise<{ findings: number; carrierCommentId: number | null }> {
	const { db, octokit, owner, repo, pr, provider } = deps;
	let findings = 0;
	let carrierCommentId: number | null = null;

	const comments = (await octokit.paginate(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
		{ owner, repo, pull_number: pr, per_page: 100 },
	)) as PostedComment[];

	if (deps.postCarrier) {
		const res = await octokit.request(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
			{
				owner,
				repo,
				issue_number: pr,
				body: carrierBody(deps.commentPrefix, deps.summary),
			},
		);
		carrierCommentId = (res.data as { id: number }).id;
	}

	for (const { comment, skills, title, severity } of pairWithProvenance(
		comments,
		deps.reviewId,
		deps.provenance,
	)) {
		await upsertFinding(db, {
			provider,
			owner,
			repo,
			pr,
			commentId: comment.id,
			reviewId: deps.reviewId,
			path: comment.path,
			line: comment.line,
			skills,
			title,
			severity,
			headSha: deps.headSha,
			postedAt: new Date(),
			naturalKey: findingNaturalKey({
				provider,
				owner,
				repo,
				pr,
				commentId: comment.id,
				path: comment.path,
				title,
			}),
			backfilled: false,
		});
		findings++;
	}

	return { findings, carrierCommentId };
}
