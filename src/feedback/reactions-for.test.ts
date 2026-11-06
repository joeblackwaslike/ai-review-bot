import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../ledger/types.js";
import type { KvClient } from "./kv.js";
import { loadReactionsFor, reactionsFor } from "./reactions-for.js";
import type { PostedCommentRecord, Verdict } from "./types.js";

function record(
	reactions: Record<string, Verdict>,
	over: Partial<PostedCommentRecord> = {},
): PostedCommentRecord {
	return {
		commentId: 1,
		provider: "anthropic",
		installationId: 1,
		owner: "o",
		repo: "r",
		pr: 1,
		headSha: "abc",
		path: "src/a.ts",
		line: 10,
		skills: [],
		title: "Null deref",
		body: "",
		postedAtMs: 0,
		expiresAtMs: 1,
		lastSeenReactions: reactions,
		...over,
	};
}

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
	return {
		path: "src/a.ts",
		line: 10,
		title: "Null deref",
		...over,
	} as LedgerEntry;
}

describe("reactionsFor", () => {
	it("returns the verdict of the joined record", () => {
		const f = reactionsFor([record({ alice: "down" })]);
		expect(f(entry())).toEqual(["down"]);
	});

	it("accumulates the verdicts of records sharing a path, line and title", () => {
		const f = reactionsFor([
			record({ alice: "down" }, { commentId: 1 }),
			record({ bob: "up" }, { commentId: 2 }),
		]);
		expect(f(entry())).toEqual(["down", "up"]);
	});

	it("returns [] for an unmatched entry", () => {
		const f = reactionsFor([record({ alice: "down" })]);
		expect(f(entry({ line: 11 }))).toEqual([]);
		expect(f(entry({ title: "Other" }))).toEqual([]);
	});

	it("returns every reactor's verdict", () => {
		const f = reactionsFor([record({ alice: "down", bob: "up" })]);
		expect(f(entry()).sort()).toEqual(["down", "up"]);
	});

	it("returns [] for everything when there are no records", () => {
		expect(reactionsFor([])(entry())).toEqual([]);
	});

	it("joins through case and surrounding whitespace in the title", () => {
		const f = reactionsFor([record({ alice: "down" })]);
		expect(f(entry({ title: "  NULL deref " }))).toEqual(["down"]);
	});

	it("returns [] for an entry with a null path or line", () => {
		const f = reactionsFor([record({ alice: "down" })]);
		expect(f(entry({ path: null }))).toEqual([]);
		expect(f(entry({ line: null }))).toEqual([]);
	});
});

describe("loadReactionsFor", () => {
	const pr = {
		owner: "o",
		repo: "r",
		pullNumber: 1,
		provider: "anthropic" as const,
	};
	const kvOf = (records: PostedCommentRecord[]) =>
		({
			zrangebyscore: vi.fn(async () => records.map((_, i) => `anthropic:${i}`)),
			get: vi.fn(async (k: string) =>
				JSON.stringify(records[Number(k.split(":").pop())]),
			),
		}) as unknown as KvClient;

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("joins only records for this owner, repo and PR", async () => {
		const kv = kvOf([
			record({ alice: "up" }, { owner: "other" }),
			record({ alice: "up" }, { repo: "other" }),
			record({ alice: "up" }, { pr: 2 }),
			record({ alice: "down" }),
		]);
		const f = await loadReactionsFor(() => kv, pr);
		expect(f(entry())).toEqual(["down"]);
	});

	it("does not join a record from the other provider at the same path, line and title", async () => {
		const kv = kvOf([
			record({ alice: "down" }),
			record({ alice: "up" }, { provider: "openai" }),
		]);
		const f = await loadReactionsFor(() => kv, pr);
		expect(f(entry())).toEqual(["down"]);
	});

	it("gives up after the timeout and stops reading the remaining records", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const releases: Array<() => void> = [];
		const get = vi.fn(
			() =>
				new Promise<string | null>((resolve) => {
					releases.push(() =>
						resolve(JSON.stringify(record({ alice: "down" }))),
					);
				}),
		);
		const kv = {
			zrangebyscore: vi.fn(async () => ["a:1", "a:2", "a:3", "a:4", "a:5"]),
			get,
		} as unknown as KvClient;

		const pending = loadReactionsFor(() => kv, pr);
		await vi.advanceTimersByTimeAsync(3_000);
		const f = await pending;
		expect(f(entry())).toEqual([]);

		const issued = get.mock.calls.length;
		for (let i = 0; i < 6; i++) {
			releases.splice(0).forEach((r) => {
				r();
			});
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(get.mock.calls.length).toBeLessThanOrEqual(issued + 1);
		expect(get.mock.calls.length).toBeLessThan(5);
	});
});
