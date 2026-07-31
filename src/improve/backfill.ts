import type { Db } from "./db/client.js";
import { insertRawFeedback, upsertFinding } from "./db/repo.js";
import { findingNaturalKey, parseFindingComment } from "./findings.js";

export interface BackfillOctokit {
	paginate: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<unknown[]>;
	request: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<{ data: unknown }>;
}

export interface ReviewCommentPayload {
	id: number;
	user: { login: string } | null;
	body: string;
	path: string | null;
	line: number | null;
	in_reply_to_id?: number;
	pull_request_review_id: number | null;
	original_commit_id?: string;
	commit_id?: string;
	created_at: string;
	reactions?: { total_count: number };
}

interface ReactionPayload {
	user: { login: string } | null;
	content: string;
	created_at: string;
}

export interface BackfillResult {
	owner: string;
	repo: string;
	pr: number;
	findings: number;
	reactions: number;
	replies: number;
	/** Bot comments whose body did not match the rendered finding format, so no
	 * catalog row was written. Reported rather than swallowed. */
	unparseable: number;
}

/** Our own review bots, mapped to the corpus provider. Third-party reviewers
 * (coderabbitai, sourcery-ai, chatgpt-codex-connector) are deliberately absent:
 * their findings are not ours to judge and would pollute the catalog. */
export const BOT_PROVIDERS: Record<string, "anthropic" | "openai"> = {
	"anthropicreviewbot[bot]": "anthropic",
	"codexreviewbot[bot]": "openai",
};

// A Map for the same reason as feedback/reactions.ts: `content` is an
// unconstrained string off the API payload, and object indexing would resolve
// inherited names like "toString" to a truthy value.
const REACTION_VERDICTS = new Map<string, string>([
	["+1", "up"],
	["-1", "down"],
	["confused", "confused"],
]);

/** Pure: dedup key for a reaction observation. Must stay byte-identical to the
 * live drain path so a backfill and a later poll converge on one row. */
export function reactionDedupKey(
	source: string,
	targetId: number,
	actor: string,
	verdict: string,
): string {
	return `react:${source}:${targetId}:${actor}:${verdict}`;
}

/** Pure: dedup key for a free-text comment. */
export function commentDedupKey(source: string, commentId: number): string {
	return `cmt:${source}:${commentId}`;
}

/** Pure: split a PR's review comments into the bot findings to catalog and the
 * human replies that explain them.
 *
 * A reply only counts as feedback when it sits on one of OUR threads. PRs are
 * reviewed by third-party bots too, and a human answering CodeRabbit or Sourcery
 * is discussing their finding, not ours — importing those would attribute other
 * reviewers' conversations to us. GitHub sets `in_reply_to_id` to the thread's
 * root comment, so the root's author identifies whose thread it is.
 *
 * A reply authored by one of our own bots is not feedback either. */
export function partitionComments(comments: ReviewCommentPayload[]): {
	findings: ReviewCommentPayload[];
	replies: ReviewCommentPayload[];
} {
	const findings: ReviewCommentPayload[] = [];
	const replies: ReviewCommentPayload[] = [];
	const authorByCommentId = new Map<number, string>();
	for (const c of comments) authorByCommentId.set(c.id, c.user?.login ?? "");

	for (const c of comments) {
		const login = c.user?.login ?? "";
		const isOurBot = login in BOT_PROVIDERS;
		if (c.in_reply_to_id !== undefined) {
			const rootAuthor = authorByCommentId.get(c.in_reply_to_id);
			if (
				!isOurBot &&
				rootAuthor !== undefined &&
				rootAuthor in BOT_PROVIDERS
			) {
				replies.push(c);
			}
		} else if (isOurBot) {
			findings.push(c);
		}
	}
	return { findings, replies };
}

function parseTimestamp(iso: string): Date {
	const ms = Date.parse(iso);
	return new Date(Number.isFinite(ms) ? ms : Date.now());
}

/** Harvest one PR's already-posted findings, reactions and reply threads into
 * the corpus. Safe to re-run: every write is keyed so a second pass over the
 * same PR inserts nothing new, which is what makes this usable as a recurring
 * sweep while feedback keeps arriving. */
export async function backfillPr(
	deps: { db: Db; octokit: BackfillOctokit },
	target: { owner: string; repo: string; pr: number },
): Promise<BackfillResult> {
	const { owner, repo, pr } = target;
	const comments = (await deps.octokit.paginate(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
		{ owner, repo, pull_number: pr, per_page: 100 },
	)) as ReviewCommentPayload[];

	const { findings, replies } = partitionComments(comments);
	const result: BackfillResult = {
		owner,
		repo,
		pr,
		findings: 0,
		reactions: 0,
		replies: 0,
		unparseable: 0,
	};

	for (const comment of findings) {
		const provider = BOT_PROVIDERS[comment.user?.login ?? ""];
		const parsed = parseFindingComment(comment.body);
		if (!parsed) {
			result.unparseable++;
			continue;
		}

		await upsertFinding(deps.db, {
			provider,
			owner,
			repo,
			pr,
			commentId: comment.id,
			reviewId: comment.pull_request_review_id,
			path: comment.path,
			line: comment.line,
			// Which skill raised a finding lived only in the in-memory provenance
			// map at post time and is not recoverable from GitHub, so backfilled
			// rows carry no skills and are marked so per-skill trends can exclude
			// them instead of silently averaging over empty arrays.
			skills: [],
			title: parsed.title,
			severity: parsed.severity,
			headSha: comment.original_commit_id ?? comment.commit_id ?? "unknown",
			postedAt: parseTimestamp(comment.created_at),
			naturalKey: findingNaturalKey({
				provider,
				owner,
				repo,
				pr,
				path: comment.path,
				title: parsed.title,
			}),
			backfilled: true,
		});
		result.findings++;

		if (!comment.reactions || comment.reactions.total_count === 0) continue;
		const res = await deps.octokit.request(
			"GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
			{ owner, repo, comment_id: comment.id, per_page: 100 },
		);
		for (const reaction of res.data as ReactionPayload[]) {
			const verdict = REACTION_VERDICTS.get(reaction.content);
			if (!verdict) continue;
			const actor = reaction.user?.login ?? "unknown";
			result.reactions += await insertRawFeedback(deps.db, {
				source: "inline_reaction",
				provider,
				owner,
				repo,
				pr,
				commentId: comment.id,
				reviewId: comment.pull_request_review_id,
				path: comment.path,
				line: comment.line,
				title: parsed.title,
				verdict,
				actor,
				eventAt: parseTimestamp(reaction.created_at),
				dedupKey: reactionDedupKey(
					"inline_reaction",
					comment.id,
					actor,
					verdict,
				),
			});
		}
	}

	for (const reply of replies) {
		const parent = comments.find((c) => c.id === reply.in_reply_to_id);
		// partitionComments only admits replies whose thread root is one of our
		// bots, so this lookup always resolves. Skipping on a miss rather than
		// defaulting to a provider keeps a future change to that filter from
		// silently misattributing another reviewer's thread to us.
		const provider = BOT_PROVIDERS[parent?.user?.login ?? ""];
		if (!provider) continue;
		result.replies += await insertRawFeedback(deps.db, {
			source: "inline_reply",
			provider,
			owner,
			repo,
			pr,
			commentId: reply.id,
			inReplyToId: reply.in_reply_to_id,
			reviewId: reply.pull_request_review_id,
			path: reply.path,
			line: reply.line,
			actor: reply.user?.login ?? "unknown",
			body: reply.body,
			eventAt: parseTimestamp(reply.created_at),
			dedupKey: commentDedupKey("inline_reply", reply.id),
		});
	}

	return result;
}

/** List the PRs in a repo that either of our bots has left review comments on,
 * newest first. Search is used rather than walking every PR because the bots are
 * installed on all repos and most PRs they touched are old and inert. */
export async function discoverReviewedPrs(
	octokit: BackfillOctokit,
	owner: string,
	repo: string,
): Promise<number[]> {
	const numbers = new Set<number>();
	for (const login of Object.keys(BOT_PROVIDERS)) {
		const items = (await octokit.paginate("GET /search/issues", {
			q: `repo:${owner}/${repo} type:pr commenter:${login}`,
			per_page: 100,
		})) as { number: number }[];
		for (const item of items) numbers.add(item.number);
	}
	return [...numbers].sort((a, b) => b - a);
}
