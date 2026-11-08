import { computeReactionDelta } from "../feedback/reactions.js";
import type { Verdict } from "../feedback/types.js";
import { splitInlineClaims } from "../replay/claims.js";
import type { PostedClaim } from "../replay/types.js";
import { isOwnReview } from "../review-metadata.js";
import { parseBodyFindings } from "../review-state.js";
import type { ReviewerId } from "../reviewer-id.js";
import { classifyReplies, type DecisionReply } from "./disposition.js";
import { readFpMarkers, stripFpMarkers } from "./fingerprint.js";
import type { Ledger, LedgerEntry } from "./types.js";

export interface RequestLike {
	request<T = unknown>(
		route: string,
		params?: Record<string, unknown>,
	): Promise<{ data: T }>;
}

export interface EvidenceThread {
	commentId: number;
	isResolved: boolean;
	resolvedBy: string | null;
	replies: DecisionReply[];
	/** Verdicts from reactions on the thread's first comment, one per reactor. */
	reactions?: Verdict[];
}

export interface LedgerEvidence {
	prAuthor: string;
	claims: PostedClaim[];
	threads: EvidenceThread[];
	reviewIds: number[];
}

const DECIDER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const REST_REACTION_BY_GRAPHQL = new Map([
	["THUMBS_UP", "+1"],
	["THUMBS_DOWN", "-1"],
	["CONFUSED", "confused"],
]);

/** One verdict per reactor (the latest verdict-bearing reaction wins), the same reduction the feedback poller applies. */
function reactionVerdicts(
	nodes: readonly {
		content: string;
		user: { login: string } | null;
		createdAt: string;
	}[],
): Verdict[] {
	const current = nodes.flatMap((n) => {
		const content = REST_REACTION_BY_GRAPHQL.get(n.content);
		return content && n.user
			? [
					{
						login: n.user.login,
						content,
						createdAtMs: Date.parse(n.createdAt),
					},
				]
			: [];
	});
	return Object.values(computeReactionDelta(current, {}).lastSeen);
}

/** Verdicts for a thread's first comment, or none when the reaction list was cut off: a partial list can pick the wrong latest verdict. */
function threadReactions(
	firstId: number,
	root: ThreadNode["rootComment"],
): Verdict[] {
	const reactions = root?.nodes.find(
		(n) => n.databaseId === firstId,
	)?.reactions;
	if (!reactions) return [];
	if (reactions.pageInfo?.hasNextPage) {
		console.warn(
			`comment ${firstId} has more than 100 reactions; scoring it on its ledger status`,
		);
		return [];
	}
	return reactionVerdicts(reactions.nodes);
}

const PER_PAGE = 100;

export function buildLedger(e: LedgerEvidence): Ledger {
	const isDecider = (r: DecisionReply): boolean =>
		!r.isBot &&
		r.author !== "" &&
		(r.author === e.prAuthor ||
			DECIDER_ASSOCIATIONS.has(r.authorAssociation ?? ""));

	const deciderLogins = new Set<string>(e.prAuthor ? [e.prAuthor] : []);
	for (const t of e.threads)
		for (const r of t.replies) if (isDecider(r)) deciderLogins.add(r.author);

	const byComment = new Map(e.threads.map((t) => [t.commentId, t]));
	const claimsPerComment = new Map<number, number>();
	for (const c of e.claims)
		if (c.commentId !== null)
			claimsPerComment.set(
				c.commentId,
				(claimsPerComment.get(c.commentId) ?? 0) + 1,
			);

	return e.claims.map((c): LedgerEntry => {
		const t = c.commentId === null ? undefined : byComment.get(c.commentId);
		// One reply cannot say which of several merged claims it settles.
		const isSingleClaim =
			c.commentId !== null && claimsPerComment.get(c.commentId) === 1;
		const base = {
			id: c.id,
			round: c.roundIndex,
			path: c.path,
			line: c.line,
			severity: c.severity,
			title: c.title,
			body: stripFpMarkers(c.text),
			...readFpMarkers(c.text),
			...(isSingleClaim && t?.reactions?.length
				? { reactions: t.reactions }
				: {}),
		};
		const d = t && isSingleClaim && classifyReplies(t.replies, isDecider);
		const resolvedByDecider = Boolean(
			t?.isResolved && t.resolvedBy && deciderLogins.has(t.resolvedBy),
		);
		// "Will fix" then an explicit resolution: the resolution is the later,
		// final word. A deferral, rejection or fix reference still wins.
		if (d && !(d.status === "acknowledged" && resolvedByDecider))
			return { ...base, ...d, decidedBy: "author" };
		if (resolvedByDecider)
			return {
				...base,
				status: "resolved",
				decidedBy: "author",
				reason: null,
				evidence: [],
			};
		return {
			...base,
			status: "open",
			decidedBy: null,
			reason: null,
			evidence: [],
		};
	});
}

interface ApiReview {
	id: number;
	body: string | null;
	submitted_at: string | null;
}

interface ApiComment {
	id: number;
	pull_request_review_id: number | null;
	path: string;
	line: number | null;
	original_line?: number | null;
	body: string;
}

interface ThreadNode {
	isResolved: boolean;
	resolvedBy: { login: string } | null;
	comments: {
		pageInfo: { hasNextPage: boolean };
		nodes: {
			databaseId: number;
			author: { login: string; __typename: string } | null;
			authorAssociation: string;
			body: string;
			createdAt: string;
		}[];
	};
	rootComment?: {
		nodes: {
			databaseId: number;
			reactions?: {
				pageInfo?: { hasNextPage: boolean };
				nodes: {
					content: string;
					user: { login: string } | null;
					createdAt: string;
				}[];
			};
		}[];
	};
}

interface ThreadsResponse {
	repository: {
		pullRequest: {
			author: { login: string } | null;
			reviewThreads: {
				nodes: ThreadNode[];
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
			};
		};
	};
}

interface GraphqlEnvelope {
	data?: ThreadsResponse | null;
	errors?: { message?: string }[];
}

const THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        author { login }
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            isResolved
            resolvedBy { login }
            comments(first: 100) {
              pageInfo { hasNextPage }
              nodes {
                databaseId
                author { login __typename }
                authorAssociation
                body
                createdAt
              }
            }
            rootComment: comments(first: 1) {
              nodes {
                databaseId
                reactions(first: 100) {
                  pageInfo { hasNextPage }
                  nodes { content user { login } createdAt }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

async function getAll<T>(
	octokit: RequestLike,
	route: string,
	params: Record<string, unknown>,
): Promise<T[]> {
	const all: T[] = [];
	for (let page = 1; ; page++) {
		const { data } = await octokit.request<T[]>(route, {
			...params,
			per_page: PER_PAGE,
			page,
		});
		all.push(...data);
		if (data.length < PER_PAGE) return all;
	}
}

export async function fetchLedgerEvidence(
	octokit: RequestLike,
	o: {
		owner: string;
		repo: string;
		pull: number;
		commentPrefix: string;
		reviewer: ReviewerId;
	},
): Promise<LedgerEvidence> {
	const route = { owner: o.owner, repo: o.repo, pull_number: o.pull };
	const reviews = (
		await getAll<ApiReview>(
			octokit,
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			route,
		)
	)
		.filter(
			(r) =>
				r.submitted_at &&
				isOwnReview(r.body, {
					commentPrefix: o.commentPrefix,
					reviewer: o.reviewer,
				}),
		)
		.sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));
	const comments = await getAll<ApiComment>(
		octokit,
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
		route,
	);

	const claims: PostedClaim[] = [];
	const ownCommentIds = new Set<number>();
	for (const [index, review] of reviews.entries()) {
		for (const c of comments.filter(
			(x) => x.pull_request_review_id === review.id,
		)) {
			ownCommentIds.add(c.id);
			for (const [k, part] of splitInlineClaims(c.body).entries())
				claims.push({
					id: `r${index}:c${c.id}:${k}`,
					roundIndex: index,
					reviewId: review.id,
					source: "inline",
					commentId: c.id,
					path: c.path,
					line: c.line ?? c.original_line ?? null,
					severity: part.severity,
					title: part.title,
					text: part.text,
				});
		}
		for (const [k, f] of parseBodyFindings(review.body ?? "").entries())
			claims.push({
				id: `r${index}:body:${k}`,
				roundIndex: index,
				reviewId: review.id,
				source: "body",
				commentId: null,
				path: null,
				line: null,
				severity: f.severity,
				title: f.title,
				text: f.title,
			});
	}

	const threads: EvidenceThread[] = [];
	let prAuthor = "";
	let cursor: string | null = null;
	for (;;) {
		const res: { data: GraphqlEnvelope } =
			await octokit.request<GraphqlEnvelope>("POST /graphql", {
				query: THREADS_QUERY,
				variables: {
					owner: o.owner,
					repo: o.repo,
					pr: o.pull,
					...(cursor ? { cursor } : {}),
				},
			});
		const pr = res.data.data?.repository?.pullRequest;
		const errors = res.data.errors;
		if (Array.isArray(errors) && errors.length > 0)
			throw new Error(
				`GraphQL review threads query failed: ${errors[0]?.message ?? "unknown error"}`,
			);
		if (!pr?.reviewThreads)
			throw new Error(
				`GraphQL review threads response has no pullRequest.reviewThreads for ${o.owner}/${o.repo}#${o.pull}`,
			);
		prAuthor = pr.author?.login ?? prAuthor;
		for (const t of pr.reviewThreads.nodes) {
			const [first, ...rest] = t.comments.nodes;
			if (!first || !ownCommentIds.has(first.databaseId)) continue;
			if (t.comments.pageInfo.hasNextPage)
				throw new Error(
					`thread on comment ${first.databaseId} has more than 100 comments`,
				);
			threads.push({
				commentId: first.databaseId,
				isResolved: t.isResolved,
				resolvedBy: t.resolvedBy?.login ?? null,
				reactions: threadReactions(first.databaseId, t.rootComment),
				replies: rest.map((r) => ({
					author: r.author?.login ?? "",
					createdAt: r.createdAt,
					body: r.body,
					authorAssociation: r.authorAssociation,
					isBot: r.author?.__typename === "Bot",
				})),
			});
		}
		const { hasNextPage, endCursor } = pr.reviewThreads.pageInfo;
		if (!hasNextPage || !endCursor) break;
		cursor = endCursor;
	}

	return { prAuthor, claims, threads, reviewIds: reviews.map((r) => r.id) };
}
