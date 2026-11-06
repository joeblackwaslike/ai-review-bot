import { describe, expect, it } from "vitest";
import {
	type AdaptiveFixtureInput,
	adaptiveReport,
	type RoundRun,
	type RoundRunner,
} from "./adaptive-report.js";
import { makeFixture, makeLabel, makeLabels } from "./testkit.js";
import type { CandidateRecord, Label, ReplayFixture } from "./types.js";

const WORDS = [
	"alpha",
	"bravo",
	"charlie",
	"delta",
	"echo",
	"foxtrot",
	"golf",
	"hotel",
	"india",
	"juliet",
	"kilo",
	"lima",
	"mike",
];

const cand = (i: number, severity = "P2"): CandidateRecord => ({
	skill: "code-reviewer.md",
	title: `${WORDS[i]} widget leaks memory`,
	path: `src/${WORDS[i]}.ts`,
	line: 10,
	severity,
});

function build(
	kinds: (Label | null)[],
	opts: { heldOut?: boolean } = {},
): { input: AdaptiveFixtureInput; removed: CandidateRecord[] } {
	const base = makeFixture([["x"]]);
	const claims = kinds.map((_, i) => ({
		...(base.rounds[0]?.claims[0] as NonNullable<
			(typeof base.rounds)[0]
		>["claims"][0]),
		id: `c${i}`,
		path: `src/${WORDS[i]}.ts`,
		line: 10,
		title: `${WORDS[i]} widget leaks memory`,
		text: `${WORDS[i]} widget leaks memory`,
	}));
	const fixture: ReplayFixture = {
		...base,
		...(opts.heldOut ? { heldOut: true as const } : {}),
		rounds: [
			{
				...(base.rounds[0] as (typeof base.rounds)[0]),
				claims,
				trace: { candidates: [], posted: [], usage: {} },
			},
		],
	};
	const labels = makeLabels({
		labels: kinds.flatMap((k, i) => (k ? [makeLabel(`c${i}`, k)] : [])),
	});
	return {
		input: { fixture, labels },
		removed: kinds.map((_, i) => cand(i)),
	};
}

const runnerOf =
	(run: RoundRun): RoundRunner =>
	() =>
		run;

const withRemoved = (removed: CandidateRecord[]): RoundRun => ({
	before: removed,
	after: [],
	removed,
});

describe("adaptiveReport gate", () => {
	it("passes when 12 removed candidates are all labelled rejected", () => {
		const { input, removed } = build(Array(12).fill("rejected"));
		const r = adaptiveReport([input], runnerOf(withRemoved(removed)));
		expect(r.gate).toBe("pass");
		expect(r.perFixture[0]?.removedRejected).toBe(12);
	});

	it("fails on a confirmed-real removal from a held-out fixture", () => {
		const { input, removed } = build(["fixed", ...Array(11).fill("rejected")], {
			heldOut: true,
		});
		const r = adaptiveReport([input], runnerOf(withRemoved(removed)));
		expect(r.gate).toBe("fail");
		expect(r.perFixture[0]?.realRemovals[0]?.candidate.severity).toBe("P2");
	});

	it("does not fail on a real removal from a fixture that is not held out", () => {
		const { input, removed } = build(["fixed", ...Array(11).fill("rejected")]);
		const r = adaptiveReport([input], runnerOf(withRemoved(removed)));
		expect(r.gate).toBe("pass");
		expect(r.text).toContain("P2");
	});

	it("is inconclusive with 9 labelled or adjudicated removals", () => {
		const { input, removed } = build(Array(9).fill("rejected"));
		expect(adaptiveReport([input], runnerOf(withRemoved(removed))).gate).toBe(
			"inconclusive",
		);
	});

	it("keeps a held-out real removal in the text while inconclusive", () => {
		const { input, removed } = build(["fixed", "rejected"], { heldOut: true });
		const r = adaptiveReport([input], runnerOf(withRemoved(removed)));
		expect(r.gate).toBe("inconclusive");
		expect(r.text).toContain("HELD-OUT REAL REMOVALS");
		expect(r.text).toContain("alpha widget leaks memory");
	});
});

describe("adaptiveReport verdicts", () => {
	it("counts adjudicated real and not-real, and leaves unclear and none unjoined", () => {
		const { input, removed } = build(Array(4).fill(null));
		const verdicts = ["real", "not-real", "unclear", undefined] as const;
		const r = adaptiveReport(
			[
				{
					...input,
					verdictFor: (c) => verdicts[removed.findIndex((x) => x === c)],
				},
			],
			runnerOf(withRemoved(removed)),
		);
		const row = r.perFixture[0];
		expect(row?.removedReal).toBe(1);
		expect(row?.removedRejected).toBe(1);
		expect(row?.removedUnjoined).toBe(2);
		expect(row?.unjoined.map((u) => u.candidate.title)).toEqual([
			"charlie widget leaks memory",
			"delta widget leaks memory",
		]);
	});

	it("a label wins over a verdict", () => {
		const { input, removed } = build(["rejected"]);
		const r = adaptiveReport(
			[{ ...input, verdictFor: () => "real" }],
			runnerOf(withRemoved(removed)),
		);
		expect(r.perFixture[0]?.removedRejected).toBe(1);
		expect(r.perFixture[0]?.removedReal).toBe(0);
	});
});

describe("adaptiveReport rounds", () => {
	it("reports posted counts per traced round and rounds to clean", () => {
		const base = makeFixture([["a"], ["b"], ["c"]]);
		const fixture: ReplayFixture = {
			...base,
			rounds: base.rounds.map((r) =>
				r.index === 1
					? r
					: { ...r, trace: { candidates: [], posted: [], usage: {} } },
			),
		};
		const runs: Record<number, RoundRun> = {
			0: { before: [cand(0), cand(1)], after: [cand(0)], removed: [cand(1)] },
			2: { before: [cand(0)], after: [], removed: [cand(0)] },
		};
		const run: RoundRunner = (_f, _l, round) => runs[round.index] as RoundRun;
		const row = adaptiveReport([{ fixture, labels: makeLabels() }], run)
			.perFixture[0];
		expect(row?.rounds).toEqual([0, 2]);
		expect(row?.postedBefore).toEqual([2, 1]);
		expect(row?.postedAfter).toEqual([1, 0]);
		expect(row?.roundsToClean).toEqual({ before: null, after: 2 });
	});

	it("states the lower bound and provisional labels", () => {
		const { input, removed } = build(["rejected"]);
		const { text } = adaptiveReport([input], runnerOf(withRemoved(removed)));
		expect(text).toContain("lower bound");
		expect(text).toContain("push-shape");
		expect(text).toContain("labels are provisional");
		expect(text).toContain("do not count for or against");
	});

	it("runs the real posting filters on a saved trace without throwing", () => {
		const base = makeFixture([["a"], ["b"]]);
		const c = cand(0);
		const fixture: ReplayFixture = {
			...base,
			rounds: base.rounds.map((r) => ({
				...r,
				trace: { candidates: [c], posted: [c], usage: {} },
			})),
		};
		const r = adaptiveReport([{ fixture, labels: makeLabels() }]);
		expect(r.perFixture[0]?.postedBefore).toEqual([1, 1]);
	});
});
