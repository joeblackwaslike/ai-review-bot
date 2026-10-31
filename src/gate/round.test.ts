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

	it("a finding matching both an open and a settled entry is emitted under the open id and not inferred fixed", () => {
		const settled = entry({ status: "rejected", decidedBy: "author" });
		const open = entry({ id: "ai-review-oooooooooooo" });
		const result = applyRound(
			input({
				store: store([settled, open]),
				hashes: new Map([["src/a.ts", "h2"]]),
				merged: buildModelReview({ inline_comments: [paraphrase(open)] }),
			}),
		);
		expect(result.suppressed).toBe(0);
		expect(result.emitted.map((e) => e.entry.id)).toEqual([open.id]);
		expect(byId(result.store, open.id)?.status).toBe("open");
		expect(byId(result.store, settled.id)).toEqual(settled);
	});

	it("the settled list is built before the round starts, so a matched open entry is emitted and only the unmatched one is fixed", () => {
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

	it("a provider set missing a stored provider infers nothing and warns", () => {
		const old = entry();
		const result = applyRound(
			input({
				store: store([old], ["anthropic", "openai"]),
				hashes: new Map([["src/a.ts", "h2"]]),
				providers: ["openai"],
			}),
		);
		expect(byId(result.store, old.id)?.status).toBe("open");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(/provider/i);
		expect(result.store.providers).toEqual(["anthropic", "openai"]);
		expect(result.store.lastHead).toBe("head1");
	});

	it("a mismatch round adds the providers that ran to the stored set and keeps lastHead", () => {
		const result = applyRound(
			input({
				store: store([entry()], ["anthropic"]),
				hashes: new Map([["src/a.ts", "h2"]]),
				providers: ["openai"],
			}),
		);
		expect(result.store.entries[0]?.status).toBe("open");
		expect(result.store.providers).toEqual(["anthropic", "openai"]);
		expect(result.store.lastHead).toBe("head1");
		expect(result.warnings.join("\n")).toMatch(/do not include every provider/);
	});

	it("an incomplete round still adds the providers that ran", () => {
		const result = applyRound(
			input({
				store: store([entry()], ["anthropic"]),
				providers: ["anthropic", "openai"],
				complete: false,
			}),
		);
		expect(result.store.providers).toEqual(["anthropic", "openai"]);
		expect(result.store.lastHead).toBe("head1");
	});

	it("an equal provider set leaves the stored set unchanged and advances lastHead", () => {
		const result = applyRound(
			input({
				store: store([entry()], ["anthropic"]),
				providers: ["anthropic"],
			}),
		);
		expect(result.store.providers).toEqual(["anthropic"]);
		expect(result.store.lastHead).toBe(HEAD);
	});

	it("the mismatch warning names providers that authenticated with no successful agent", () => {
		const result = applyRound(
			input({
				store: store([entry()], ["anthropic", "openai"]),
				providers: ["anthropic"],
				idleProviders: [{ provider: "openai", succeeded: 0, attempted: 5 }],
			}),
		);
		expect(result.warnings.join("\n")).toContain("openai 0/5");
	});

	it("a larger provider set infers fixes and replaces the stored set", () => {
		const old = entry();
		const result = applyRound(
			input({
				store: store([old], ["anthropic"]),
				hashes: new Map([["src/a.ts", "h2"]]),
				providers: ["openai", "anthropic"],
			}),
		);
		expect(byId(result.store, old.id)?.status).toBe("fixed");
		expect(result.warnings).toEqual([]);
		expect(result.store.providers).toEqual(["anthropic", "openai"]);
		expect(result.store.lastHead).toBe(HEAD);
	});

	it("a first round with one provider then a round with both infers the fix", () => {
		const p1 = buildInlineComment({
			path: "src/a.ts",
			severity: "P1",
			title: "Empty catch swallows the error",
		});
		const first = applyRound(
			input({
				store: { ...store([]), providers: [], lastHead: null },
				merged: buildModelReview({ inline_comments: [p1] }),
				head: "head1",
				round: 1,
				hashes: new Map([["src/a.ts", "h1"]]),
				providers: ["anthropic"],
			}),
		);
		const second = applyRound(
			input({
				store: first.store,
				head: "head2",
				round: 2,
				hashes: new Map([["src/a.ts", "h2"]]),
				providers: ["anthropic", "openai"],
			}),
		);
		expect(first.store.providers).toEqual(["anthropic"]);
		expect(second.store.entries.map((e) => e.status)).toEqual(["fixed"]);
		expect(second.store.providers).toEqual(["anthropic", "openai"]);
		expect(second.store.lastHead).toBe("head2");
		expect(second.warnings).toEqual([]);
	});

	it("a provider-set change still matches and emits, and the warning names the store file", () => {
		const old = entry();
		const fresh = buildInlineComment({
			path: "src/b.ts",
			title: "Unrelated new finding",
		});
		const result = applyRound(
			input({
				store: store([old], ["anthropic", "openai"]),
				merged: buildModelReview({ inline_comments: [fresh] }),
				providers: ["anthropic"],
				storePath: "/tmp/gate/key.json",
			}),
		);
		expect(result.emitted.map((e) => e.entry.path)).toEqual(["src/b.ts"]);
		expect(result.store.entries).toHaveLength(2);
		expect(result.store.providers).toEqual(["anthropic", "openai"]);
		expect(result.store.lastHead).toBe("head1");
		expect(result.warnings.join("\n")).toContain("/tmp/gate/key.json");
	});

	it("a provider-set change warns even with no open entry", () => {
		const result = applyRound(
			input({
				store: store([], ["anthropic", "openai"]),
				providers: ["anthropic"],
			}),
		);
		expect(result.warnings.join("\n")).toMatch(/provider/i);
		expect(result.store.lastHead).toBe("head1");
	});

	it("the first complete round records its provider set over an empty one", () => {
		const result = applyRound(
			input({
				store: { ...store([]), providers: [], lastHead: null },
				providers: ["anthropic", "openai"],
			}),
		);
		expect(result.store.providers).toEqual(["anthropic", "openai"]);
		expect(result.store.lastHead).toBe(HEAD);
		expect(result.warnings).toEqual([]);
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
		const result = applyRound(
			input({
				store: store([old]),
				hashes: new Map([["src/b.ts", "h2"]]),
				reviewedPaths: new Set(["src/a.ts"]),
			}),
		);
		expect(byId(result.store, old.id)).toEqual(old);
	});

	it("a finding restating an entry in an unreviewed file keeps its id", () => {
		const old = entry({ path: "src/b.ts" });
		const result = applyRound(
			input({
				store: store([old]),
				hashes: new Map([["src/b.ts", "h1"]]),
				reviewedPaths: new Set(["src/a.ts"]),
				merged: buildModelReview({ inline_comments: [paraphrase(old)] }),
			}),
		);
		expect(result.emitted.map((e) => e.entry.id)).toEqual([old.id]);
		expect(result.store.entries).toHaveLength(1);
	});

	it("a file that left the range is fixed even when no path was reviewed", () => {
		const old = entry({ path: "src/gone.ts" });
		const result = applyRound(
			input({ store: store([old]), reviewedPaths: new Set() }),
		);
		expect(byId(result.store, old.id)?.status).toBe("fixed");
	});

	it("a finding re-raised after an inferred fix reopens the entry under its id", () => {
		const raised = (line: number) =>
			buildModelReview({
				inline_comments: [
					buildInlineComment({
						path: "src/a.ts",
						line,
						severity: "P1",
						title: "Retry loop swallows the fetch error",
						body: "The catch block in fetchWithRetry discards the error and returns undefined.",
					}),
				],
			});
		const round1 = applyRound(
			input({
				store: emptyStore(),
				head: "h1",
				round: 1,
				merged: raised(10),
			}),
		);
		const id = round1.emitted[0].entry.id;
		const round2 = applyRound(
			input({
				store: round1.store,
				head: "h2",
				round: 2,
				hashes: new Map([["src/a.ts", "h2"]]),
			}),
		);
		expect(byId(round2.store, id)?.status).toBe("fixed");

		const round3 = applyRound(
			input({
				store: round2.store,
				head: "h3",
				round: 3,
				hashes: new Map([["src/a.ts", "h3"]]),
				merged: raised(30),
			}),
		);
		expect(round3.suppressed).toBe(0);
		expect(round3.emitted).toHaveLength(1);
		expect(round3.emitted[0].entry).toMatchObject({
			id,
			status: "open",
			decidedBy: null,
			line: 30,
			round: 3,
			evidence: ["head:h3", "diff:h3"],
		});
		expect(byId(round3.store, id)).toEqual(round3.emitted[0].entry);
		expect(round3.store.entries).toHaveLength(1);
	});

	it("a reopened entry is not inferred fixed in the same round", () => {
		const inferred = entry({
			status: "fixed",
			evidence: [
				"head:head1",
				"diff:h1",
				"inferred: absent after diff changed",
			],
		});
		const result = applyRound(
			input({
				store: store([inferred]),
				hashes: new Map([["src/a.ts", "h2"]]),
				merged: buildModelReview({ inline_comments: [paraphrase(inferred)] }),
			}),
		);
		expect(byId(result.store, inferred.id)).toMatchObject({
			status: "open",
			evidence: ["head:head2", "diff:h2"],
		});
	});

	it("an entry an author settled still suppresses a re-raise", () => {
		const settled = entry({ status: "fixed", decidedBy: "author" });
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

	it("a renamed entry a person settled suppresses a finding at the new path", () => {
		const settled = entry({
			path: "src/old.ts",
			status: "rejected",
			decidedBy: "reviewer",
		});
		const finding = paraphrase({ ...settled, path: "src/new.ts" });
		const result = applyRound(
			input({
				store: store([settled]),
				renames: new Map([["src/old.ts", "src/new.ts"]]),
				hashes: new Map([["src/new.ts", "h1"]]),
				merged: buildModelReview({ inline_comments: [finding] }),
			}),
		);
		expect(result.suppressed).toBe(1);
		expect(result.emitted).toEqual([]);
	});

	it("does not modify a frozen non-empty store", () => {
		const deepFreeze = <T>(o: T): T => {
			for (const v of Object.values(o as object)) {
				if (v && typeof v === "object") deepFreeze(v);
			}
			return Object.freeze(o);
		};
		const open = entry();
		const settled = entry({
			id: "ai-review-ssssssssssss",
			path: "src/old.ts",
			status: "rejected",
			decidedBy: "author",
		});
		const inferred = entry({
			id: "ai-review-ffffffffffff",
			path: "src/c.ts",
			status: "fixed",
		});
		const frozen = deepFreeze(store([open, settled, inferred]));
		const snapshot = structuredClone(frozen);
		expect(() =>
			applyRound(
				input({
					store: frozen,
					renames: new Map([["src/old.ts", "src/new.ts"]]),
					hashes: new Map([["src/a.ts", "h2"]]),
					merged: buildModelReview({
						inline_comments: [paraphrase(inferred), paraphrase(open)],
					}),
				}),
			),
		).not.toThrow();
		expect(frozen).toEqual(snapshot);
	});

	it("the provider warning names the last complete round, not an empty set", () => {
		const result = applyRound(
			input({
				store: { ...store([entry()]), providers: [], lastHead: null },
			}),
		);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).not.toMatch(/none ->/);
		expect(result.warnings[0]).toMatch(/no provider has reviewed/i);
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

describe("cross-file matching", () => {
	it("a same-title finding in another file mints a new entry and leaves the original in place", () => {
		const old = entry({ title: "fetchWithRetry swallows the fetch error" });
		const result = applyRound(
			input({
				store: store([old]),
				merged: buildModelReview({
					inline_comments: [
						buildInlineComment({
							path: "src/b.ts",
							line: 10,
							title: old.title,
							body: old.body ?? "",
						}),
					],
				}),
				hashes: new Map([
					["src/a.ts", "h1"],
					["src/b.ts", "hb"],
				]),
				reviewedPaths: new Set(["src/b.ts"]),
			}),
		);
		expect(byId(result.store, old.id)).toMatchObject({
			path: "src/a.ts",
			status: "open",
		});
		expect(result.emitted).toHaveLength(1);
		expect(result.emitted[0]?.entry.id).not.toBe(old.id);
		expect(result.emitted[0]?.entry.path).toBe("src/b.ts");
	});

	it("a general finding still matches a path-less entry", () => {
		const gen = entry({
			id: "ai-review-gggggggggggg",
			path: null,
			line: null,
			title: "Retry policy is undocumented across the whole module",
			body: "Nothing explains how many attempts the client makes before giving up.",
		});
		const result = applyRound(
			input({
				store: store([gen]),
				merged: buildModelReview({
					general_findings: [
						general({ title: gen.title, body: gen.body ?? "" }),
					],
				}),
			}),
		);
		expect(result.emitted.map((e) => e.entry.id)).toEqual([gen.id]);
	});
});
