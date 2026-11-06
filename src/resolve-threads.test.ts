import { describe, expect, it } from "vitest";
import { resolveStaleThreads } from "./resolve-threads.js";

const PREFIX = "AI Review";
const ownBody = (provider: string) =>
	`### ${PREFIX}\n\nsummary\n\n<!-- ai-review:provider=${provider} -->`;

interface FakeThread {
	id: string;
	path: string;
	body: string;
	typename: string;
	reviewBody: string;
	isResolved?: boolean;
	line?: number | null;
}

function fakeOctokit(threads: FakeThread[]) {
	const mutations: string[] = [];
	let queries = 0;
	const graphql = async (query: string, vars: Record<string, unknown>) => {
		if (query.includes("resolveReviewThread")) {
			mutations.push(vars.threadId as string);
			return {};
		}
		queries++;
		return {
			repository: {
				pullRequest: {
					reviewThreads: {
						nodes: threads.map((t) => ({
							id: t.id,
							isResolved: t.isResolved ?? false,
							path: t.path,
							line: t.line === undefined ? 7 : t.line,
							comments: {
								nodes: [
									{
										body: t.body,
										author: { __typename: t.typename },
										pullRequestReview: { body: t.reviewBody },
									},
								],
							},
						})),
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				},
			},
		};
	};
	return {
		octokit: { graphql } as Parameters<typeof resolveStaleThreads>[0],
		mutations,
		queries: () => queries,
	};
}

const botBody = `[${PREFIX}] 🟡 **P2**\n\n**Null deref**\n\ndetails`;
const resolved = [{ path: "a.ts", title: "Null deref" }];
const run = (
	octokit: Parameters<typeof resolveStaleThreads>[0],
	r = resolved,
) =>
	resolveStaleThreads(octokit, "o", "r", 1, {
		commentPrefix: PREFIX,
		reviewer: "claude",
		resolved: r,
	});

describe("resolveStaleThreads", () => {
	it("does not resolve a human thread whose body starts with **nit:**", async () => {
		const f = fakeOctokit([
			{
				id: "t1",
				path: "a.ts",
				body: "**nit:** **Null deref**",
				typename: "User",
				reviewBody: ownBody("anthropic"),
			},
		]);
		await run(f.octokit);
		expect(f.mutations).toEqual([]);
	});

	it("does not resolve a thread in a file the round did not resolve anything for", async () => {
		const f = fakeOctokit([
			{
				id: "t1",
				path: "b.ts",
				body: botBody,
				typename: "Bot",
				reviewBody: ownBody("anthropic"),
			},
		]);
		await run(f.octokit);
		expect(f.mutations).toEqual([]);
	});

	it("does not resolve the other bot's thread", async () => {
		const f = fakeOctokit([
			{
				id: "t1",
				path: "a.ts",
				body: botBody,
				typename: "Bot",
				reviewBody: ownBody("openai"),
			},
		]);
		await run(f.octokit);
		expect(f.mutations).toEqual([]);
	});

	it("resolves only the bot thread whose path and title match a resolved finding", async () => {
		const f = fakeOctokit([
			{
				id: "t1",
				path: "a.ts",
				body: botBody,
				typename: "Bot",
				reviewBody: ownBody("anthropic"),
			},
			{
				id: "t2",
				path: "a.ts",
				body: "🟡 **P2**\n\n**Other**\n\nx",
				typename: "Bot",
				reviewBody: ownBody("anthropic"),
			},
		]);
		await run(f.octokit);
		expect(f.mutations).toEqual(["t1"]);
	});

	it("resolves an outdated bot thread (null line) that matches", async () => {
		const f = fakeOctokit([
			{
				id: "t1",
				path: "a.ts",
				body: botBody,
				typename: "Bot",
				reviewBody: ownBody("anthropic"),
				line: null,
			},
		]);
		await run(f.octokit);
		expect(f.mutations).toEqual(["t1"]);
	});

	it("keeps a merged thread open when only its lead finding is resolved", async () => {
		const merged = `${botBody}\n\n---\n\n🟡 **P2**\n\n**Missing await**\n\nmore`;
		const f = fakeOctokit([
			{
				id: "t1",
				path: "a.ts",
				body: merged,
				typename: "Bot",
				reviewBody: ownBody("anthropic"),
			},
		]);
		await run(f.octokit);
		expect(f.mutations).toEqual([]);
		await run(f.octokit, [
			...resolved,
			{ path: "a.ts", title: "Missing await" },
		]);
		expect(f.mutations).toEqual(["t1"]);
	});

	it("leaves a legacy merged thread open when its claims resolve in different rounds", async () => {
		const merged = `${botBody}\n\n---\n\n🟡 **P2**\n\n**Missing await**\n\nmore`;
		const f = fakeOctokit([
			{
				id: "t1",
				path: "a.ts",
				body: merged,
				typename: "Bot",
				reviewBody: ownBody("anthropic"),
			},
		]);
		await run(f.octokit, [{ path: "a.ts", title: "Null deref" }]);
		await run(f.octokit, [{ path: "a.ts", title: "Missing await" }]);
		expect(f.mutations).toEqual([]);
	});

	it("resolves a bot thread whose body has no prefix text", async () => {
		const f = fakeOctokit([
			{
				id: "t1",
				path: "a.ts",
				body: "🟡 **P2**\n\n**Null deref**\n\ndetails",
				typename: "Bot",
				reviewBody: `### ${PREFIX}\n\nsummary\n\n<!-- ai-review:provider=anthropic -->`,
			},
		]);
		await run(f.octokit);
		expect(f.mutations).toEqual(["t1"]);
	});

	it("does nothing when resolved is empty", async () => {
		const f = fakeOctokit([]);
		await run(f.octokit, []);
		expect(f.queries()).toBe(0);
	});

	it("resolves only a custom reviewer's own threads, leaving claude and codex alone", async () => {
		const bodyFor = (marker: string) => ({
			path: "a.ts",
			body: botBody,
			typename: "Bot",
			reviewBody: `### ${PREFIX}\n\nsummary\n\n${marker}`,
		});
		const f = fakeOctokit([
			{
				id: "mine",
				...bodyFor(
					"<!-- ai-review:reviewer=gemini -->\n<!-- ai-review:provider=gemini -->",
				),
			},
			{ id: "claude", ...bodyFor("<!-- ai-review:provider=anthropic -->") },
			{ id: "codex", ...bodyFor("<!-- ai-review:provider=openai -->") },
		]);
		await resolveStaleThreads(f.octokit, "o", "r", 1, {
			commentPrefix: PREFIX,
			reviewer: "gemini",
			resolved,
		});
		expect(f.mutations).toEqual(["mine"]);
	});
});
