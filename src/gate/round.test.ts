import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../ledger/types.js";
import type { ModelReview } from "../review.js";
import { buildInlineComment, buildModelReview } from "../testing.js";
import { applyRound, type RoundInput } from "./round.js";
import { emptyStore, type GateStore } from "./store.js";

const HEAD = "head2";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const mintedId = (path: string, title: string, head = HEAD) =>
	`ai-review-${sha1(`${path}|${title}|${head}`).slice(0, 12)}`;

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
	return {
		id: "ai-review-aaaaaaaaaaaa",
		round: 1,
		path: "src/a.ts",
		line: 10,
		severity: "P2",
		title: "Retry loop swallows the fetch error",
		body: "The catch block in fetchWithRetry discards the error and returns undefined after the last attempt.",
		status: "open",
		decidedBy: null,
		reason: null,
		evidence: ["head:head1", "diff:h1"],
		...overrides,
	};
}

function general(
	overrides: Partial<ModelReview["general_findings"][number]> = {},
): ModelReview["general_findings"][number] {
	return {
		title: "General concern",
		body: "Something about the whole change.",
		severity: "P2",
		category: "architecture",
		confidence: 0.8,
		evidence: "See diff.",
		suppressible: true,
		...overrides,
	};
}

function store(entries: LedgerEntry[], providers = ["anthropic"]): GateStore {
	return {
		...emptyStore(),
		providers: providers as GateStore["providers"],
		lastHead: "head1",
		entries,
	};
}

function input(overrides: Partial<RoundInput> = {}): RoundInput {
	return {
		merged: buildModelReview(),
		store: store([]),
		head: HEAD,
		round: 2,
		hashes: new Map([["src/a.ts", "h1"]]),
		renames: new Map(),
		reviewedPaths: "all",
		complete: true,
		providers: ["anthropic"],
		fullRescope: false,
		...overrides,
	};
}

const paraphrase = (e: LedgerEntry) =>
	buildInlineComment({
		path: e.path ?? "src/a.ts",
		line: (e.line ?? 10) + 2,
		title: "fetchWithRetry hides failures",
		body: e.body ?? "",
	});

const byId = (s: GateStore, id: string) => s.entries.find((e) => e.id === id);

describe("applyRound", () => {
	it("a new finding becomes an open entry with a minted id", () => {
		const finding = buildInlineComment({
			path: "src/a.ts",
			title: "Missing null check",
			severity: "P3",
			suggestion: "if (!x) return;",
		});
		const given = input({
			merged: buildModelReview({ inline_comments: [finding] }),
		});
		const snapshot = structuredClone({ ...given, hashes: [...given.hashes] });

		const result = applyRound(given);

		const id = mintedId("src/a.ts", "Missing null check");
		expect(result.emitted).toHaveLength(1);
		expect(result.emitted[0].suggestion).toBe("if (!x) return;");
		expect(result.emitted[0].entry).toEqual({
			id,
			round: 2,
			path: "src/a.ts",
			line: finding.line,
			severity: "P3",
			title: "Missing null check",
			body: finding.body,
			action: "no-op",
			status: "open",
			decidedBy: null,
			reason: null,
			evidence: ["head:head2", "diff:h1"],
		});
		expect(byId(result.store, id)).toEqual(result.emitted[0].entry);
		expect(result.store.lastHead).toBe(HEAD);
		expect(result.suppressed).toBe(0);
		expect(result.warnings).toEqual([]);
		expect({ ...given, hashes: [...given.hashes] }).toEqual(snapshot);
	});

	it("a general finding gets path - in its id and diff:none evidence", () => {
		const result = applyRound(
			input({ merged: buildModelReview({ general_findings: [general()] }) }),
		);
		expect(result.emitted[0].entry.id).toBe(mintedId("-", "General concern"));
		expect(result.emitted[0].entry.evidence).toEqual([
			"head:head2",
			"diff:none",
		]);
		expect(result.emitted[0].suggestion).toBeNull();
		expect(result.emitted[0].entry.action).toBe("ask-user");
	});

	it("a paraphrased title on an open finding keeps its id", () => {
		const old = entry();
		const finding = paraphrase(old);
		const result = applyRound(
			input({
				store: store([old]),
				hashes: new Map([["src/a.ts", "h2"]]),
				merged: buildModelReview({ inline_comments: [finding] }),
			}),
		);
		expect(result.emitted).toHaveLength(1);
		expect(result.emitted[0].entry).toMatchObject({
			id: old.id,
			title: finding.title,
			line: finding.line,
			body: finding.body,
			round: 2,
			status: "open",
			evidence: ["head:head2", "diff:h2"],
		});
		expect(result.store.entries).toHaveLength(1);
	});

	it("an open entry is claimed by at most one finding per round", () => {
		const old = entry();
		const first = paraphrase(old);
		const second = { ...paraphrase(old), line: (old.line ?? 0) + 4 };
		const result = applyRound(
			input({
				store: store([old]),
				merged: buildModelReview({ inline_comments: [first, second] }),
			}),
		);
		const ids = result.emitted.map((e) => e.entry.id);
		expect(ids[0]).toBe(old.id);
		expect(ids[1]).not.toBe(old.id);
		expect(new Set(result.store.entries.map((e) => e.id)).size).toBe(2);
	});

	it("an unmatched open entry whose diff changed becomes fixed", () => {
		const old = entry();
		const gen = entry({ id: "ai-review-gggggggggggg", path: null, line: null });
		const result = applyRound(
			input({
				store: store([old, gen], ["openai", "anthropic"]),
				providers: ["anthropic", "openai"],
				hashes: new Map([["src/a.ts", "h2"]]),
			}),
		);
		expect(byId(result.store, old.id)).toMatchObject({
			status: "fixed",
			decidedBy: null,
			evidence: [
				"head:head1",
				"diff:h1",
				"inferred: absent after diff changed",
			],
		});
		expect(byId(result.store, gen.id)?.status).toBe("open");
		expect(result.warnings).toEqual([]);
	});

	it("an unmatched open entry whose diff is unchanged stays open", () => {
		const old = entry();
		const result = applyRound(input({ store: store([old]) }));
		expect(byId(result.store, old.id)).toEqual(old);
	});

	it("a rebase that moves the base but not the file's diff does not mark it fixed", () => {
		const old = entry();
		const result = applyRound(
			input({ store: store([old]), head: "rebased-head" }),
		);
		expect(byId(result.store, old.id)?.status).toBe("open");
		expect(result.store.lastHead).toBe("rebased-head");
	});

	it("a file that left the range is fixed", () => {
		const old = entry({ path: "src/gone.ts" });
		const result = applyRound(input({ store: store([old]) }));
		expect(byId(result.store, old.id)?.status).toBe("fixed");
	});

	it("a rename keeps the id and moves the path", () => {
		const old = entry({ path: "src/old.ts" });
		const result = applyRound(
			input({
				store: store([old]),
				renames: new Map([["src/old.ts", "src/new.ts"]]),
				hashes: new Map([["src/new.ts", "h1"]]),
			}),
		);
		expect(result.store.entries).toHaveLength(1);
		expect(byId(result.store, old.id)).toMatchObject({
			path: "src/new.ts",
			status: "open",
		});
	});

	it("a finding already settled before the round is suppressed", () => {
		const settled = entry({
			status: "rejected",
			decidedBy: "author",
			reason: "intended",
		});
		const result = applyRound(
			input({
				store: store([settled]),
				merged: buildModelReview({ inline_comments: [paraphrase(settled)] }),
			}),
		);
		expect(result.suppressed).toBe(1);
		expect(result.emitted).toEqual([]);
		expect(result.store.entries).toEqual([settled]);
	});

	it("suppression runs before open matching when a finding matches both", () => {
		const settled = entry({ status: "rejected", decidedBy: "author" });
		const open = entry({ id: "ai-review-oooooooooooo" });
		const result = applyRound(
			input({
				store: store([settled, open]),
				merged: buildModelReview({ inline_comments: [paraphrase(open)] }),
			}),
		);
		expect(result.suppressed).toBe(1);
		expect(result.emitted).toEqual([]);
		expect(byId(result.store, open.id)).toEqual(open);
	});

	it("an entry inferred fixed this round does not suppress a paraphrase in the same round", () => {
		const old = entry();
		const other = entry({ id: "ai-review-bbbbbbbbbbbb", path: "src/b.ts" });
		const finding = paraphrase(old);
		const result = applyRound(
			input({
				store: store([old, other]),
				hashes: new Map([
					["src/a.ts", "h2"],
					["src/b.ts", "h2"],
				]),
				merged: buildModelReview({ inline_comments: [finding] }),
			}),
		);
		expect(result.suppressed).toBe(0);
		expect(result.emitted.map((e) => e.entry.id)).toEqual([old.id]);
		expect(byId(result.store, old.id)?.status).toBe("open");
		expect(byId(result.store, other.id)?.status).toBe("fixed");
	});

	it("an incomplete round infers nothing and warns", () => {
		const old = entry();
		const result = applyRound(
			input({
				store: store([old]),
				hashes: new Map([["src/a.ts", "h2"]]),
				complete: false,
			}),
		);
		expect(byId(result.store, old.id)?.status).toBe("open");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(/incomplete/i);
		expect(result.store.lastHead).toBe("head1");
		expect(result.store.providers).toEqual(["anthropic"]);
	});

	it("a provider-set change infers nothing and warns", () => {
		const old = entry();
		const result = applyRound(
			input({
				store: store([old]),
				hashes: new Map([["src/a.ts", "h2"]]),
				providers: ["anthropic", "openai"],
			}),
		);
		expect(byId(result.store, old.id)?.status).toBe("open");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(/provider/i);
		expect(result.store.providers).toEqual(["anthropic", "openai"]);
		expect(result.store.lastHead).toBe(HEAD);
	});

	it("fullRescope infers nothing", () => {
		const old = entry();
		const result = applyRound(
			input({
				store: store([old]),
				hashes: new Map([["src/a.ts", "h2"]]),
				fullRescope: true,
			}),
		);
		expect(byId(result.store, old.id)?.status).toBe("open");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(/rescope/i);
	});

	it("entries for files outside reviewedPaths are left alone", () => {
		const old = entry({ path: "src/b.ts" });
		const finding = paraphrase(old);
		const result = applyRound(
			input({
				store: store([old]),
				hashes: new Map([["src/b.ts", "h2"]]),
				reviewedPaths: new Set(["src/a.ts"]),
				merged: buildModelReview({ inline_comments: [finding] }),
			}),
		);
		expect(byId(result.store, old.id)).toEqual(old);
		expect(result.emitted).toHaveLength(1);
		expect(result.emitted[0].entry.id).not.toBe(old.id);
	});

	it("two findings with the same hash input get -2 in body-hash order regardless of input order", () => {
		const a = buildInlineComment({
			path: "src/a.ts",
			line: 3,
			title: "Dup",
			body: "alpha body",
		});
		const b = buildInlineComment({
			path: "src/a.ts",
			line: 40,
			title: "Dup",
			body: "beta body",
		});
		const base = mintedId("src/a.ts", "Dup");
		const [first, second] =
			sha1("alpha body") < sha1("beta body")
				? ["alpha body", "beta body"]
				: ["beta body", "alpha body"];
		const expected = { [first]: base, [second]: `${base}-2` };

		for (const order of [
			[a, b],
			[b, a],
		]) {
			const result = applyRound(
				input({ merged: buildModelReview({ inline_comments: order }) }),
			);
			const ids = Object.fromEntries(
				result.emitted.map((e) => [e.entry.body, e.entry.id]),
			);
			expect(ids).toEqual(expected);
		}
	});
});
