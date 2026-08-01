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
	/** GitHub's creation timestamp. Preferred over the capture time so a retry
	 * or a delayed capture does not shift when the finding appears to have been
	 * raised — the corpus is time-series data and the ordering matters. */
	created_at?: string;
}

/** GitHub's timestamp when present, else now. An unparseable value falls back
 * rather than writing an Invalid Date into a NOT NULL column. */
export function parsePostedAt(iso: string | undefined): Date {
	if (!iso) return new Date();
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? new Date(ms) : new Date();
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

/** Marker identifying this bot's carrier comment on a PR. Kept in the body so
 * the comment can be found again and updated rather than duplicated. */
export function carrierMarker(prefix: string): string {
	return `<!-- ai-review:carrier:${prefix} -->`;
}

/** The body of the carrier comment. PR *reviews* are not reactable, so the
 * top-level verdict needs a normal issue comment to carry reactions — its id is
 * what the daily poll reads from `issues/comments/{id}/reactions`.
 *
 * Carries the review's prose and a link back to it, not the review body: this
 * comment sits directly beneath the review it rates, and repeating that review
 * in full made the bot look like it had posted twice. */
export function carrierBody(
	prefix: string,
	summary: string,
	reviewUrl?: string,
): string {
	return [
		carrierMarker(prefix),
		`### ${prefix} — review summary`,
		"",
		summary.trim() || "_(no summary)_",
		...(reviewUrl ? ["", `[See the full review](${reviewUrl})`] : []),
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
	/** Called with the carrier's comment id so it can be registered for reaction
	 * polling. Without this the carrier invites ratings that nothing ever reads. */
	onCarrier?: (commentId: number) => Promise<void>;
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
		// One carrier per PR, updated in place. Posting a fresh one per review
		// round would leave a PR with six rounds carrying six carriers, and would
		// scatter the review-level reactions across all of them instead of
		// accumulating them where they can be read.
		const existing = (await octokit.paginate(
			"GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
			{ owner, repo, issue_number: pr, per_page: 100 },
		)) as { id: number; body?: string }[];
		const marker = carrierMarker(deps.commentPrefix);
		const mine = existing.find((c) => c.body?.includes(marker));
		const body = carrierBody(
			deps.commentPrefix,
			deps.summary,
			`https://github.com/${owner}/${repo}/pull/${pr}#pullrequestreview-${deps.reviewId}`,
		);

		if (mine) {
			await octokit.request(
				"PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
				{ owner, repo, comment_id: mine.id, body },
			);
			carrierCommentId = mine.id;
		} else {
			const res = await octokit.request(
				"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
				{ owner, repo, issue_number: pr, body },
			);
			carrierCommentId = (res.data as { id: number }).id;
		}
		if (deps.onCarrier) {
			// Contained: registration is best-effort, and the finding catalog is
			// built after this block. A KV blip must not cost every finding on the
			// review — the carrier can be re-registered on the next round, but a
			// finding that was never catalogued has no second chance.
			try {
				await deps.onCarrier(carrierCommentId);
			} catch (err) {
				console.error("improve: carrier registration failed", {
					owner,
					repo,
					pr,
					error:
						err instanceof Error ? `${err.name}: ${err.message}` : String(err),
				});
			}
		}
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
			postedAt: parsePostedAt(comment.created_at),
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
