import { describe, expect, it } from "vitest";
import { checkRecall } from "./guard.js";
import { makeFixture, makeLabel, makeLabels, makeResult } from "./testkit.js";

const f = makeFixture([["a", "b"], ["c"]]);

describe("checkRecall", () => {
	it("suppressing a confirmed fixed claim in its first round fails", () => {
		const labels = makeLabels({ labels: [makeLabel("a", "fixed")] });
		const r = checkRecall(
			f,
			labels,
			makeResult([{ posted: ["b"], suppressed: ["a"] }, { posted: ["c"] }]),
		);
		expect(r.failures).toContain(
			"confirmed fixed first-round claim a was suppressed",
		);
	});

	it("passes when nothing is suppressed", () => {
		const labels = makeLabels({ labels: [makeLabel("a", "fixed")] });
		const r = checkRecall(
			f,
			labels,
			makeResult([{ posted: ["a", "b"] }, { posted: ["c"] }]),
		);
		expect(r).toEqual({
			failures: [],
			warnings: [],
			unexpectedSuppression: [],
		});
	});

	it("suppressing a claim in allowedSuppression passes", () => {
		const labels = makeLabels({
			labels: [makeLabel("a", "fixed")],
			repeatPairs: [{ later: "c", earlier: "a", confirmed: true }],
			allowedSuppression: ["c"],
		});
		const r = checkRecall(
			f,
			labels,
			makeResult([{ posted: ["a", "b"] }, { posted: [], suppressed: ["c"] }]),
		);
		expect(r).toEqual({
			failures: [],
			warnings: [],
			unexpectedSuppression: [],
		});
	});

	it("an allowed suppression with no confirmed repeat pair fails", () => {
		const labels = makeLabels({
			repeatPairs: [{ later: "c", earlier: "a", confirmed: false }],
			allowedSuppression: ["c"],
		});
		const r = checkRecall(
			f,
			labels,
			makeResult([{ posted: ["a", "b"] }, { posted: [], suppressed: ["c"] }]),
		);
		expect(r.failures.some((x) => x.includes("allowed but not a repeat"))).toBe(
			true,
		);
	});

	it("suppressing any other claim is reported as unexpected and fails when its label is confirmed", () => {
		const labels = makeLabels({ labels: [makeLabel("b", "rejected")] });
		const r = checkRecall(
			f,
			labels,
			makeResult([{ posted: ["a"], suppressed: ["b"] }, { posted: ["c"] }]),
		);
		expect(r.unexpectedSuppression).toEqual(["b"]);
		expect(r.failures).toHaveLength(1);
		expect(r.warnings).toHaveLength(0);
	});

	it("the same failure on a provisional label is only a warning", () => {
		const labels = makeLabels({
			labels: [makeLabel("b", "rejected", { confirmed: false })],
		});
		const r = checkRecall(
			f,
			labels,
			makeResult([{ posted: ["a"], suppressed: ["b"] }, { posted: ["c"] }]),
		);
		expect(r.unexpectedSuppression).toEqual(["b"]);
		expect(r.failures).toHaveLength(0);
		expect(r.warnings).toHaveLength(1);
	});

	it("two similar claims in negativePairs both survive or the guard fails", () => {
		const base = makeLabels({ negativePairs: [{ a: "a", b: "b" }] });
		const ok = checkRecall(
			f,
			base,
			makeResult([{ posted: ["a", "b"] }, { posted: ["c"] }]),
		);
		expect(ok.failures).toEqual([]);
		const bad = checkRecall(
			f,
			base,
			makeResult([{ posted: ["a"], suppressed: ["b"] }, { posted: ["c"] }]),
		);
		expect(bad.failures.some((x) => x.includes("negative pair"))).toBe(true);
	});

	it("suppressing everything except confirmed fixed claims reports every other suppression as unexpected", () => {
		const labels = makeLabels({
			labels: [makeLabel("a", "fixed"), makeLabel("b", "rejected")],
		});
		const r = checkRecall(
			f,
			labels,
			makeResult([
				{ posted: ["a"], suppressed: ["b"] },
				{ posted: [], suppressed: ["c"] },
			]),
		);
		expect(r.unexpectedSuppression.sort()).toEqual(["b", "c"]);
	});

	it("a confirmed fixed later-round repeat in allowedSuppression passes when suppressed", () => {
		const labels = makeLabels({
			labels: [makeLabel("c", "fixed")],
			repeatPairs: [{ later: "c", earlier: "a", confirmed: true }],
			allowedSuppression: ["c"],
		});
		const r = checkRecall(
			f,
			labels,
			makeResult([{ posted: ["a", "b"] }, { posted: [], suppressed: ["c"] }]),
		);
		expect(r).toEqual({
			failures: [],
			warnings: [],
			unexpectedSuppression: [],
		});
	});

	it("a provisional fixed first-round claim being suppressed is only a warning", () => {
		const labels = makeLabels({
			labels: [makeLabel("a", "fixed", { confirmed: false })],
		});
		const r = checkRecall(
			f,
			labels,
			makeResult([{ posted: ["b"], suppressed: ["a"] }, { posted: ["c"] }]),
		);
		expect(r.failures).toHaveLength(0);
		expect(r.warnings).toHaveLength(1);
	});

	it("a confirmed pair whose earlier claim is in the same round does not make a claim a repeat", () => {
		const labels = makeLabels({
			labels: [makeLabel("b", "fixed")],
			repeatPairs: [{ later: "b", earlier: "a", confirmed: true }],
		});
		const r = checkRecall(
			f,
			labels,
			makeResult([{ posted: ["a"], suppressed: ["b"] }, { posted: ["c"] }]),
		);
		expect(r.failures).toContain(
			"confirmed fixed first-round claim b was suppressed",
		);
	});
});
