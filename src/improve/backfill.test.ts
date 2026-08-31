import { describe, expect, it, vi } from "vitest";
import {
	attributeProviderForComment,
	backfillPr,
	commentDedupKey,
	findingsMissingReactions,
	findUnratedFindings,
	partitionComments,
	type ReviewCommentPayload,
	reactionDedupKey,
} from "./backfill.js";

function comment(
	over: Partial<ReviewCommentPayload> & { id: number },
): ReviewCommentPayload {
	return {
		user: { login: "anthropicreviewbot[bot]" },
		body: "🟡 **P2**\n\n**a finding**\n\nwhy",
		path: "src/x.ts",
		line: 10,
		pull_request_review_id: 900,
		original_commit_id: "sha1",
		created_at: "2026-07-30T00:00:00Z",
		reactions: { total_count: 0 },
		...over,
	};
}

describe("partitionComments", () => {
	it("treats a top-level bot comment as a finding", () => {
		const { findings, replies } = partitionComments([comment({ id: 1 })]);
		expect(findings.map((c) => c.id)).toEqual([1]);
		expect(replies).toEqual([]);
	});

	it("treats a human reply as feedback, not a finding", () => {
		const { findings, replies } = partitionComments([
			comment({ id: 1 }),
			comment({
				id: 2,
				in_reply_to_id: 1,
				user: { login: "joeblackwaslike" },
				body: "this is a false positive",
			}),
		]);
		expect(findings.map((c) => c.id)).toEqual([1]);
		expect(replies.map((c) => c.id)).toEqual([2]);
	});

	it("excludes a third-party bot's reply from the feedback bucket", () => {
		const { findings, replies } = partitionComments([
			comment({ id: 1 }),
			comment({
				id: 2,
				in_reply_to_id: 1,
				user: { login: "sourcery-ai[bot]" },
				body: "noted",
			}),
		]);
		expect(findings.map((c) => c.id)).toEqual([1]);
		expect(replies).toEqual([]);
	});

	it("excludes a bot's own reply from both buckets", () => {
		const { findings, replies } = partitionComments([
			comment({ id: 2, in_reply_to_id: 1 }),
		]);
		expect(findings).toEqual([]);
		expect(replies).toEqual([]);
	});

	it("ignores a human reply on a third-party bot's thread", () => {
		const { findings, replies } = partitionComments([
			comment({ id: 1, user: { login: "coderabbitai[bot]" } }),
			comment({
				id: 2,
				in_reply_to_id: 1,
				user: { login: "joeblackwaslike" },
				body: "answering coderabbit, not us",
			}),
		]);
		expect(findings).toEqual([]);
		expect(replies).toEqual([]);
	});

	it("ignores a reply whose thread root is absent from the payload", () => {
		const { replies } = partitionComments([
			comment({ id: 2, in_reply_to_id: 999, user: { login: "someone" } }),
		]);
		expect(replies).toEqual([]);
	});

	it("ignores third-party review bots entirely", () => {
		const { findings, replies } = partitionComments([
			comment({ id: 3, user: { login: "coderabbitai[bot]" } }),
			comment({ id: 4, user: { login: "chatgpt-codex-connector[bot]" } }),
		]);
		expect(findings).toEqual([]);
		expect(replies).toEqual([]);
	});

	it("recognizes the codex bot as a finding author", () => {
		const { findings } = partitionComments([
			comment({ id: 5, user: { login: "codexreviewbot[bot]" } }),
		]);
		expect(findings.map((c) => c.id)).toEqual([5]);
	});
});

describe("dedup keys", () => {
	it("builds a reaction key from source, target, actor and verdict", () => {
		expect(reactionDedupKey("inline_reaction", 7, "joe", "confused")).toBe(
			"react:inline_reaction:7:joe:confused",
		);
	});

	it("distinguishes two verdicts from the same actor on one comment", () => {
		expect(reactionDedupKey("inline_reaction", 7, "joe", "up")).not.toBe(
			reactionDedupKey("inline_reaction", 7, "joe", "down"),
		);
	});

	it("builds a comment key from source and id", () => {
		expect(commentDedupKey("inline_reply", 42)).toBe("cmt:inline_reply:42");
	});
});

describe("backfillPr", () => {
	function buildDeps(comments: ReviewCommentPayload[], reactions: unknown[]) {
		const octokit = {
			paginate: vi.fn(async () => comments),
			request: vi.fn(async () => ({ data: reactions })),
		};
		return { octokit };
	}

	it("catalogs findings, records reactions, and reports unparseable bodies", async () => {
		const comments = [
			comment({ id: 1, reactions: { total_count: 1 } }),
			comment({ id: 2, body: "not our format at all" }),
			comment({
				id: 3,
				in_reply_to_id: 1,
				user: { login: "joeblackwaslike" },
				body: "false positive because X",
			}),
		];
		const { octokit } = buildDeps(comments, [
			{
				user: { login: "joeblackwaslike" },
				content: "confused",
				created_at: "2026-07-30T01:00:00Z",
			},
		]);

		const rawRows: Record<string, unknown>[] = [];
		const findingRows: Record<string, unknown>[] = [];
		const db = {
			insert: () => ({
				values: (row: Record<string, unknown>) => {
					const isFinding = "naturalKey" in row;
					(isFinding ? findingRows : rawRows).push(row);
					const chain = {
						onConflictDoNothing: () => ({
							returning: async () => [{ id: rawRows.length }],
						}),
						onConflictDoUpdate: () => ({
							returning: async () => [{ id: findingRows.length }],
						}),
					};
					return chain;
				},
			}),
		} as never;

		const result = await backfillPr(
			{ db, octokit },
			{ owner: "o", repo: "r", pr: 55 },
		);

		expect(result).toMatchObject({
			pr: 55,
			findings: 1,
			reactions: 1,
			replies: 1,
			unparseable: 1,
		});
		expect(findingRows[0]).toMatchObject({
			provider: "anthropic",
			title: "a finding",
			severity: "p2",
			headSha: "sha1",
			skills: [],
			backfilled: true,
		});
		expect(rawRows[0]).toMatchObject({
			source: "inline_reaction",
			verdict: "confused",
			actor: "joeblackwaslike",
			dedupKey: "react:inline_reaction:1:joeblackwaslike:confused",
		});
		expect(rawRows[1]).toMatchObject({
			source: "inline_reply",
			body: "false positive because X",
			inReplyToId: 1,
			dedupKey: "cmt:inline_reply:3",
		});
	});

	it("skips the reactions request when a comment has none", async () => {
		const { octokit } = buildDeps([comment({ id: 1 })], []);
		const db = {
			insert: () => ({
				values: () => ({
					onConflictDoNothing: () => ({ returning: async () => [{ id: 1 }] }),
					onConflictDoUpdate: () => ({ returning: async () => [{ id: 1 }] }),
				}),
			}),
		} as never;

		await backfillPr({ db, octokit }, { owner: "o", repo: "r", pr: 1 });
		expect(octokit.request).not.toHaveBeenCalled();
	});

	function buildRouteAwareDeps(
		reviewComments: ReviewCommentPayload[],
		issueComments: {
			id: number;
			user: { login: string } | null;
			body: string;
			created_at: string;
		}[],
	) {
		const octokit = {
			paginate: vi.fn(async (route: string) =>
				route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
					? issueComments
					: reviewComments,
			),
			request: vi.fn(async () => ({ data: [] })),
		};
		const rawRows: Record<string, unknown>[] = [];
		const db = {
			insert: () => ({
				values: (row: Record<string, unknown>) => {
					rawRows.push(row);
					return {
						onConflictDoNothing: () => ({
							returning: async () => [{ id: rawRows.length }],
						}),
						onConflictDoUpdate: () => ({
							returning: async () => [{ id: rawRows.length }],
						}),
					};
				},
			}),
		} as never;
		return { octokit, db, rawRows };
	}

	it("captures a top-level comment as pr_comment when exactly one provider reviewed", async () => {
		const { octokit, db, rawRows } = buildRouteAwareDeps(
			[comment({ id: 1 })],
			[
				{
					id: 200,
					user: { login: "joeblackwaslike" },
					body: "this looks wrong to me",
					created_at: "2026-07-30T02:00:00Z",
				},
			],
		);

		const result = await backfillPr(
			{ db, octokit },
			{ owner: "o", repo: "r", pr: 55 },
		);

		expect(result.prComments).toBe(1);
		const prCommentRow = rawRows.find((r) => r.source === "pr_comment");
		expect(prCommentRow).toMatchObject({
			source: "pr_comment",
			provider: "anthropic",
			commentId: 200,
			actor: "joeblackwaslike",
			body: "this looks wrong to me",
			dedupKey: "cmt:pr_comment:200",
		});
	});

	it("skips a top-level comment naming neither bot when both providers reviewed", async () => {
		const { octokit, db, rawRows } = buildRouteAwareDeps(
			[
				comment({ id: 1, user: { login: "anthropicreviewbot[bot]" } }),
				comment({ id: 2, user: { login: "codexreviewbot[bot]" } }),
			],
			[
				{
					id: 201,
					user: { login: "joeblackwaslike" },
					body: "thanks, looks good",
					created_at: "2026-07-30T02:00:00Z",
				},
			],
		);

		const result = await backfillPr(
			{ db, octokit },
			{ owner: "o", repo: "r", pr: 55 },
		);

		expect(result.prComments).toBe(0);
		expect(rawRows.some((r) => r.source === "pr_comment")).toBe(false);
	});

	it("attributes a top-level comment that names one bot when both providers reviewed", async () => {
		const { octokit, db, rawRows } = buildRouteAwareDeps(
			[
				comment({ id: 1, user: { login: "anthropicreviewbot[bot]" } }),
				comment({ id: 2, user: { login: "codexreviewbot[bot]" } }),
			],
			[
				{
					id: 202,
					user: { login: "joeblackwaslike" },
					body: "codexreviewbot got this one right",
					created_at: "2026-07-30T02:00:00Z",
				},
			],
		);

		await backfillPr({ db, octokit }, { owner: "o", repo: "r", pr: 55 });

		const prCommentRow = rawRows.find((r) => r.source === "pr_comment");
		expect(prCommentRow).toMatchObject({ provider: "openai", commentId: 202 });
	});

	it("excludes bot-authored comments from pr_comment capture", async () => {
		const { octokit, db, rawRows } = buildRouteAwareDeps(
			[comment({ id: 1 })],
			[
				{
					id: 203,
					user: { login: "anthropicreviewbot[bot]" },
					body: "### ai-review-bot — review summary\n<!-- ai-review:carrier:ai-review-bot -->",
					created_at: "2026-07-30T02:00:00Z",
				},
			],
		);

		await backfillPr({ db, octokit }, { owner: "o", repo: "r", pr: 55 });
		expect(rawRows.some((r) => r.source === "pr_comment")).toBe(false);
	});

	// Flagged independently by coderabbitai, chatgpt-codex-connector, and
	// anthropicreviewbot: a provider that posted a clean review (only a carrier
	// comment, zero inline findings) was invisible to activeProviders when it
	// was derived from `findings` alone — every top-level comment on the PR was
	// silently skipped even though the bot did review it.
	it("attributes a top-level comment to a provider whose only comment was its carrier", async () => {
		const { octokit, db, rawRows } = buildRouteAwareDeps(
			[],
			[
				{
					id: 204,
					user: { login: "anthropicreviewbot[bot]" },
					body: "### ai-review-bot — review summary\n<!-- ai-review:carrier:ai-review-bot -->",
					created_at: "2026-07-30T01:00:00Z",
				},
				{
					id: 205,
					user: { login: "joeblackwaslike" },
					body: "nice, clean review",
					created_at: "2026-07-30T02:00:00Z",
				},
			],
		);

		const result = await backfillPr(
			{ db, octokit },
			{ owner: "o", repo: "r", pr: 55 },
		);

		expect(result.prComments).toBe(1);
		const prCommentRow = rawRows.find((r) => r.source === "pr_comment");
		expect(prCommentRow).toMatchObject({
			provider: "anthropic",
			commentId: 205,
		});
	});
});

describe("attributeProviderForComment", () => {
	it("attributes directly when only one provider reviewed, regardless of body", () => {
		expect(
			attributeProviderForComment(new Set(["anthropic"]), "no mention here"),
		).toBe("anthropic");
	});

	it("returns null when both providers are active and neither is named", () => {
		expect(
			attributeProviderForComment(
				new Set(["anthropic", "openai"]),
				"great work",
			),
		).toBeNull();
	});

	it("returns null when both providers are active and both are named (a tie)", () => {
		expect(
			attributeProviderForComment(
				new Set(["anthropic", "openai"]),
				"anthropicreviewbot and codexreviewbot both flagged this",
			),
		).toBeNull();
	});

	it("attributes to the one bot named when both providers are active", () => {
		expect(
			attributeProviderForComment(
				new Set(["anthropic", "openai"]),
				"@codexreviewbot nice catch",
			),
		).toBe("openai");
	});

	it("ignores a mention of a provider that isn't active", () => {
		expect(
			attributeProviderForComment(
				new Set(["anthropic"]),
				"codexreviewbot missed this",
			),
		).toBe("anthropic");
	});

	// Flagged independently by coderabbitai and anthropicreviewbot on this PR's
	// own review: a substring match on "codexreviewbot" also matches inside an
	// unrelated word or URL fragment, misattributing the comment.
	it("does not match a bot login embedded in a longer word", () => {
		expect(
			attributeProviderForComment(
				new Set(["anthropic", "openai"]),
				"don't let notcodexreviewbot fool you",
			),
		).toBeNull();
	});

	it("does not match a bot login embedded in a URL fragment", () => {
		expect(
			attributeProviderForComment(
				new Set(["anthropic", "openai"]),
				"see https://example.com/codexreviewbot-docs for details",
			),
		).toBeNull();
	});
});

// A reply says what a reviewer got wrong; the reaction is what the corpus can
// count. Answering a thread and leaving it unrated teaches the reviewer nothing,
// and the loss is silent — the corpus is simply smaller than it should be.
// Observed on ai-review-bot#47: twelve findings answered across four rounds, not
// one of them rated.
describe("findUnratedFindings", () => {
	it("flags a finding a human answered but nobody rated", () => {
		const unrated = findUnratedFindings([
			comment({ id: 1, reactions: { total_count: 0 } }),
			comment({
				id: 2,
				in_reply_to_id: 1,
				user: { login: "joeblackwaslike" },
				body: "false positive",
			}),
		]);
		expect(unrated.map((c) => c.id)).toEqual([1]);
	});

	it("passes a finding that was answered and rated", () => {
		const unrated = findUnratedFindings([
			comment({ id: 1, reactions: { total_count: 1 } }),
			comment({
				id: 2,
				in_reply_to_id: 1,
				user: { login: "joeblackwaslike" },
				body: "false positive",
			}),
		]);
		expect(unrated).toEqual([]);
	});

	// An unanswered finding is a thread nobody has triaged yet, which the
	// unresolved-thread gate already catches. Reporting it here would bury the
	// findings that really were dispositioned without a rating.
	it("ignores a finding nobody replied to", () => {
		expect(findUnratedFindings([comment({ id: 1 })])).toEqual([]);
	});

	// A third-party bot answering our finding is two machines talking, not a
	// disposition. Counting it as answered would report a finding as unrated that
	// no human has looked at, and — worse, on the backfill path that shares this
	// partition — file the bot's prose as human feedback in the corpus.
	it("does not treat another bot's reply as an answer", () => {
		// Paired with a human-answered finding in the same batch so the empty
		// result cannot be mistaken for the function simply returning nothing:
		// id 3 must come back, id 1 must not.
		const unrated = findUnratedFindings([
			comment({ id: 1, reactions: { total_count: 0 } }),
			comment({
				id: 2,
				in_reply_to_id: 1,
				user: { login: "coderabbitai[bot]" },
				body: "I agree with this finding.",
			}),
			comment({ id: 3, reactions: { total_count: 0 } }),
			comment({
				id: 4,
				in_reply_to_id: 3,
				user: { login: "joeblackwaslike" },
				body: "false positive",
			}),
		]);
		expect(unrated.map((c) => c.id)).toEqual([3]);
	});

	// A third-party reviewer's thread is not ours to rate — its reactions do not
	// reach our corpus.
	it("ignores a thread rooted on another reviewer's finding", () => {
		const unrated = findUnratedFindings([
			comment({ id: 1, user: { login: "coderabbitai[bot]" } }),
			comment({
				id: 2,
				in_reply_to_id: 1,
				user: { login: "joeblackwaslike" },
				body: "agreed",
			}),
		]);
		expect(unrated).toEqual([]);
	});
});

// The guard exists because the alternative is a wrong answer with no error
// attached: `?? 0` reads a missing key as "nobody rated it", so a response-shape
// change would report every finding as unrated and the gate would block merges
// for a reason that is not true.
describe("findingsMissingReactions", () => {
	it("reports our findings that came back without a reactions field", () => {
		const missing = findingsMissingReactions([
			comment({ id: 1, reactions: undefined }),
			comment({ id: 2, reactions: { total_count: 0 } }),
		]);
		expect(missing.map((c) => c.id)).toEqual([1]);
	});

	// Replies are never rated, so they carry no reactions by design and must not
	// trip a guard about response shape.
	it("ignores replies, which are not rated in the first place", () => {
		const missing = findingsMissingReactions([
			comment({ id: 1, reactions: { total_count: 0 } }),
			comment({
				id: 2,
				in_reply_to_id: 1,
				reactions: undefined,
				user: { login: "joeblackwaslike" },
				body: "false positive",
			}),
		]);
		expect(missing).toEqual([]);
	});
});
