import { describe, expect, it } from "vitest";
import { claimKey } from "../adjudication/snapshot.js";
import type { VerdictRecord } from "../adjudication/types.js";
import { makeFixture, makeLabel, makeLabels } from "../testkit.js";
import type { CandidateRecord } from "../types.js";
import {
	aggregate,
	compareStrategies,
	type ScoredFixture,
	scoreExperiment,
	scorePr,
	verdictFor,
} from "./score.js";
import type { StoredCell } from "./store.js";
import { samplePlan } from "./testkit.js";

const C1 = "retry delay skipped before first attempt";
const C2 = "cache key ignores tenant identifier value";
const C3 = "logging statement leaks request header contents";

const cand = (title: string, path = "a.ts", line = 1): CandidateRecord => ({
	skill: null,
	title,
	path,
	line,
	severity: null,
});

const UNMATCHED = cand("zzz unrelated widget handling bug", "b.ts", 50);

const verdict = (
	v: VerdictRecord["verdict"],
	over: Partial<VerdictRecord> = {},
): VerdictRecord => ({
	verdict: v,
	scope: "change",
	reason: "r",
	first: { family: "anthropic", model: "m", promptHash: "p" },
	second: null,
	secondVerdict: null,
	status: "agreed",
	...over,
});

const cacheOf = (entries: [CandidateRecord, VerdictRecord][]) => {
	const map = new Map(entries.map(([c, v]) => [claimKey(c), v]));
	return { get: (_s: string, key: string) => map.get(key) };
};

const scored = (pull = 1): ScoredFixture => ({
	fixture: makeFixture([[C1], [C2], [C3]], { pull }),
	labels: makeLabels({
		labels: [
			makeLabel(C1, "fixed"),
			makeLabel(C2, "rejected"),
			makeLabel(C3, "unadjudicated"),
		],
	}),
});

const cell = (
	over: {
		strategy?: string;
		fixtureId?: string;
		round?: number;
		trial?: number;
		posted?: CandidateRecord[];
		costUsd?: number;
		wallMs?: number;
		stale?: boolean;
		provider?: "anthropic" | "openai";
	} = {},
): StoredCell => ({
	key: {
		strategy: over.strategy ?? "a",
		version: "v1",
		fixtureId: over.fixtureId ?? "o/r#1",
		round: over.round ?? 0,
		trial: over.trial ?? 0,
	},
	provider: over.provider ?? "anthropic",
	planHash: "h",
	at: "t",
	costUsd: over.costUsd ?? 1,
	fitIn210s: (over.wallMs ?? 1000) <= 210_000,
	failedAttempts: 0,
	cacheTemperature: "unknown",
	stale: over.stale ?? false,
	result: {
		findings: [],
		candidates: [],
		posted: over.posted ?? [],
		agentReviews: [],
		usage: {},
		toolCalls: [],
		wallMs: over.wallMs ?? 1000,
	},
});

describe("scorePr", () => {
	it("classifies posted findings by label first, then cached verdict", () => {
		const cache = cacheOf([[UNMATCHED, verdict("real")]]);
		const pr = scorePr({
			strategy: "a",
			fixtureId: "o/r#1",
			records: [
				cell({ posted: [cand(C1), cand(C2), UNMATCHED] }),
				cell({ round: 1, posted: [cand(C3)] }),
			],
			fx: scored(),
			cache,
		});
		expect(pr.real).toBe(2);
		expect(pr.notReal).toBe(1);
		expect(pr.unadjudicated).toBe(1);
		expect(pr.precision).toBeCloseTo(2 / 3);
		expect(pr.foundClaims).toBe(1);
		expect(pr.totalClaims).toBe(1);
		expect(pr.recall).toBe(1);
	});

	it("keeps unresolved, unclear, missing and single-family verdicts out of precision but counts them", () => {
		const a = cand("alpha one distinct finding text here", "x.ts", 5);
		const b = cand("beta two distinct finding text here", "y.ts", 6);
		const c = cand("gamma three distinct finding text here", "z.ts", 7);
		const d = cand("delta four distinct finding text here", "w.ts", 8);
		const cache = cacheOf([
			[a, verdict("unclear")],
			[b, verdict("real", { status: "unresolved" })],
			[c, verdict("not-real", { status: "single-family", scope: "moved" })],
		]);
		const pr = scorePr({
			strategy: "a",
			fixtureId: "o/r#1",
			records: [cell({ posted: [a, b, c, d] })],
			fx: scored(),
			cache,
		});
		expect(pr.unresolved).toBe(2);
		expect(pr.unadjudicated).toBe(1);
		expect(pr.notReal).toBe(1);
		expect(pr.singleFamily).toBe(1);
		expect(pr.moved).toBe(1);
		expect(pr.precision).toBe(0);
	});

	it("has null precision with nothing posted and counts cost, rounds and fit", () => {
		const pr = scorePr({
			strategy: "a",
			fixtureId: "o/r#1",
			records: [
				cell({ costUsd: 2, wallMs: 300_000 }),
				cell({ round: 1, costUsd: 4 }),
			],
			fx: scored(),
			cache: cacheOf([]),
		});
		expect(pr.precision).toBeNull();
		expect(pr.recall).toBe(0);
		expect(pr.costUsd).toBe(6);
		expect(pr.rounds).toBe(2);
		expect(pr.fitRounds).toBe(1);
	});

	it("counts extra audit defects in the recall denominator", () => {
		const fx = {
			...scored(),
			extraDefects: [
				{ path: "q.ts", line: 9, title: "audit added defect text words" },
			],
		};
		const pr = scorePr({
			strategy: "a",
			fixtureId: "o/r#1",
			records: [cell({ posted: [cand(C1)] })],
			fx,
			cache: cacheOf([]),
		});
		expect(pr.totalClaims).toBe(2);
		expect(pr.recall).toBe(0.5);
	});
});

const pr = (
	fixtureId: string,
	strategy: string,
	precision: number | null,
	recall: number | null,
	costUsd = 1,
) => ({
	strategy,
	fixtureId,
	provider: "anthropic" as const,
	real: 0,
	notReal: 0,
	unresolved: 1,
	unadjudicated: 0,
	singleFamily: 0,
	moved: 0,
	provisional: 0,
	precision,
	recall,
	foundClaims: 0,
	totalClaims: 0,
	costUsd,
	rounds: 2,
	fitRounds: 2,
});

describe("aggregate and compareStrategies", () => {
	it("macro-averages per PR and sums the unresolved counts", () => {
		const s = aggregate([
			pr("p1", "a", 0.5, 1),
			pr("p2", "a", 1, 0.5),
			pr("p3", "a", null, null),
		]);
		expect(s.nPrs).toBe(3);
		expect(s.precision).toBeCloseTo(0.75);
		expect(s.recall).toBeCloseTo(0.75);
		expect(s.unresolved).toBe(3);
		expect(s.fitShare).toBe(1);
	});

	it("pairs on the PRs both strategies have a value for", () => {
		const base = [
			pr("p1", "a", 0.5, 0.8),
			pr("p2", "a", 0.5, 0.8),
			pr("p3", "a", null, 0.8),
		];
		const candi = [
			pr("p1", "b", 0.9, 0.8),
			pr("p2", "b", 0.9, 0.7),
			pr("p4", "b", 0.9, 0.7),
		];
		const cmp = compareStrategies(candi, base, {
			level: 0.95,
			resamples: 500,
			seed: "s",
		});
		expect(cmp.precision.n).toBe(2);
		expect(cmp.precision.mean).toBeCloseTo(0.4);
		expect(cmp.recallDiffPoints).toBeCloseTo(-5);
		expect(cmp.nPrs).toBe(2);
	});
});

describe("verdictFor", () => {
	const thresholds = samplePlan().thresholds;
	const cmp = (over = {}) => ({
		precision: { mean: 0.2, lo: 0.05, hi: 0.3, n: 12 },
		recallDiffPoints: -2,
		medianCostCandidate: 1,
		medianCostBaseline: 1,
		fitShare: 0.95,
		nPrs: 12,
		...over,
	});
	const gate = {
		pass: true,
		originalsMissed: 0,
		cleanFindings: 0,
		reasons: [],
	};
	const base = {
		directional: false,
		thresholds,
		seedGate: gate,
		openai: cmp(),
	};

	it("prints no verdict when directional", () => {
		const v = verdictFor({ ...base, directional: true, anthropic: cmp() });
		expect(v.go).toBeNull();
		expect(v.label).toMatch(/directional/);
	});

	it("goes when both providers clear every bar", () => {
		expect(verdictFor({ ...base, anthropic: cmp() }).go).toBe(true);
	});

	it("is no-go when the precision interval includes zero", () => {
		const v = verdictFor({
			...base,
			anthropic: cmp({ precision: { mean: 0.1, lo: -0.01, hi: 0.2, n: 12 } }),
		});
		expect(v.go).toBe(false);
	});

	it("is no-go when recall drops more than the limit", () => {
		expect(
			verdictFor({ ...base, anthropic: cmp({ recallDiffPoints: -5.1 }) }).go,
		).toBe(false);
		expect(
			verdictFor({ ...base, anthropic: cmp({ recallDiffPoints: -5 }) }).go,
		).toBe(true);
	});

	it("allows higher cost only when precision and recall clear", () => {
		const pricier = { medianCostCandidate: 2 };
		expect(verdictFor({ ...base, anthropic: cmp(pricier) }).go).toBe(true);
		const weak = cmp({
			...pricier,
			precision: { mean: 0, lo: -0.1, hi: 0.1, n: 12 },
		});
		expect(verdictFor({ ...base, anthropic: weak }).go).toBe(false);
	});

	it("labels a candidate under 90% inside 210s as local-only", () => {
		const v = verdictFor({ ...base, anthropic: cmp({ fitShare: 0.89 }) });
		expect(v.hosted).toBe(false);
		expect(v.label).toMatch(/local-only/);
		expect(
			verdictFor({ ...base, anthropic: cmp({ fitShare: 0.9 }) }).hosted,
		).toBe(true);
	});

	it("is no-go when the seed gate fails and incomplete when it was not run", () => {
		const failed = { ...gate, pass: false, reasons: ["2 originals missed"] };
		expect(verdictFor({ ...base, anthropic: cmp(), seedGate: failed }).go).toBe(
			false,
		);
		const none = verdictFor({ ...base, anthropic: cmp(), seedGate: null });
		expect(none.go).toBeNull();
		expect(none.reasons.join(" ")).toMatch(/seed gate/);
	});

	it("carries no go or no-go when only Anthropic was evaluated", () => {
		const v = verdictFor({ ...base, anthropic: cmp(), openai: null });
		expect(v.go).toBeNull();
		expect(v.label).toBe("Anthropic-only, unconfirmed on OpenAI");
	});

	it("is no-go when OpenAI confirmation fails", () => {
		const v = verdictFor({
			...base,
			anthropic: cmp(),
			openai: cmp({ precision: { mean: 0, lo: -0.1, hi: 0.1, n: 5 } }),
		});
		expect(v.go).toBe(false);
	});
});

describe("scoreExperiment", () => {
	const plan = {
		...samplePlan(),
		strategies: [
			{ name: "a", version: "v1" },
			{ name: "b", version: "v1" },
		],
		fixtures: [
			{ id: "o/r#1", split: "tuning" as const, provider: "anthropic" as const },
			{ id: "o/r#2", split: "test" as const, provider: "anthropic" as const },
		],
	};
	const fixtures = { "o/r#1": scored(1), "o/r#2": scored(2) };
	const records = [
		cell({ strategy: "a", fixtureId: "o/r#1", posted: [cand(C2)] }),
		cell({ strategy: "b", fixtureId: "o/r#1", posted: [cand(C1)] }),
		cell({ strategy: "a", fixtureId: "o/r#2", posted: [cand(C2)] }),
		cell({ strategy: "b", fixtureId: "o/r#2", posted: [cand(C1)] }),
	];
	const run = (final: boolean, recs = records) =>
		scoreExperiment({
			plan,
			records: recs,
			fixtures,
			cache: cacheOf([]),
			final,
			baseline: "a",
			seedGates: {},
			exploratory: null,
			bootstrapSeed: "s",
		});

	it("never reads test-split cells outside --final", () => {
		const out = run(false);
		const ids = new Set(out.perPr.map((p) => p.fixtureId));
		expect(ids).toEqual(new Set(["o/r#1"]));
		expect(out.verdicts).toEqual([]);
	});

	it("reads only the test split under --final", () => {
		const out = run(true);
		expect(new Set(out.perPr.map((p) => p.fixtureId))).toEqual(
			new Set(["o/r#2"]),
		);
		expect(out.directional).toBe(true);
		expect(out.verdicts[0]?.verdict.go).toBeNull();
	});

	it("excludes stale cells and reports a partial grid", () => {
		const out = run(false, [
			...records,
			cell({ strategy: "a", fixtureId: "o/r#1", round: 1, stale: true }),
		]);
		expect(out.staleExcluded).toBe(1);
		expect(out.partial).toBe(true);
	});
});
