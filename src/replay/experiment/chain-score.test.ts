import { describe, expect, it } from "vitest";
import { makeFixture, makeLabel, makeLabels } from "../testkit.js";
import type { CandidateRecord } from "../types.js";
import {
	aggregateChains,
	type ChainScore,
	compareChains,
	scoreChain,
} from "./chain-score.js";
import { type ScoredFixture, scoreExperiment } from "./score.js";
import type { StoredCell } from "./store.js";
import { samplePlan } from "./testkit.js";

const C1 = "retry delay skipped before first attempt";
const C2 = "cache key ignores tenant identifier value";

const cand = (title: string, path = "a.ts", line = 1): CandidateRecord => ({
	skill: null,
	title,
	path,
	line,
	severity: null,
});

const fx = (): ScoredFixture => ({
	fixture: makeFixture([[C1], [C2], [C1]], { pull: 1 }),
	labels: makeLabels({
		labels: [makeLabel(C1, "fixed"), makeLabel(C2, "rejected")],
	}),
});

const cell = (
	round: number,
	posted: CandidateRecord[],
	o: {
		strategy?: string;
		fixtureId?: string;
		trial?: number;
		at?: string;
	} = {},
): StoredCell => ({
	key: {
		strategy: o.strategy ?? "a",
		version: "v1",
		fixtureId: o.fixtureId ?? "o/r#1",
		round,
		trial: o.trial ?? 0,
	},
	provider: "anthropic",
	planHash: "h",
	at: o.at ?? "t",
	costUsd: 1,
	fitIn210s: true,
	failedAttempts: 0,
	cacheTemperature: "unknown",
	stale: false,
	result: {
		findings: [],
		candidates: posted,
		posted,
		agentReviews: [],
		usage: {},
		toolCalls: [],
		wallMs: 1000,
	},
});

const score = (records: StoredCell[], plannedRounds = 3) =>
	scoreChain({
		strategy: "a",
		fixtureId: "o/r#1",
		records,
		fx: fx(),
		plannedRounds,
	});

describe("scoreChain", () => {
	it("recycling counts a later-round restatement of the strategy's own earlier finding", () => {
		const s = score([
			cell(0, [cand(C1)]),
			cell(1, [cand(C1), cand(C2, "b.ts", 90)]),
			cell(2, []),
		]);
		expect(s.recycling).toBe(0.5);
	});

	it("recycling is null when no later round posted anything", () => {
		const s = score([cell(0, [cand(C1)]), cell(1, []), cell(2, [])]);
		expect(s.recycling).toBeNull();
	});

	it("convergence is the first empty round", () => {
		const s = score([cell(0, [cand(C1)]), cell(1, []), cell(2, [cand(C2)])]);
		expect(s.convergenceRound).toBe(1);
		expect(s.complete).toBe(true);
	});

	it("convergence equals plannedRounds when no round is empty", () => {
		const s = score([
			cell(0, [cand(C1)]),
			cell(1, [cand(C1)]),
			cell(2, [cand(C1)]),
		]);
		expect(s.convergenceRound).toBe(3);
	});

	it("convergence is the position in the ordered rounds, not the stored round index", () => {
		const s = score([cell(5, [cand(C1)]), cell(6, []), cell(7, [cand(C2)])]);
		expect(s.convergenceRound).toBe(1);
	});

	it("an incomplete chain is flagged and not counted as converged", () => {
		const s = score([cell(0, [cand(C1)]), cell(1, [])]);
		expect(s.complete).toBe(false);
		expect(s.convergenceRound).toBe(3);
	});
});

describe("scoreChain duplicates", () => {
	it("takes the last cell by at when a round is stored twice", () => {
		const s = score([
			cell(0, [cand(C1)]),
			cell(1, [cand(C1)], { at: "1" }),
			cell(1, [], { at: "2" }),
			cell(2, []),
		]);
		expect(s.recycling).toBeNull();
		expect(s.convergenceRound).toBe(1);
		expect(s.complete).toBe(true);
	});
});

const chain = (o: Partial<ChainScore>): ChainScore => ({
	strategy: "a",
	fixtureId: "o/r#1",
	provider: "anthropic",
	recycling: 0.5,
	convergenceRound: 2,
	complete: true,
	recall: 0.5,
	...o,
});

const opts = { level: 0.95, resamples: 50, seed: "s" };

describe("aggregateChains", () => {
	it("means over PRs, skipping null recycling, and reports the incomplete rate", () => {
		const out = aggregateChains([
			chain({ recycling: 0.2, convergenceRound: 1 }),
			chain({ fixtureId: "o/r#2", recycling: null, convergenceRound: 3 }),
			chain({ fixtureId: "o/r#3", complete: false, recycling: 0.4 }),
			chain({ fixtureId: "o/r#4", recycling: 0.6, convergenceRound: 2 }),
		]);
		expect(out.nPrs).toBe(4);
		expect(out.recycling).toBeCloseTo(0.4);
		expect(out.convergenceRound).toBeCloseTo(2);
		expect(out.incompleteRate).toBe(0.25);
	});
});

describe("aggregateChains incomplete", () => {
	it("averages convergence over complete chains only", () => {
		const out = aggregateChains([
			chain({ convergenceRound: 1 }),
			chain({ fixtureId: "o/r#2", convergenceRound: 1 }),
			chain({ fixtureId: "o/r#3", complete: false, convergenceRound: 3 }),
		]);
		expect(out.convergenceRound).toBeCloseTo(1);
	});

	it("is null when no chain is complete", () => {
		const out = aggregateChains([chain({ complete: false })]);
		expect(out.convergenceRound).toBeNull();
	});
});

describe("compareChains", () => {
	it("pairs complete shared PRs, counts the rest as excluded, and skips null recycling", () => {
		const cand = [
			chain({
				strategy: "b",
				fixtureId: "o/r#1",
				recycling: 0.2,
				convergenceRound: 1,
			}),
			chain({
				strategy: "b",
				fixtureId: "o/r#2",
				recycling: null,
				convergenceRound: 1,
			}),
			chain({ strategy: "b", fixtureId: "o/r#3", complete: false }),
			chain({ strategy: "b", fixtureId: "o/r#4" }),
		];
		const base = [
			chain({ fixtureId: "o/r#1", recycling: 0.6, convergenceRound: 3 }),
			chain({ fixtureId: "o/r#2", recycling: 0.5, convergenceRound: 3 }),
			chain({ fixtureId: "o/r#3" }),
		];
		const out = compareChains("b", "anthropic", cand, base, opts);
		expect(out.nPrs).toBe(2);
		expect(out.excludedIncomplete).toBe(2);
		expect(out.recycling.n).toBe(1);
		expect(out.recycling.mean).toBeCloseTo(-0.4);
		expect(out.convergence.n).toBe(2);
		expect(out.convergence.mean).toBeCloseTo(-2);
	});
});

describe("scoreExperiment chained", () => {
	const plan = {
		...samplePlan(),
		mode: "chained" as const,
		trials: 2,
		strategies: [
			{ name: "a", version: "v1" },
			{ name: "b", version: "v1" },
		],
		fixtures: [
			{ id: "o/r#1", split: "tuning" as const, provider: "anthropic" as const },
		],
	};
	const run = (records: StoredCell[]) =>
		scoreExperiment({
			plan,
			records,
			fixtures: { "o/r#1": fx() },
			cache: { get: () => undefined },
			final: false,
			baseline: "a",
			seedGates: {},
			exploratory: null,
			bootstrapSeed: "s",
		});
	const full = (strategy: string, trial: number, empty: number) =>
		[0, 1, 2].map((r) =>
			cell(r, r >= empty ? [] : [cand(C1)], { strategy, trial }),
		);

	it("averages trials per strategy and PR, and is partial when cells are missing", () => {
		const out = run([
			...full("a", 0, 1),
			...full("a", 1, 2),
			...full("b", 0, 1),
		]);
		const a = out.chained?.perPr.find((p) => p.strategy === "a");
		expect(a?.convergenceRound).toBeCloseTo(1.5);
		expect(a?.complete).toBe(true);
		expect(out.partial).toBe(true);
		expect(out.perPr).toEqual([]);
		expect(out.verdicts).toEqual([]);
	});

	it("a PR is complete only if every trial is complete", () => {
		const out = run([
			...full("a", 0, 1),
			...full("a", 1, 1).slice(0, 2),
			...full("b", 0, 1),
			...full("b", 1, 1),
		]);
		const get = (s: string) => out.chained?.perPr.find((p) => p.strategy === s);
		expect(get("a")?.complete).toBe(false);
		expect(get("b")?.complete).toBe(true);
		expect(out.partial).toBe(true);
		expect(out.chained?.comparisons[0]?.excludedIncomplete).toBe(1);
	});

	it("counts distinct cells, so a duplicated cell cannot hide a missing one", () => {
		const out = run([
			...full("a", 0, 1),
			...full("a", 1, 1),
			...full("b", 0, 1),
			...full("b", 1, 1).slice(0, 2),
			cell(0, [cand(C1)], { strategy: "b", trial: 1, at: "later" }),
		]);
		expect(out.partial).toBe(true);
	});

	it("is not partial when every planned cell is stored", () => {
		const out = run(
			["a", "b"].flatMap((s) => [0, 1].flatMap((t) => full(s, t, 1))),
		);
		expect(out.partial).toBe(false);
		expect(out.chained?.comparisons[0]?.nPrs).toBe(1);
	});
});
