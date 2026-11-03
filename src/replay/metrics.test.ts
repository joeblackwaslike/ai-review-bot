import { describe, expect, it } from "vitest";
import { computeMetrics, formatReport } from "./metrics.js";
import { makeFixture, makeLabel, makeLabels, makeResult } from "./testkit.js";

describe("computeMetrics", () => {
	it("rejection rate counts rejected over fixed plus rejected and excludes deferred and unadjudicated", () => {
		const f = makeFixture([["a", "b", "c", "d", "e"]]);
		const labels = makeLabels({
			labels: [
				makeLabel("a", "fixed"),
				makeLabel("b", "rejected"),
				makeLabel("c", "rejected"),
				makeLabel("d", "deferred"),
				makeLabel("e", "unadjudicated"),
			],
		});
		const m = computeMetrics(
			f,
			labels,
			makeResult([{ posted: ["a", "b", "c", "d", "e"] }]),
		);
		expect(m.rejection).toEqual({ rejected: 2, adjudicated: 3 });
		expect(m.deferred).toBe(1);
		expect(m.unadjudicated).toBe(1);
	});

	it("recycled counts a posted claim that has a confirmed pair to an earlier settled claim", () => {
		const f = makeFixture([["a"], ["b"]]);
		const labels = makeLabels({
			labels: [makeLabel("a", "fixed")],
			repeatPairs: [{ later: "b", earlier: "a", confirmed: true }],
		});
		const m = computeMetrics(
			f,
			labels,
			makeResult([{ posted: ["a"] }, { posted: ["b"] }]),
		);
		expect(m.recycled).toEqual({ count: 1, posted: 2, proposedExtra: 0 });
		expect(m.restatedOpen.count).toBe(0);
	});

	it("restated open counts a pair to an earlier claim that is still open", () => {
		const f = makeFixture([["a"], ["b"]]);
		const labels = makeLabels({
			labels: [
				makeLabel("a", "fixed", { evidence: ["2026-01-02T11:00:00Z|late"] }),
			],
			repeatPairs: [{ later: "b", earlier: "a", confirmed: true }],
		});
		const m = computeMetrics(
			f,
			labels,
			makeResult([{ posted: ["a"] }, { posted: ["b"] }]),
		);
		expect(m.restatedOpen).toEqual({ count: 1, posted: 2, proposedExtra: 0 });
		expect(m.recycled.count).toBe(0);
	});

	it("reports unconfirmed pairs as proposedExtra without adding to count", () => {
		const f = makeFixture([["a"], ["b"]]);
		const labels = makeLabels({
			labels: [makeLabel("a", "fixed")],
			repeatPairs: [{ later: "b", earlier: "a", confirmed: false }],
		});
		const m = computeMetrics(
			f,
			labels,
			makeResult([{ posted: ["a"] }, { posted: ["b"] }]),
		);
		expect(m.recycled).toEqual({ count: 0, posted: 2, proposedExtra: 1 });
		expect(m.convergence.roundsWithFirstSeen).toBe(2);
		expect(m.convergence.finalRoundQuiet).toBe(false);
	});

	it("neither repeat kind counts toward convergence", () => {
		const f = makeFixture([["a"], ["b"], ["c"]]);
		const labels = makeLabels({
			labels: [makeLabel("a", "fixed")],
			repeatPairs: [
				{ later: "b", earlier: "a", confirmed: true },
				{ later: "c", earlier: "b", confirmed: true },
			],
		});
		const m = computeMetrics(
			f,
			labels,
			makeResult([{ posted: ["a"] }, { posted: ["b"] }, { posted: ["c"] }]),
		);
		expect(m.convergence).toEqual({
			roundsWithFirstSeen: 1,
			totalRounds: 3,
			finalRoundQuiet: true,
		});
	});

	it("roundsWithFirstSeen counts rounds posting at least one claim with no earlier pair", () => {
		const f = makeFixture([["a"], ["b", "c"]]);
		const labels = makeLabels({
			repeatPairs: [{ later: "b", earlier: "a", confirmed: true }],
		});
		const m = computeMetrics(
			f,
			labels,
			makeResult([{ posted: ["a"] }, { posted: ["b", "c"] }]),
		);
		expect(m.convergence).toEqual({
			roundsWithFirstSeen: 2,
			totalRounds: 2,
			finalRoundQuiet: false,
		});
	});

	it("ignores suppressed claims", () => {
		const f = makeFixture([["a"], ["b"]]);
		const m = computeMetrics(
			f,
			makeLabels(),
			makeResult([{ posted: ["a"] }, { posted: [], suppressed: ["b"] }]),
		);
		expect(m.recycled.posted).toBe(1);
		expect(m.convergence.finalRoundQuiet).toBe(true);
	});
});

describe("formatReport", () => {
	it('prints "4 of 10" style counts', () => {
		const f = makeFixture([["a"], ["b"]]);
		const labels = makeLabels({
			labels: [makeLabel("a", "fixed")],
			repeatPairs: [{ later: "b", earlier: "a", confirmed: true }],
		});
		const m = computeMetrics(
			f,
			labels,
			makeResult([{ posted: ["a"] }, { posted: ["b"] }]),
		);
		const out = formatReport([m], ["fx"]);
		expect(out).toContain("fx");
		expect(out).toContain("0 of 1");
		expect(out).toContain("recycled: 1 of 2");
		expect(out).not.toMatch(/%/);
	});

	it("prints proposed extras", () => {
		const f = makeFixture([["a"], ["b"]]);
		const labels = makeLabels({
			labels: [makeLabel("a", "fixed")],
			repeatPairs: [{ later: "b", earlier: "a", confirmed: false }],
		});
		const m = computeMetrics(
			f,
			labels,
			makeResult([{ posted: ["a"] }, { posted: ["b"] }]),
		);
		expect(formatReport([m], ["fx"])).toContain("0 of 2, +1 proposed");
	});
});

describe("joinRate", () => {
	const cand = (title: string, path = "a.ts") => ({
		skill: "s.md",
		title,
		path,
		line: 1,
		severity: "high",
	});
	const trace = (candidates: ReturnType<typeof cand>[]) => ({
		candidates,
		posted: [],
		usage: {},
	});

	it("counts candidates that match a labelled claim", () => {
		const f = makeFixture([
			["missing null check handler", "swallowed error retry loop"],
			[],
		]);
		f.rounds[0] = {
			...f.rounds[0],
			trace: trace([
				cand("missing null check handler"),
				cand("swallowed error retry loop"),
				cand("missing null check handler"),
				cand("zzz unrelated thing here", "other.ts"),
			]),
		} as (typeof f.rounds)[0];
		const labels = makeLabels({
			labels: [
				makeLabel("missing null check handler", "fixed"),
				makeLabel("swallowed error retry loop", "rejected"),
			],
		});
		const m = computeMetrics(
			f,
			labels,
			makeResult([{ posted: [] }, { posted: [] }]),
		);
		expect(m.joinRate).toEqual({ joined: 3, candidates: 4 });
		expect(formatReport([m], ["fx"])).toContain("join rate: 3/4");
	});

	it("does not join a claim without a labels entry", () => {
		const f = makeFixture([["missing null check handler"]]);
		f.rounds[0] = {
			...f.rounds[0],
			trace: trace([cand("missing null check handler")]),
		} as (typeof f.rounds)[0];
		const m = computeMetrics(f, makeLabels(), makeResult([{ posted: [] }]));
		expect(m.joinRate).toEqual({ joined: 0, candidates: 1 });
	});

	it("is absent without a trace and leaves the report unchanged", () => {
		const f = makeFixture([["a"]]);
		const labels = makeLabels({ labels: [makeLabel("a", "fixed")] });
		const m = computeMetrics(f, labels, makeResult([{ posted: ["a"] }]));
		expect(m.joinRate).toBeUndefined();
		expect(formatReport([m], ["fx"])).toBe(
			[
				"fx",
				"  rejected: 0 of 1 adjudicated (deferred 0, unadjudicated 0)",
				"  recycled: 0 of 1",
				"  restated open: 0 of 1",
				"  rounds with first-seen claims: 1 of 1, final round quiet: no",
			].join("\n"),
		);
	});
});
