import { describe, expect, it, vi } from "vitest";
import type { PostedClaim } from "../replay/types.js";
import { buildStrictOctokit } from "../testing.js";
import {
	buildLedger,
	type EvidenceThread,
	fetchLedgerEvidence,
	type RequestLike,
} from "./github.js";

const claim = (commentId: number): PostedClaim => ({
	id: `r0:c${commentId}:0`,
	roundIndex: 0,
	reviewId: 1,
	source: "inline",
	commentId,
	path: "a.ts",
	line: 3,
	severity: "P2",
	title: "t",
	text: "body text",
});

const thread = (over: Partial<EvidenceThread>): EvidenceThread => ({
	commentId: 10,
	isResolved: false,
	resolvedBy: null,
	replies: [],
	...over,
});

const reply = (over: Record<string, unknown>) => ({
	author: "u",
	createdAt: "2026-01-01T00:00:00Z",
	body: "this is intentional",
	...over,
});

const build = (threads: EvidenceThread[], claims = [claim(10)]) =>
	buildLedger({ prAuthor: "joe", claims, threads, reviewIds: [] });

describe("buildLedger", () => {
	it("settles on a collaborator's classifying reply and fills body", () => {
		const [e] = build([
			thread({
				replies: [reply({ author: "bob", authorAssociation: "COLLABORATOR" })],
			}),
		]);
		expect(e.status).toBe("rejected");
		expect(e.reason).toBe("this is intentional");
		expect(e.decidedBy).toBe("author");
		expect(e.body).toBe("body text");
	});

	describe("a comment holding several claims", () => {
		const twoClaims = [
			{ ...claim(10), id: "r0:c10:0", title: "first issue" },
			{ ...claim(10), id: "r0:c10:1", title: "second issue" },
		];

		it("is not settled by a reply, which cannot say which claim it means", () => {
			const ledger = build(
				[
					thread({
						replies: [
							reply({
								author: "joe",
								body: "the first issue is intentional; the second still needs fixing",
							}),
						],
					}),
				],
				twoClaims,
			);
			expect(ledger.map((e) => e.status)).toEqual(["open", "open"]);
		});

		it("settles every claim as resolved when a decider resolves the thread", () => {
			const ledger = build(
				[
					thread({
						isResolved: true,
						resolvedBy: "joe",
						replies: [reply({ author: "joe" })],
					}),
				],
				twoClaims,
			);
			expect(ledger.map((e) => e.status)).toEqual(["resolved", "resolved"]);
		});
	});

	it("settles on the PR author's reply", () => {
		expect(
			build([thread({ replies: [reply({ author: "joe" })] })])[0].status,
		).toBe("rejected");
	});

	it("ignores a drive-by account", () => {
		const [e] = build([
			thread({
				replies: [reply({ author: "x", authorAssociation: "NONE" })],
			}),
		]);
		expect(e.status).toBe("open");
	});

	it("ignores a bot reply", () => {
		const [e] = build([
			thread({
				replies: [
					reply({ author: "joe", authorAssociation: "OWNER", isBot: true }),
				],
			}),
		]);
		expect(e.status).toBe("open");
	});

	it("resolves an author-resolved thread without a reply", () => {
		const [e] = build([thread({ isResolved: true, resolvedBy: "joe" })]);
		expect(e.status).toBe("resolved");
		expect(e.reason).toBeNull();
		expect(e.decidedBy).toBe("author");
	});

	it("accepts a resolver seen as collaborator in any reply", () => {
		const [e] = build([
			thread({
				isResolved: true,
				resolvedBy: "bob",
				replies: [
					reply({ author: "bob", authorAssociation: "MEMBER", body: "hm" }),
				],
			}),
		]);
		expect(e.status).toBe("resolved");
	});

	it("keeps a thread resolved by a non-decider open", () => {
		const [e] = build([thread({ isResolved: true, resolvedBy: "rando" })]);
		expect(e.status).toBe("open");
		expect(e.decidedBy).toBeNull();
	});

	it("never lets a null-author reply settle when the PR author is also null", () => {
		const [e] = buildLedger({
			prAuthor: "",
			reviewIds: [],
			claims: [claim(10)],
			threads: [thread({ replies: [reply({ author: "" })] })],
		});
		expect(e.status).toBe("open");
	});

	it("never counts a null-author reply as a collaborator", () => {
		const [e] = build([
			thread({
				isResolved: true,
				resolvedBy: "",
				replies: [
					reply({ author: "", authorAssociation: "MEMBER", body: "hm" }),
				],
			}),
		]);
		expect(e.status).toBe("open");
	});

	it("leaves a claim with no thread open", () => {
		expect(build([])[0].status).toBe("open");
	});
});

const GH_REVIEWS = [
	{ id: 1, body: "### Bot\nreview", submitted_at: "2026-01-01T00:00:00Z" },
	{ id: 2, body: "### Sister\nreview", submitted_at: "2026-01-01T00:01:00Z" },
];
const GH_COMMENTS = [
	{
		id: 10,
		pull_request_review_id: 1,
		path: "a.ts",
		line: 3,
		body: "**P2** thing",
	},
	{
		id: 20,
		pull_request_review_id: 2,
		path: "a.ts",
		line: 4,
		body: "**P2** other",
	},
];
const node = (databaseId: number, extra = {}) => ({
	databaseId,
	author: { login: "joe", __typename: "User" },
	authorAssociation: "OWNER",
	body: "x",
	createdAt: "2026-01-02T00:00:00Z",
	...extra,
});
const page = (nodes: unknown[], next: string | null) => ({
	repository: {
		pullRequest: {
			author: { login: "joe" },
			reviewThreads: {
				nodes,
				pageInfo: { hasNextPage: next !== null, endCursor: next },
			},
		},
	},
});
const t = (id: number, comments = [node(id)]) => ({
	isResolved: false,
	resolvedBy: null,
	comments: { pageInfo: { hasNextPage: false }, nodes: comments },
});

/** Rejects the request shape GitHub would answer with an errors array:
 * request() sends top-level params as the JSON body, so the query's $owner,
 * $repo, $pr and $cursor must travel inside `variables`. */
function assertGraphqlVariables(
	params: Record<string, unknown> | undefined,
	expectedCursor: string | undefined,
) {
	if (params && ("owner" in params || "repo" in params || "pr" in params))
		throw new Error("GraphQL variables sent as top-level params");
	const v = params?.variables as Record<string, unknown> | undefined;
	if (v?.owner !== "o" || v?.repo !== "r" || v?.pr !== 1)
		throw new Error(`missing GraphQL variables: ${JSON.stringify(v)}`);
	if (v.cursor !== expectedCursor)
		throw new Error(`cursor ${String(v.cursor)} != ${String(expectedCursor)}`);
}

function fake(pages: unknown[]): RequestLike {
	let g = 0;
	let cursor: string | undefined;
	const request = async (route: string, params?: Record<string, unknown>) => {
		if (route === "POST /graphql") {
			assertGraphqlVariables(params, cursor);
			const p = pages[g++] as
				| {
						repository?: {
							pullRequest?: {
								reviewThreads?: { pageInfo: { endCursor: string | null } };
							} | null;
						};
				  }
				| undefined;
			cursor =
				p?.repository?.pullRequest?.reviewThreads?.pageInfo.endCursor ??
				undefined;
			return { data: { data: p } };
		}
		if (route.endsWith("/reviews"))
			return { data: params?.page === 1 ? GH_REVIEWS : [] };
		return { data: params?.page === 1 ? GH_COMMENTS : [] };
	};
	return { request: request as RequestLike["request"] };
}

const opts = {
	owner: "o",
	repo: "r",
	pull: 1,
	commentPrefix: "Bot",
	provider: "anthropic",
};

describe("fetchLedgerEvidence", () => {
	it("reads every GraphQL page and drops foreign threads", async () => {
		const octokit = fake([page([t(10), t(20)], "c1"), page([t(999)], null)]);
		const ev = await fetchLedgerEvidence(octokit, opts);
		expect(ev.prAuthor).toBe("joe");
		expect(ev.claims.map((c) => c.id)).toEqual(["r0:c10:0"]);
		expect(ev.threads.map((x) => x.commentId)).toEqual([10]);
	});

	it("maps replies with bot flag and association", async () => {
		const octokit = fake([
			page(
				[
					t(10, [
						node(10),
						node(11, { author: { login: "gh", __typename: "Bot" } }),
					]),
				],
				null,
			),
		]);
		const ev = await fetchLedgerEvidence(octokit, opts);
		expect(ev.threads[0].replies[0]).toMatchObject({
			author: "gh",
			authorAssociation: "OWNER",
			isBot: true,
		});
	});

	it("throws on a GraphQL errors array even with partial data", async () => {
		const good = fake([]);
		const octokit: RequestLike = {
			request: (async (route: string, params?: Record<string, unknown>) =>
				route === "POST /graphql"
					? {
							data: {
								data: page([t(10)], null),
								errors: [{ message: "rate limited" }],
							},
						}
					: good.request(route, params)) as RequestLike["request"],
		};
		await expect(fetchLedgerEvidence(octokit, opts)).rejects.toThrow(
			/rate limited/,
		);
	});

	it("throws a descriptive error for a null pullRequest", async () => {
		const octokit = fake([{ repository: { pullRequest: null } }]);
		await expect(fetchLedgerEvidence(octokit, opts)).rejects.toThrow(
			/no pullRequest\.reviewThreads/,
		);
	});

	it("throws when a thread has more comments than one page", async () => {
		const big = t(10);
		big.comments.pageInfo.hasNextPage = true;
		const octokit = fake([page([big], null)]);
		await expect(fetchLedgerEvidence(octokit, opts)).rejects.toThrow();
	});

	it("fetchLedgerEvidence returns own review ids in round order", async () => {
		const graphql = vi.fn((_p: Record<string, unknown>) => ({
			data: page([], null),
		}));
		const octokit = buildStrictOctokit({
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": (p) =>
				p.page === 1
					? [
							{
								id: 5,
								body: "### Bot\nb",
								submitted_at: "2026-01-03T00:00:00Z",
							},
							{
								id: 3,
								body: "### Bot\na",
								submitted_at: "2026-01-01T00:00:00Z",
							},
							{
								id: 4,
								body: "### Sister\nx",
								submitted_at: "2026-01-02T00:00:00Z",
							},
							{ id: 6, body: "### Bot\npending", submitted_at: null },
						]
					: [],
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": () => [],
			"POST /graphql": graphql,
		});
		const ev = await fetchLedgerEvidence(octokit, opts);
		expect(ev.reviewIds).toEqual([3, 5]);
		expect(graphql).toHaveBeenCalledTimes(1);
		expect(graphql.mock.calls[0]?.[0]).toMatchObject({
			variables: { owner: "o", repo: "r", pr: 1 },
		});
	});

	// Production runs both bots under one heading; only the provider marker
	// tells their reviews apart (PR #92 reviews 5719190216 and 5719191481).
	it("leaves the other provider's reviews under the same heading out of reviewIds", async () => {
		const marked = (provider: string) =>
			`### Bot\nb\n\n<!-- ai-review:sha=abc -->\n<!-- ai-review:provider=${provider} -->\n\n---\n*Model: m*`;
		const reviewParams: Array<Record<string, unknown>> = [];
		const octokit = buildStrictOctokit({
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": (p) => {
				reviewParams.push(p);
				return p.page === 1
					? [
							{
								id: 7,
								body: marked("anthropic"),
								submitted_at: "2026-01-01T00:00:00Z",
							},
							{
								id: 8,
								body: marked("openai"),
								submitted_at: "2026-01-01T00:00:01Z",
							},
							{
								id: 9,
								body: "### Bot\nlegacy, no markers",
								submitted_at: "2026-01-01T00:00:02Z",
							},
						]
					: [];
			},
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": () => [
				{
					id: 80,
					pull_request_review_id: 8,
					path: "a.ts",
					line: 1,
					body: "**P2** codex said",
				},
			],
			"POST /graphql": () => ({ data: page([], null) }),
		});
		const ev = await fetchLedgerEvidence(octokit, {
			...opts,
			provider: "anthropic",
		});
		expect(ev.reviewIds).toEqual([7, 9]);
		expect(ev.claims).toEqual([]);
		expect(reviewParams[0]).toMatchObject({
			owner: "o",
			repo: "r",
			pull_number: 1,
			page: 1,
		});
	});
});
