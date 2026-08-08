import { afterEach, describe, expect, it } from "vitest";
import {
	fetchPrReviews,
	PEER_REVIEW_BOTS,
	peersExpectedInRepo,
	resetPeersExpectedCache,
	shouldRunNow,
	summarizePeers,
} from "./peers.js";

const HEAD = "abc123";

function review(login: string, sha = HEAD) {
	return { user: { login }, commit_id: sha };
}

describe("summarizePeers", () => {
	it("counts a peer that reviewed the current head as arrived", () => {
		const status = summarizePeers([review("coderabbitai[bot]")], HEAD);
		expect(status).toEqual({
			arrived: ["coderabbitai[bot]"],
			seenOnPr: ["coderabbitai[bot]"],
		});
	});

	// A peer's review of an older commit says nothing about the diff we are
	// about to review, so it must not satisfy the wait.
	it("counts a stale peer review as engaged but not arrived", () => {
		const status = summarizePeers([review("coderabbitai[bot]", "old")], HEAD);
		expect(status.arrived).toEqual([]);
		expect(status.seenOnPr).toEqual(["coderabbitai[bot]"]);
	});

	it("ignores our own bots — waiting for ourselves would deadlock", () => {
		const status = summarizePeers(
			[review("anthropicreviewbot[bot]"), review("codexreviewbot[bot]")],
			HEAD,
		);
		expect(status).toEqual({ arrived: [], seenOnPr: [] });
	});

	it("ignores humans", () => {
		expect(summarizePeers([review("joeblackwaslike")], HEAD).seenOnPr).toEqual(
			[],
		);
	});

	it("deduplicates a peer that reviewed several times", () => {
		const status = summarizePeers(
			[review("sourcery-ai[bot]"), review("sourcery-ai[bot]")],
			HEAD,
		);
		expect(status.arrived).toEqual(["sourcery-ai[bot]"]);
	});
});

describe("shouldRunNow", () => {
	const base = { peersExpectedInRepo: true, attempt: 1, maxAttempts: 5 };

	it("runs once every engaged peer has reviewed the current head", () => {
		expect(
			shouldRunNow({
				...base,
				status: {
					arrived: ["coderabbitai[bot]"],
					seenOnPr: ["coderabbitai[bot]"],
				},
			}),
		).toEqual({ run: true, reason: "peers-arrived" });
	});

	it("keeps waiting while an engaged peer has not caught up to the head", () => {
		expect(
			shouldRunNow({
				...base,
				status: {
					arrived: ["coderabbitai[bot]"],
					seenOnPr: ["coderabbitai[bot]", "sourcery-ai[bot]"],
				},
			}),
		).toEqual({ run: false, reason: "wait" });
	});

	// A repo with no review bots installed should never wait at all.
	it("runs immediately when no peer is expected in this repo", () => {
		expect(
			shouldRunNow({
				...base,
				peersExpectedInRepo: false,
				status: { arrived: [], seenOnPr: [] },
			}),
		).toEqual({ run: true, reason: "no-peers-expected" });
	});

	it("still waits in a repo where peers exist but none has posted yet", () => {
		expect(
			shouldRunNow({ ...base, status: { arrived: [], seenOnPr: [] } }),
		).toEqual({ run: false, reason: "wait" });
	});

	// A peer that never arrives must not starve us — which is exactly how our
	// own Codex bot went unreviewed across an entire PR.
	it("runs at the ceiling rather than waiting forever", () => {
		expect(
			shouldRunNow({
				...base,
				attempt: 5,
				status: { arrived: [], seenOnPr: ["coderabbitai[bot]"] },
			}),
		).toEqual({ run: true, reason: "ceiling" });
	});

	it("prefers peers-arrived over the ceiling when both hold", () => {
		expect(
			shouldRunNow({
				...base,
				attempt: 99,
				status: {
					arrived: ["sourcery-ai[bot]"],
					seenOnPr: ["sourcery-ai[bot]"],
				},
			}).reason,
		).toBe("peers-arrived");
	});
});

describe("peersExpectedInRepo", () => {
	afterEach(() => {
		resetPeersExpectedCache();
	});

	it("returns true when a peer bot has reviewed a PR in the repo", async () => {
		const octokit = {
			paginate: async () => [],
			request: async () => ({ data: { total_count: 3 } }),
		};
		expect(await peersExpectedInRepo(octokit, "o", "r1")).toBe(true);
	});

	it("returns false when no peer bot has ever reviewed", async () => {
		const octokit = {
			paginate: async () => [],
			request: async () => ({ data: { total_count: 0 } }),
		};
		expect(await peersExpectedInRepo(octokit, "o", "r2")).toBe(false);
	});

	it("falls back to true (fail closed) when the search API errors", async () => {
		const octokit = {
			paginate: async () => [],
			request: async () => {
				throw new Error("secondary rate limit");
			},
		};
		expect(await peersExpectedInRepo(octokit, "o", "r3")).toBe(true);
	});

	// coderabbitai/sourcery-ai post their findings as formal reviews, not
	// comments — `commenter:` would find no history for a peer that only reviews.
	it("searches with reviewed-by:, not commenter:", async () => {
		const queries: string[] = [];
		const octokit = {
			paginate: async () => [],
			request: async (_route: string, params: Record<string, unknown>) => {
				queries.push(params.q as string);
				return { data: { total_count: 0 } };
			},
		};
		await peersExpectedInRepo(octokit, "o", "r4");
		expect(queries[0]).toContain("reviewed-by:coderabbitai[bot]");
		expect(queries.join(" ")).not.toContain("commenter:");
	});

	it("caches a repo's result and skips a repeat search within the TTL", async () => {
		let calls = 0;
		const octokit = {
			paginate: async () => [],
			request: async () => {
				calls++;
				return { data: { total_count: 3 } };
			},
		};
		expect(await peersExpectedInRepo(octokit, "o", "r5")).toBe(true);
		expect(await peersExpectedInRepo(octokit, "o", "r5")).toBe(true);
		expect(calls).toBe(1);
	});

	it("does not share a cache entry across different repos", async () => {
		let calls = 0;
		const octokit = {
			paginate: async () => [],
			request: async () => {
				calls++;
				return { data: { total_count: 0 } };
			},
		};
		await peersExpectedInRepo(octokit, "o", "r6");
		await peersExpectedInRepo(octokit, "o", "r7");
		// 4 bots searched per repo (no cache hit, no early match) — 2 repos × 4.
		expect(calls).toBe(PEER_REVIEW_BOTS.length * 2);
	});

	it("does not cache a failed lookup", async () => {
		let calls = 0;
		const octokit = {
			paginate: async () => [],
			request: async () => {
				calls++;
				throw new Error("secondary rate limit");
			},
		};
		await peersExpectedInRepo(octokit, "o", "r8");
		await peersExpectedInRepo(octokit, "o", "r8");
		expect(calls).toBe(2);
	});
});

describe("fetchPrReviews", () => {
	it("returns reviews from the paginated endpoint", async () => {
		const reviews = [
			{ user: { login: "coderabbitai[bot]" }, commit_id: "abc" },
		];
		const octokit = {
			paginate: async () => reviews,
			request: async () => ({ data: {} }),
		};
		const result = await fetchPrReviews(octokit, "o", "r", 1);
		expect(result).toEqual(reviews);
	});
});
