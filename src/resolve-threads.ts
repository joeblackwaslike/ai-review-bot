interface ReviewThread {
	id: string;
	isResolved: boolean;
	path: string;
	line: number | null;
	comments: Array<{ body: string }>;
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
					line: number | null;
					comments: {
						nodes: Array<{ body: string }>;
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
            line
            comments(first: 1) {
              nodes { body }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

async function fetchBotThreads(
	octokit: GraphQLOctokit,
	owner: string,
	repo: string,
	pullNumber: number,
	commentPrefix: string,
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
			const firstComment = node.comments.nodes[0];
			if (!firstComment) continue;
			if (!firstComment.body.includes(`**`) || !node.line) continue;

			if (
				firstComment.body.includes(commentPrefix) ||
				firstComment.body.startsWith("**")
			) {
				threads.push({
					id: node.id,
					isResolved: node.isResolved,
					path: node.path,
					line: node.line,
					comments: node.comments.nodes,
				});
			}
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

export async function resolveStaleThreads(
	octokit: GraphQLOctokit,
	owner: string,
	repo: string,
	pullNumber: number,
	commentPrefix: string,
	validLinesByPath: Map<string, Set<number>>,
): Promise<number> {
	const threads = await fetchBotThreads(
		octokit,
		owner,
		repo,
		pullNumber,
		commentPrefix,
	);

	const unresolvedThreads = threads.filter((t) => !t.isResolved);
	let resolved = 0;

	for (const thread of unresolvedThreads) {
		const validLines = validLinesByPath.get(thread.path);
		if (!validLines || (thread.line !== null && !validLines.has(thread.line))) {
			try {
				await octokit.graphql(RESOLVE_MUTATION, { threadId: thread.id });
				resolved++;
			} catch (err) {
				console.error("failed to resolve thread", {
					threadId: thread.id,
					path: thread.path,
					line: thread.line,
					err,
				});
			}
		}
	}

	if (resolved > 0) {
		console.log(`resolved ${resolved} stale review thread(s)`);
	}

	return resolved;
}
