import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../ledger/types.js";
import { reactionsFor } from "./reactions-for.js";
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
