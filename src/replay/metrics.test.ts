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
