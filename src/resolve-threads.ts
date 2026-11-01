import { splitInlineClaims } from "./replay/claims.js";
import { isOwnReview } from "./review-metadata.js";

export interface ResolvedFindingRef {
	path: string | null;
	title: string;
}

interface ReviewThread {
	id: string;
	path: string;
	body: string;
}

interface GraphQLOctokit {
	graphql: <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
}

interface ThreadsQueryResponse {
	repository: {
		pullRequest: {
			reviewThreads: {
				nodes: Array<{
					id: string;
					isResolved: boolean;
					path: string;
					comments: {
						nodes: Array<{
							body: string;
							author: { __typename: string } | null;
							pullRequestReview: { body: string } | null;
						}>;
					};
				}>;
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
            path
            comments(first: 1) {
              nodes {
                body
                author { __typename }
                pullRequestReview { body }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

async function fetchOwnOpenThreads(
	octokit: GraphQLOctokit,
	owner: string,
	repo: string,
	pullNumber: number,
	own: { commentPrefix: string; provider: string },
): Promise<ReviewThread[]> {
	const threads: ReviewThread[] = [];
	let cursor: string | null = null;

	do {
		const result: ThreadsQueryResponse =
			await octokit.graphql<ThreadsQueryResponse>(THREADS_QUERY, {
				owner,
				repo,
				pr: pullNumber,
				cursor,
			});

		const page: ThreadsQueryResponse["repository"]["pullRequest"]["reviewThreads"] =
			result.repository.pullRequest.reviewThreads;
		for (const node of page.nodes) {
			const first = node.comments.nodes[0];
			if (!first || node.isResolved) continue;
			if (first.author?.__typename !== "Bot") continue;
			if (!isOwnReview(first.pullRequestReview?.body, own)) continue;
			threads.push({ id: node.id, path: node.path, body: first.body });
		}

		cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
	} while (cursor);

	return threads;
}

const RESOLVE_MUTATION = `
  mutation ($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

/**
 * Resolves this bot's own open threads for findings the current round
 * resolved. A thread closes only when every finding in its first comment
 * (merged comments hold several) is resolved, matched by path and exact title.
 */
export async function resolveStaleThreads(
	octokit: GraphQLOctokit,
	owner: string,
	repo: string,
	pullNumber: number,
	options: {
		commentPrefix: string;
		provider: "anthropic" | "openai";
		resolved: readonly ResolvedFindingRef[];
	},
): Promise<number> {
	if (options.resolved.length === 0) return 0;

	const threads = await fetchOwnOpenThreads(
		octokit,
		owner,
		repo,
		pullNumber,
		options,
	);
	let count = 0;

	for (const thread of threads) {
		const claims = splitInlineClaims(thread.body);
		const allResolved =
			claims.length > 0 &&
			claims.every((c) =>
				options.resolved.some(
					(r) => r.path === thread.path && r.title === c.title,
				),
			);
		if (!allResolved) continue;
		try {
			await octokit.graphql(RESOLVE_MUTATION, { threadId: thread.id });
			count++;
		} catch (err) {
			console.error("failed to resolve thread", {
				threadId: thread.id,
				path: thread.path,
				err,
			});
		}
	}

	if (count > 0) {
		console.log(`resolved ${count} stale review thread(s)`);
	}

	return count;
}
