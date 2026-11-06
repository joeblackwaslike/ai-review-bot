import { describe, expect, it } from "vitest";
import {
	type AdaptiveFixtureInput,
	adaptiveReport,
	type RoundRun,
	type RoundRunner,
} from "./adaptive-report.js";
import { claim, makeFixture, makeLabel, makeLabels } from "./testkit.js";
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

	it("fails when removed findings are not mostly rejected-labelled", () => {
		for (const [real, rejected] of [
			[6, 4],
			[5, 5],
			[10, 0],
		] as const) {
			const { input, removed } = build([
				...Array(real).fill("fixed"),
				...Array(rejected).fill("rejected"),
			]);
			const r = adaptiveReport([input], runnerOf(withRemoved(removed)));
			expect(r.gate).toBe("fail");
		}
	});

	it("passes with 4 real and 6 rejected removals outside the held-out fixtures", () => {
		const { input, removed } = build([
			...Array(4).fill("fixed"),
			...Array(6).fill("rejected"),
		]);
		const r = adaptiveReport([input], runnerOf(withRemoved(removed)));
		expect(r.gate).toBe("pass");
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
					verdictFor: (c) => verdicts[removed.indexOf(c)],
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

describe("adaptiveReport distinct findings", () => {
	const roundsFixture = (
		n: number,
		kinds: (Label | null)[],
		heldOut = false,
	) => {
		const { input } = build(kinds, { heldOut });
		const round0 = input.fixture.rounds[0] as (typeof input.fixture.rounds)[0];
		const fixture: ReplayFixture = {
			...input.fixture,
			rounds: Array.from({ length: n }, (_, i) => ({ ...round0, index: i })),
		};
		return { ...input, fixture };
	};

	it("counts one finding removed in 12 rounds once and stays inconclusive", () => {
		const input = roundsFixture(12, ["rejected"]);
		const r = adaptiveReport([input], runnerOf(withRemoved([cand(0)])));
		expect(r.perFixture[0]?.removedRejected).toBe(1);
		expect(r.gate).toBe("inconclusive");
	});

	it("passes with 10 distinct rejected findings each removed in 3 rounds", () => {
		const input = roundsFixture(3, Array(10).fill("rejected"));
		const removed = Array.from({ length: 10 }, (_, i) => cand(i));
		const r = adaptiveReport([input], runnerOf(withRemoved(removed)));
		expect(r.perFixture[0]?.removedRejected).toBe(10);
		expect(r.gate).toBe("pass");
	});

	it("lists a real finding removed in two held-out rounds once and fails", () => {
		const input = roundsFixture(
			2,
			["fixed", ...Array(10).fill("rejected")],
			true,
		);
		const removed = Array.from({ length: 11 }, (_, i) =>
			cand(i, i === 0 ? "P3" : "P2"),
		);
		const run: RoundRunner = (_f, _l, round) =>
			withRemoved(
				round.index === 0
					? removed
					: removed.map((c, i) => (i === 0 ? { ...c, severity: "P1" } : c)),
			);
		const r = adaptiveReport([input], run);
		const row = r.perFixture[0];
		expect(row?.removedReal).toBe(1);
		expect(row?.realRemovals).toHaveLength(1);
		expect(row?.realRemovals[0]?.round).toBe(0);
		expect(row?.realRemovals[0]?.candidate.severity).toBe("P1");
		expect(r.gate).toBe("fail");
		expect(r.text.match(/HELD-OUT REAL/g)).toHaveLength(1);
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
		expect(text).toContain("push-shape factor is not modeled");
		expect(text).toContain("off-diff drops are not modeled");
		expect(text).not.toContain("lower bound");
		expect(text).toContain("labelled-real (confirmed or provisional `fixed`)");
		expect(text).toContain("a label wins over an adjudicated verdict");
		expect(text).toContain("real wins over rejected");
		expect(text).toContain("confidence is not recorded");
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

describe("adaptiveReport with the real posting filters", () => {
	const WORD_IDS = WORDS.slice(0, 10);
	const rejectedAt = (id: string, at: string) =>
		makeLabel(id, "rejected", { evidence: [`${at}|no`] });
	const claimOf = (
		id: string,
		roundIndex: number,
		path: string,
		title: string,
		commentId: number,
	) => ({
		...claim(id, roundIndex),
		commentId,
		path,
		line: 10,
		severity: "P2",
		title,
		text: title,
	});

	function buildFixture(p1Count: number) {
		const base = makeFixture([["x"], ["y"], ["z"]]);
		const earlier = (roundIndex: number, at: string) => {
			const ids = [`e${roundIndex}a`, `e${roundIndex}b`];
			return {
				claims: ids.map((id, i) =>
					claimOf(
						id,
						roundIndex,
						`src/earlier${roundIndex}${i}.ts`,
						`earlier ${id} finding`,
						100 * (roundIndex + 1) + i,
					),
				),
				labels: ids.map((id) => rejectedAt(id, at)),
			};
		};
		const r0 = earlier(0, "2026-01-01T11:00:00Z");
		const r1 = earlier(1, "2026-01-02T11:00:00Z");
		const p3Claims = WORD_IDS.map((w, i) =>
			claimOf(`n${i}`, 2, `src/${w}.ts`, `${w} widget leaks memory`, 300 + i),
		);
		const p3 = WORD_IDS.map((w) => ({
			skill: "code-reviewer.md",
			title: `${w} widget leaks memory`,
			path: `src/${w}.ts`,
			line: 10,
			severity: "P3",
		}));
		const p1 = Array.from({ length: p1Count }, (_, i) => ({
			skill: "code-reviewer.md",
			title: `serious problem number ${i}`,
			path: `src/serious${i}.ts`,
			line: 10,
			severity: "P1",
		}));
		const fixture: ReplayFixture = {
			...base,
			rounds: [
				{ ...(base.rounds[0] as (typeof base.rounds)[0]), claims: r0.claims },
				{ ...(base.rounds[1] as (typeof base.rounds)[0]), claims: r1.claims },
				{
					...(base.rounds[2] as (typeof base.rounds)[0]),
					claims: p3Claims,
					trace: {
						candidates: [...p1, ...p3],
						posted: [],
						usage: {},
					},
				},
			],
		};
		const labels = makeLabels({
			labels: [
				...r0.labels,
				...r1.labels,
				...p3Claims.map((c) => rejectedAt(c.id, "2026-01-03T11:00:00Z")),
			],
		});
		return { fixture, labels };
	}

	it("does not count a removal the inline cap would have made anyway", () => {
		const { fixture, labels } = buildFixture(50);
		const r = adaptiveReport([{ fixture, labels }]);
		expect(r.perFixture[0]?.postedBefore).toEqual([50]);
		expect(r.perFixture[0]?.postedAfter).toEqual([50]);
		expect(r.perFixture[0]?.removedRejected).toBe(0);
		expect(r.gate).toBe("inconclusive");
	});

	it("counts the same removals when the baseline would have posted them", () => {
		const { fixture, labels } = buildFixture(5);
		const r = adaptiveReport([{ fixture, labels }]);
		expect(r.perFixture[0]?.removedRejected).toBe(10);
		expect(r.gate).toBe("pass");
	});
});
