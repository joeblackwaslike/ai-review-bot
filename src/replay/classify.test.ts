import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type ClassFile,
	firstSeenRejected,
	isFillerText,
	resolveFinal,
	ruleClass,
	summarizeClasses,
} from "./classify.js";
import { claim, makeFixture, makeLabel, makeLabels } from "./testkit.js";
import type { CommitMeta, LabelFile, ThreadEvidence } from "./types.js";

const commit = (sha: string, path = "a.ts", ranges: [number, number][] = []) =>
	({
		sha,
		committedAt: "2026-01-01T00:00:00Z",
		files: [{ path, ranges }],
	}) as CommitMeta;

const thread = (
	commentId: number,
	over: Partial<ThreadEvidence> = {},
): ThreadEvidence => ({
	threadId: `t${commentId}`,
	commentId,
	isResolved: false,
	isOutdated: false,
	resolvedBy: null,
	replies: [],
	...over,
});

describe("isFillerText", () => {
	it.each([
		["No new findings beyond prior reviews", ""],
		["Nothing to flag", ""],
		["Summary", "This matches the design. More text."],
		["No code changes this round", ""],
	])("is true for %s", (title, text) => {
		expect(isFillerText(title, text)).toBe(true);
	});

	it.each([
		["No test coverage for the new parser", "The parser is untested."],
		["No retry on 429", "Requests fail."],
		[
			"Bad regex",
			"Use `nothing to flag` carefully.\n```\nnothing to flag\n```",
		],
	])("is false for %s", (title, text) => {
		expect(isFillerText(title, text)).toBe(false);
	});

	it("only looks at the first sentence of the text", () => {
		expect(
			isFillerText("Real", "Broken here. Nothing to flag elsewhere."),
		).toBe(false);
	});
});

describe("ruleClass", () => {
	it("returns stale when the thread is outdated", () => {
		const f = makeFixture([["a"], ["b"]]);
		f.rounds[0].claims[0].commentId = 1;
		f.threads = [thread(1, { isOutdated: true })];
		expect(
			ruleClass(f, f.rounds[1].claims[0], makeLabel("b", "rejected")),
		).toBe(null);
		expect(
			ruleClass(f, f.rounds[0].claims[0], makeLabel("a", "rejected")),
		).toBe("stale");
	});

	it("returns stale when an author reply cites a sha from an earlier round", () => {
		const f = makeFixture([["a"], ["b"], ["c"]]);
		f.rounds[1].commitsSince = [commit("abcdef1234567890")];
		const c = f.rounds[2].claims[0];
		c.commentId = 5;
		f.threads = [
			thread(5, {
				replies: [
					{
						id: 1,
						author: "me",
						createdAt: "2026-01-02T00:00:00Z",
						editedAt: null,
						body: "already handled in abcdef1",
					},
				],
			}),
		];
		expect(ruleClass(f, c, makeLabel("c", "rejected"))).toBe("stale");
	});

	it("returns null when only a hunk in the claim's own round delta touches the anchor", () => {
		const f = makeFixture([["a"], ["b"]]);
		const c = f.rounds[0].claims[0];
		c.commentId = 7;
		f.rounds[0].commitsSince = [commit("abcdef1234567890", "a.ts", [[1, 5]])];
		f.rounds[1].commitsSince = [commit("1111111222222233", "a.ts", [[1, 5]])];
		f.threads = [
			thread(7, {
				replies: [
					{
						id: 1,
						author: "me",
						createdAt: "2026-01-02T00:00:00Z",
						editedAt: null,
						body: "see 1111111",
					},
				],
			}),
		];
		expect(ruleClass(f, c, makeLabel("a", "rejected"))).toBe(null);
	});

	it("returns filler for filler text and tolerates empty text and no thread", () => {
		const f = makeFixture([["a"]]);
		const c = { ...f.rounds[0].claims[0], title: "Nothing to flag", text: "" };
		expect(ruleClass(f, c, makeLabel("a", "rejected"))).toBe("filler");
		const plain = { ...claim("p", 0), title: "Real", text: "" };
		expect(ruleClass(f, plain, makeLabel("p", "rejected"))).toBe(null);
	});

	it("never classifies a fixed claim", () => {
		const f = makeFixture([["a"]]);
		const c = { ...f.rounds[0].claims[0], title: "Nothing to flag", text: "" };
		expect(ruleClass(f, c, makeLabel("a", "fixed"))).toBe(null);
	});
});

describe("firstSeenRejected", () => {
	it("excludes the later side of a repeat pair, confirmed or proposed", () => {
		const f = makeFixture([
			["a", "x"],
			["b", "y"],
		]);
		const labels = makeLabels({
			labels: ["a", "x", "b", "y"].map((id) => makeLabel(id, "rejected")),
			repeatPairs: [
				{ later: "b", earlier: "a", confirmed: true },
				{ later: "y", earlier: "x", confirmed: false },
			],
		});
		expect(firstSeenRejected(f, labels).map((c) => c.id)).toEqual(["a", "x"]);
	});

	it("excludes non-rejected labels", () => {
		const f = makeFixture([["a", "b"]]);
		const labels = makeLabels({
			labels: [makeLabel("a", "rejected"), makeLabel("b", "fixed")],
		});
		expect(firstSeenRejected(f, labels).map((c) => c.id)).toEqual(["a"]);
	});
});

describe("resolveFinal", () => {
	it("agreement wins, disagreement or null is unadjudicated", () => {
		expect(resolveFinal({ claude: "filler", codex: "filler" })).toBe("filler");
		expect(resolveFinal({ claude: "filler", codex: "speculative" })).toBe(
			"unadjudicated",
		);
		expect(resolveFinal({ claude: null, codex: "filler" })).toBe(
			"unadjudicated",
		);
		expect(resolveFinal({ claude: "other", codex: null })).toBe(
			"unadjudicated",
		);
	});
});

describe("summarizeClasses", () => {
	const rec = (
		claimId: string,
		claude: ClassFile["records"][number]["claude"],
		codex: ClassFile["records"][number]["codex"],
	) => ({
		claimId,
		rules: null,
		claude,
		codex,
		final: resolveFinal({ claude, codex }),
		reactionOnly: false,
	});

	it("class counts plus unadjudicated equal the record count", () => {
		const files: ClassFile[] = [
			{
				fixtureId: "x",
				provisional: true,
				records: [
					rec("1", "filler", "filler"),
					rec("2", "stale", "stale"),
					rec("3", "other", "speculative"),
					rec("4", null, null),
				],
			},
		];
		const s = summarizeClasses(files, 10, 0);
		const sum =
			s.counts.filler +
			s.counts.stale +
			s.counts.contradicted +
			s.counts.speculative +
			s.counts.other +
			s.unadjudicated;
		expect(sum).toBe(4);
		expect(s.classified).toBe(2);
		expect(s.unadjudicated).toBe(2);
		expect(s.agreement).toEqual({ agreed: 2, of: 3 });
	});
});

describe("committed Claude label files", () => {
	it("firstSeenRejected totals at most 61", () => {
		const dir = new URL("./fixtures/", import.meta.url);
		let total = 0;
		for (const id of [
			"joeblackwaslike__agent-skills__10__anthropic",
			"joeblackwaslike__ai-listings__74__anthropic",
			"joeblackwaslike__stealth-browser__1__anthropic",
		]) {
			const f = JSON.parse(readFileSync(new URL(`${id}.json`, dir), "utf8"));
			const l = JSON.parse(
				readFileSync(new URL(`${id}.labels.json`, dir), "utf8"),
			) as LabelFile;
			const n = firstSeenRejected(f, l).length;
			total += n;
		}
		expect(total).toBe(46);
	});
});
