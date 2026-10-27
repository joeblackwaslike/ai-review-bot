import { parseBodyFindings } from "../review-state.js";
import { splitInlineClaims } from "./claims.js";
import { type GhClient, GhHttpError } from "./gh.js";
import type {
	CommitMeta,
	PostedClaim,
	Provider,
	ReactionEvidence,
	ReplayFixture,
	Round,
	ThreadEvidence,
} from "./types.js";

interface RecordOpts {
	owner: string;
	repo: string;
	pull: number;
	provider: Provider;
	botLogin: string;
	now?: () => Date;
}

interface ApiReview {
	id: number;
	user: { login: string } | null;
	submitted_at: string | null;
	commit_id: string;
	body: string | null;
}

interface ApiComment {
	id: number;
	pull_request_review_id: number | null;
	user: { login: string } | null;
	path: string;
	line: number | null;
	original_line?: number | null;
	body: string;
}

interface ApiCompare {
	merge_base_commit?: { sha: string };
	commits: { sha: string; commit: { committer: { date: string } } }[];
}

interface ThreadNode {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	resolvedBy: { login: string } | null;
	comments: {
		pageInfo: { hasNextPage: boolean };
		nodes: {
			databaseId: number;
			author: { login: string } | null;
			body: string;
			createdAt: string;
			lastEditedAt: string | null;
		}[];
	};
}

interface ThreadsResponse {
	repository: {
		pullRequest: {
			reviewThreads: {
				nodes: ThreadNode[];
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
			};
		};
	};
}

const THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            isOutdated
            resolvedBy { login }
            comments(first: 100) {
              pageInfo { hasNextPage }
              nodes { databaseId author { login } body createdAt lastEditedAt }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const SHA_MARKER = /<!--\s*ai-review:sha=([0-9a-f]{7,40})\s*-->/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
const SEVERITY = /\bP[0-3]\b/;

export function hunkRanges(patch: string): [number, number][] {
	const ranges: [number, number][] = [];
	for (const m of patch.matchAll(HUNK_HEADER)) {
		const start = Number(m[1]);
		const len = m[2] === undefined ? 1 : Number(m[2]);
		if (len > 0) ranges.push([start, start + len - 1]);
	}
	return ranges;
}

async function fetchThreads(
	client: GhClient,
	o: RecordOpts,
): Promise<ThreadNode[]> {
	const nodes: ThreadNode[] = [];
	let cursor: string | null = null;
	for (;;) {
		const res: ThreadsResponse = await client.graphql<ThreadsResponse>(
			THREADS_QUERY,
			{
				owner: o.owner,
				repo: o.repo,
				pr: o.pull,
				...(cursor ? { cursor } : {}),
			},
		);
		const page = res.repository.pullRequest.reviewThreads;
		nodes.push(...page.nodes);
		if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return nodes;
		cursor = page.pageInfo.endCursor;
	}
}

async function fetchCommitsSince(
	client: GhClient,
	repoPath: string,
	base: string,
	head: string,
): Promise<{
	mergeBase: string | null;
	triggerAt: string | null;
	approximate: boolean;
	commits: CommitMeta[];
}> {
	const miss = {
		mergeBase: null,
		triggerAt: null,
		approximate: true,
		commits: [],
	};
	let cmp: ApiCompare;
	try {
		cmp = await client.rest<ApiCompare>(
			`${repoPath}/compare/${base}...${head}`,
		);
	} catch (err) {
		if (
			err instanceof GhHttpError &&
			(err.status === 404 || err.status === 422)
		)
			return miss;
		throw err;
	}
	const headCommit = cmp.commits.find((c) => c.sha.startsWith(head));
	if (!headCommit)
		return { ...miss, mergeBase: cmp.merge_base_commit?.sha ?? null };
	const commits: CommitMeta[] = [];
	for (const c of cmp.commits) {
		const detail = await client.rest<{
			files?: { filename: string; patch?: string }[];
		}>(`${repoPath}/commits/${c.sha}`);
		commits.push({
			sha: c.sha,
			committedAt: c.commit.committer.date,
			files: (detail.files ?? []).map((f) => ({
				path: f.filename,
				ranges: hunkRanges(f.patch ?? ""),
			})),
		});
	}
	return {
		mergeBase: cmp.merge_base_commit?.sha ?? null,
		triggerAt: headCommit.commit.committer.date,
		approximate: false,
		commits,
	};
}

export async function recordPr(
	client: GhClient,
	o: RecordOpts,
): Promise<ReplayFixture> {
	const repoPath = `/repos/${o.owner}/${o.repo}`;
	const prPath = `${repoPath}/pulls/${o.pull}`;
	const pr = await client.rest<{
		user: { login: string };
		base: { sha: string };
	}>(prPath);
	const author = pr.user.login;

	const reviews = (await client.rest<ApiReview[]>(`${prPath}/reviews`))
		.filter((r) => r.user?.login === o.botLogin && r.submitted_at)
		.sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));
	const comments = (
		await client.rest<ApiComment[]>(`${prPath}/comments`)
	).filter((c) => c.user?.login === o.botLogin);

	const rounds: Round[] = [];
	let prevHead = pr.base.sha;
	for (const [index, review] of reviews.entries()) {
		const body = review.body ?? "";
		const headSha = body.match(SHA_MARKER)?.[1] ?? review.commit_id;
		const since = await fetchCommitsSince(client, repoPath, prevHead, headSha);
		const claims: PostedClaim[] = [];
		for (const c of comments.filter(
			(x) => x.pull_request_review_id === review.id,
		)) {
			for (const [k, part] of splitInlineClaims(c.body).entries()) {
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
		}
		for (const [k, f] of parseBodyFindings(body).entries()) {
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
		rounds.push({
			index,
			reviewId: review.id,
			provider: o.provider,
			submittedAt: review.submitted_at as string,
			headSha,
			baseSha: prevHead,
			mergeBase: since.mergeBase,
			triggerAt: since.triggerAt,
			approximate: since.approximate,
			commitsSince: since.commits,
			claims,
		});
		prevHead = headSha;
	}

	const roundIds = new Set(reviews.map((r) => r.id));
	const botCommentIds = new Set(
		comments
			.filter(
				(c) =>
					c.pull_request_review_id && roundIds.has(c.pull_request_review_id),
			)
			.map((c) => c.id),
	);

	const threads: ThreadEvidence[] = [];
	for (const t of await fetchThreads(client, o)) {
		if (t.comments.pageInfo.hasNextPage)
			throw new Error(`thread ${t.id} has more than 100 comments`);
		const [first, ...rest] = t.comments.nodes;
		if (!first || !botCommentIds.has(first.databaseId)) continue;
		threads.push({
			threadId: t.id,
			commentId: first.databaseId,
			isResolved: t.isResolved,
			isOutdated: t.isOutdated,
			resolvedBy: t.resolvedBy?.login ?? null,
			replies: rest
				.filter((r) => r.author?.login === author)
				.map((r) => ({
					id: r.databaseId,
					author,
					createdAt: r.createdAt,
					editedAt: r.lastEditedAt,
					body: r.body,
				})),
		});
	}

	const reactions: ReactionEvidence[] = [];
	for (const id of botCommentIds) {
		const rs = await client.rest<
			{ user: { login: string } | null; content: string; created_at: string }[]
		>(`${repoPath}/pulls/comments/${id}/reactions`);
		for (const r of rs) {
			if (r.user?.login !== author) continue;
			reactions.push({
				commentId: id,
				user: author,
				content: r.content,
				createdAt: r.created_at,
			});
		}
	}

	return {
		schemaVersion: 1,
		owner: o.owner,
		repo: o.repo,
		pull: o.pull,
		provider: o.provider,
		author,
		recordedAt: (o.now ?? (() => new Date()))().toISOString(),
		rounds,
		threads,
		reactions,
	};
}
