import { splitInlineClaims } from "../replay/claims.js";
import type { PostedClaim } from "../replay/types.js";
import { parseBodyFindings } from "../review-state.js";
import { classifyReplies, type DecisionReply } from "./disposition.js";
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
}

export interface LedgerEvidence {
	prAuthor: string;
	claims: PostedClaim[];
	threads: EvidenceThread[];
}

const DECIDER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const SEVERITY = /\bP[0-3]\b/;
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

	return e.claims.map((c): LedgerEntry => {
		const base = {
			id: c.id,
			round: c.roundIndex,
			path: c.path,
			line: c.line,
			severity: c.severity,
			title: c.title,
			body: c.text,
		};
		const t = c.commentId === null ? undefined : byComment.get(c.commentId);
		const d = t && classifyReplies(t.replies, isDecider);
		if (d) return { ...base, ...d, decidedBy: "author" };
		if (t?.isResolved && t.resolvedBy && deciderLogins.has(t.resolvedBy))
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
	o: { owner: string; repo: string; pull: number; commentPrefix: string },
): Promise<LedgerEvidence> {
	const route = { owner: o.owner, repo: o.repo, pull_number: o.pull };
	const reviews = (
		await getAll<ApiReview>(
			octokit,
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			route,
		)
	)
		.filter((r) => r.submitted_at && r.body?.includes(`### ${o.commentPrefix}`))
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
					severity: part.text.match(SEVERITY)?.[0] ?? "P3",
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
				owner: o.owner,
				repo: o.repo,
				pr: o.pull,
				...(cursor ? { cursor } : {}),
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

	return { prAuthor, claims, threads };
}
