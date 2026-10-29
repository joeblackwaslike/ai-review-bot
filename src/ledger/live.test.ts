import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedFinding } from "../review-state.js";
import { buildStrictOctokit } from "../testing.js";
import type { RequestLike } from "./github.js";
import {
	LEDGER_TIMEOUT_MS,
	loadLedger,
	reconcileSurvivingPrior,
} from "./live.js";
import type { LedgerEntry } from "./types.js";

const opts = { owner: "o", repo: "r", pull: 1, commentPrefix: "Bot" };

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
	id: "r0:c1:0",
	round: 0,
	path: "src/a.ts",
	line: 10,
	severity: "P1",
	title: "loadUser leaks credentials after timeout",
	status: "rejected",
	decidedBy: "author",
	reason: "this is intentional",
	evidence: [],
	...over,
});

const prior = (over: Partial<PersistedFinding>): PersistedFinding => ({
	id: "f1",
	path: "src/a.ts",
	line: 10,
	title: "loadUser leaks credentials after timeout",
	severity: "P1",
	status: "open",
	...over,
});

describe("loadLedger", () => {
	it("swallows a thrown fetch and returns a cold, empty ledger", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const octokit: RequestLike = {
			request: (async () => {
				throw new Error("boom");
			}) as RequestLike["request"],
		};
		await expect(loadLedger(octokit, opts)).resolves.toEqual({
			ledger: [],
			warm: false,
			reviewIds: [],
		});
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("treats a malformed response as cold", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const octokit: RequestLike = {
			request: (async () => undefined) as unknown as RequestLike["request"],
		};
		await expect(loadLedger(octokit, opts)).resolves.toEqual({
			ledger: [],
			warm: false,
			reviewIds: [],
		});
		warn.mockRestore();
	});

	it("loadLedger returns reviewIds and an empty list when cold", async () => {
		const graphql = vi.fn((_p: Record<string, unknown>) => ({
			data: {
				repository: {
					pullRequest: {
						author: { login: "joe" },
						reviewThreads: {
							nodes: [],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		}));
		const warm = await loadLedger(
			buildStrictOctokit({
				"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": (p) =>
					p.page === 1
						? [
								{
									id: 7,
									body: "### Bot\nx",
									submitted_at: "2026-01-01T00:00:00Z",
								},
							]
						: [],
				"GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": () => [],
				"POST /graphql": graphql,
			}),
			opts,
		);
		expect(warm.warm).toBe(true);
		expect(warm.reviewIds).toEqual([7]);
		expect(graphql.mock.calls[0]?.[0]).toMatchObject({
			variables: { owner: "o", repo: "r", pr: 1 },
		});

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const cold = await loadLedger(buildStrictOctokit({}), opts);
		expect(cold).toEqual({ ledger: [], warm: false, reviewIds: [] });
		warn.mockRestore();
	});
});

describe("loadLedger timeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns cold when a request never settles", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const octokit: RequestLike = {
			request: (() => new Promise(() => {})) as RequestLike["request"],
		};

		const loaded = loadLedger(octokit, opts);
		await vi.advanceTimersByTimeAsync(LEDGER_TIMEOUT_MS);

		await expect(loaded).resolves.toEqual({
			ledger: [],
			warm: false,
			reviewIds: [],
		});
		warn.mockRestore();
	});
});

describe("reconcileSurvivingPrior", () => {
	it("drops a prior finding the ledger shows settled", () => {
		expect(reconcileSurvivingPrior([prior({})], [entry({})])).toEqual([]);
	});

	it("keeps prior findings the ledger does not settle", () => {
		const unmatched = prior({
			id: "f2",
			path: "src/b.ts",
			line: 3,
			title: "Retry loop never backs off on 429",
		});
		const stillOpen = prior({ id: "f3" });
		expect(
			reconcileSurvivingPrior(
				[unmatched, stillOpen],
				[entry({ status: "open", reason: null })],
			),
		).toEqual([unmatched, stillOpen]);
	});

	it("keeps everything when the ledger is empty", () => {
		const all = [prior({})];
		expect(reconcileSurvivingPrior(all, [])).toEqual(all);
	});
});
