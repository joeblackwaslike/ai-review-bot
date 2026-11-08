import { claimKey, snapshotId } from "../adjudication/snapshot.js";
import type { VerdictRecord } from "../adjudication/types.js";
import { countJoined, joinsClaim, labelledClaims } from "../metrics.js";
import type { SeedGate } from "../seeds/score.js";
import {
	type CandidateRecord,
	fixtureFamily,
	type LabelFile,
	type PostedClaim,
	type Provider,
	type ReplayFixture,
} from "../types.js";
import {
	type BootstrapInterval,
	median,
	pairedBootstrap,
} from "./bootstrap.js";
import {
	aggregateChains,
	type ChainedScore,
	type ChainScore,
	mean as chainMean,
	compareChains,
	present,
	scoreChain,
} from "./chain-score.js";
import { readableFixtureIds } from "./final-guard.js";
import type { ExperimentPlan } from "./plan.js";
import { isDirectional } from "./splits.js";
import type { StoredCell } from "./store.js";

export interface ScoredFixture {
	fixture: ReplayFixture;
	labels: LabelFile;
	/** Real defects an audit added beyond the labels; they join the recall denominator. */
	extraDefects?: { path: string; line: number; title: string }[];
}

export interface VerdictLookup {
	get(snapshot: string, key: string): unknown;
}

export const JOIN_MATCHER = "isSameClaim@JOIN_CLAIM_MATCH+JOIN_BODY_MATCH";

export interface JoinRate {
	joined: number;
	candidates: number;
	matcher: string;
}

export interface PrScore {
	strategy: string;
	fixtureId: string;
	provider: Provider;
	real: number;
	notReal: number;
	unresolved: number;
	unadjudicated: number;
	singleFamily: number;
	moved: number;
	provisional: number;
	precision: number | null;
	recall: number | null;
	foundClaims: number;
	totalClaims: number;
	joinRate: JoinRate;
	costUsd: number;
	rounds: number;
	fitRounds: number;
	/** Completed `round:trial` cells, sorted. */
	cells: string[];
	wallMs: number[];
}

const asVerdict = (v: unknown): VerdictRecord | undefined => {
	const r = v as VerdictRecord | undefined;
	return r && (r.kind === undefined || r.kind === "verdict") && r.verdict
		? r
		: undefined;
};

/**
 * One strategy on one PR, all rounds and trials. A posted finding is real or not by the label of
 * the claim it restates, else by a cached adjudication verdict; nothing here calls a judge.
 * Unadjudicated, unclear and unresolved findings leave precision's numerator and denominator.
 */
export function scorePr(args: {
	strategy: string;
	fixtureId: string;
	records: StoredCell[];
	fx: ScoredFixture;
	cache: VerdictLookup;
}): PrScore {
	const { fx, cache, records } = args;
	const claims = labelledClaims(fx.fixture, fx.labels);
	const labelOf = new Map(fx.labels.labels.map((l) => [l.claimId, l]));
	const snapshot = snapshotId(fx.fixture);
	const out: PrScore = {
		strategy: args.strategy,
		fixtureId: args.fixtureId,
		provider: fixtureFamily(fx.fixture),
		real: 0,
		notReal: 0,
		unresolved: 0,
		unadjudicated: 0,
		singleFamily: 0,
		moved: 0,
		provisional: 0,
		precision: null,
		recall: null,
		foundClaims: 0,
		totalClaims: 0,
		joinRate: { joined: 0, candidates: 0, matcher: JOIN_MATCHER },
		costUsd: 0,
		rounds: records.length,
		fitRounds: 0,
		cells: records.map((r) => `${r.key.round}:${r.key.trial}`).sort(),
		wallMs: records.map((r) => r.result.wallMs),
	};
	const fixedClaims = claims.filter(
		(c) => labelOf.get(c.id)?.label === "fixed",
	);
	const extras = (fx.extraDefects ?? []).map(
		(d) =>
			({
				...d,
				id: `${d.path}\u0000${d.line}\u0000${d.title}`,
				text: "",
			}) as unknown as PostedClaim,
	);
	const found = new Set<string>();

	for (const rec of records) {
		out.costUsd += rec.costUsd;
		if (rec.fitIn210s) out.fitRounds++;
		for (const c of rec.result.posted) {
			for (const target of [...fixedClaims, ...extras])
				if (joinsClaim(c, target)) found.add(target.id);
			classify(c);
		}
	}

	function classify(c: CandidateRecord): void {
		const claim = claims.find((cl) => joinsClaim(c, cl));
		if (claim) {
			const label = labelOf.get(claim.id);
			if (label && !label.confirmed) out.provisional++;
			if (label?.label === "fixed") out.real++;
			else if (label?.label === "rejected") out.notReal++;
			else out.unadjudicated++;
			return;
		}
		const v = asVerdict(cache.get(snapshot, claimKey(c)));
		if (!v) {
			out.unadjudicated++;
			return;
		}
		if (v.status === "unresolved" || v.verdict === "unclear") {
			out.unresolved++;
			return;
		}
		if (v.status === "single-family") out.singleFamily++;
		if (v.scope === "moved") out.moved++;
		if (v.verdict === "real") out.real++;
		else out.notReal++;
	}

	out.joinRate = {
		...countJoined(
			records.flatMap((r) => r.result.candidates),
			claims,
		),
		matcher: JOIN_MATCHER,
	};
	out.foundClaims = found.size;
	out.totalClaims = fixedClaims.length + extras.length;
	const judged = out.real + out.notReal;
	out.precision = judged > 0 ? out.real / judged : null;
	out.recall = out.totalClaims > 0 ? out.foundClaims / out.totalClaims : null;
	return out;
}

const mean = (xs: number[]): number | null =>
	xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

export interface Summary {
	strategy: string;
	provider: Provider;
	nPrs: number;
	precision: number | null;
	recall: number | null;
	real: number;
	notReal: number;
	unresolved: number;
	unadjudicated: number;
	singleFamily: number;
	moved: number;
	provisional: number;
	joinRate: JoinRate;
	medianCostUsd: number;
	medianWallMs: number;
	fitShare: number;
}

export function aggregate(prs: PrScore[]): Summary {
	const sum = (f: (p: PrScore) => number) => prs.reduce((s, p) => s + f(p), 0);
	const rounds = sum((p) => p.rounds);
	return {
		strategy: prs[0]?.strategy ?? "",
		provider: prs[0]?.provider ?? "anthropic",
		nPrs: prs.length,
		precision: mean(
			prs.flatMap((p) => (p.precision === null ? [] : [p.precision])),
		),
		recall: mean(prs.flatMap((p) => (p.recall === null ? [] : [p.recall]))),
		real: sum((p) => p.real),
		notReal: sum((p) => p.notReal),
		unresolved: sum((p) => p.unresolved),
		unadjudicated: sum((p) => p.unadjudicated),
		singleFamily: sum((p) => p.singleFamily),
		moved: sum((p) => p.moved),
		provisional: sum((p) => p.provisional),
		joinRate: {
			joined: sum((p) => p.joinRate.joined),
			candidates: sum((p) => p.joinRate.candidates),
			matcher: prs[0]?.joinRate.matcher ?? JOIN_MATCHER,
		},
		medianCostUsd: median(prs.map((p) => p.costUsd)),
		medianWallMs: median(prs.flatMap((p) => p.wallMs)),
		fitShare: rounds > 0 ? sum((p) => p.fitRounds) / rounds : 0,
	};
}

export interface Comparison {
	precision: BootstrapInterval;
	recallDiffPoints: number | null;
	medianCostCandidate: number;
	medianCostBaseline: number;
	fitShare: number;
	/** PRs paired: both strategies completed the same cells. */
	nPrs: number;
	excludedIncomplete: number;
	excludedNullPrecision: number;
	/** Cells shared by both strategies, summed over the paired PRs. */
	intersectionCells: number;
	/** PRs where the two strategies share no cell; set by `scoreExperiment`. */
	emptyIntersectionPrs: string[];
}

/** Paired over the PRs both strategies completed; claims within a PR are never resampled apart. */
export function compareStrategies(
	candidate: PrScore[],
	baseline: PrScore[],
	opts: { level: number; resamples: number; seed: string },
): Comparison {
	const baseById = new Map(baseline.map((p) => [p.fixtureId, p]));
	const same = (x: string[], y: string[]) =>
		x.length === y.length && x.every((v, i) => v === y[i]);
	const both = candidate.flatMap((c) => {
		const b = baseById.get(c.fixtureId);
		return b && same(c.cells, b.cells) ? [{ c, b }] : [];
	});
	const prs = new Set([...candidate, ...baseline].map((p) => p.fixtureId));
	const excludedIncomplete = prs.size - both.length;
	const excludedNullPrecision = both.filter(
		({ c, b }) => c.precision === null || b.precision === null,
	).length;
	const precisionPairs = both.flatMap(({ c, b }) =>
		c.precision !== null && b.precision !== null
			? [{ a: c.precision, b: b.precision }]
			: [],
	);
	const recallDiffs = both.flatMap(({ c, b }) =>
		c.recall !== null && b.recall !== null ? [c.recall - b.recall] : [],
	);
	const rounds = both.reduce((s, { c }) => s + c.rounds, 0);
	const fit = both.reduce((s, { c }) => s + c.fitRounds, 0);
	const recallMean = mean(recallDiffs);
	return {
		precision: pairedBootstrap(precisionPairs, opts),
		recallDiffPoints: recallMean === null ? null : recallMean * 100,
		medianCostCandidate: median(both.map(({ c }) => c.costUsd)),
		medianCostBaseline: median(both.map(({ b }) => b.costUsd)),
		fitShare: rounds > 0 ? fit / rounds : 0,
		nPrs: both.length,
		excludedIncomplete,
		excludedNullPrecision,
		intersectionCells: both.reduce((s, { c }) => s + c.cells.length, 0),
		emptyIntersectionPrs: [],
	};
}

export interface Verdict {
	label: string;
	go: boolean | null;
	hosted: boolean;
	reasons: string[];
}

function clears(
	c: Comparison,
	t: ExperimentPlan["thresholds"],
): { pass: boolean; reasons: string[] } {
	const reasons: string[] = [];
	const precisionOk = c.precision.n > 0 && c.precision.lo > 0;
	const recallOk =
		c.recallDiffPoints !== null && -c.recallDiffPoints <= t.maxRecallDropPoints;
	const costOk =
		c.medianCostCandidate <= c.medianCostBaseline || (precisionOk && recallOk);
	if (!precisionOk)
		reasons.push("precision interval does not lie wholly above zero");
	if (!recallOk)
		reasons.push(`recall dropped more than ${t.maxRecallDropPoints} points`);
	if (!costOk)
		reasons.push("costs more than the baseline without clearing both bars");
	return { pass: precisionOk && recallOk && costOk, reasons };
}

/** Spec section 9 and the OpenAI-quota rule. Only the final test-set comparison feeds this. */
export function verdictFor(input: {
	directional: boolean;
	anthropic: Comparison | null;
	openai: Comparison | null;
	thresholds: ExperimentPlan["thresholds"];
	seedGate: SeedGate | null;
}): Verdict {
	const { thresholds: t } = input;
	if (input.directional)
		return {
			label: "directional only: below 30 PRs, 10 per split or 5 repositories",
			go: null,
			hosted: false,
			reasons: [],
		};
	if (!input.anthropic)
		return {
			label: "no Anthropic data",
			go: null,
			hosted: false,
			reasons: ["no paired Anthropic PRs"],
		};
	const openai =
		input.openai && input.openai.nPrs > 0 && input.openai.precision.n > 0
			? input.openai
			: null;
	const hosted =
		input.anthropic.fitShare >= t.hostedFitShare &&
		(openai === null || openai.fitShare >= t.hostedFitShare);
	const suffix = hosted ? "hosted" : "local-only";
	if (!input.seedGate)
		return {
			label: "incomplete",
			go: null,
			hosted,
			reasons: ["seed gate was not run for this strategy"],
		};
	if (!input.seedGate.pass)
		return {
			label: `no-go (${suffix})`,
			go: false,
			hosted,
			reasons: input.seedGate.reasons,
		};
	const a = clears(input.anthropic, t);
	if (!a.pass)
		return {
			label: `no-go (${suffix})`,
			go: false,
			hosted,
			reasons: a.reasons,
		};
	if (!openai)
		return {
			label: "Anthropic-only, unconfirmed on OpenAI",
			go: null,
			hosted,
			reasons: [],
		};
	const o = clears(openai, t);
	if (!o.pass)
		return {
			label: `no-go (${suffix}); fails on OpenAI`,
			go: false,
			hosted,
			reasons: o.reasons,
		};
	return { label: `go (${suffix})`, go: true, hosted, reasons: [] };
}

export interface ExperimentScore {
	final: boolean;
	directional: boolean;
	exploratory: string | null;
	partial: boolean;
	/** Fresh cells that spent past the budget they were given. */
	overCapCells: number;
	staleExcluded: number;
	baseline: string;
	perPr: PrScore[];
	summaries: Summary[];
	comparisons: {
		candidate: string;
		provider: Provider;
		comparison: Comparison;
	}[];
	verdicts: { candidate: string; verdict: Verdict }[];
	chained?: ChainedScore;
}

function scoreChained(args: {
	plan: ExperimentPlan;
	fresh: StoredCell[];
	fixtures: Record<string, ScoredFixture>;
	baseline: string;
	opts: { level: number; resamples: number; seed: string };
}): ChainedScore {
	const { plan, fixtures } = args;
	const groups = new Map<string, StoredCell[]>();
	for (const r of args.fresh) {
		const k = `${r.key.strategy}\u0000${r.key.fixtureId}\u0000${r.key.trial}`;
		groups.set(k, [...(groups.get(k) ?? []), r]);
	}
	const chains: ChainScore[] = [];
	for (const [k, records] of groups) {
		const [strategy, fixtureId] = k.split("\u0000") as [string, string];
		const fx = fixtures[fixtureId];
		if (fx)
			chains.push(
				scoreChain({
					strategy,
					fixtureId,
					records,
					fx,
					plannedRounds: fx.fixture.rounds.length,
				}),
			);
	}
	const perPr: ChainScore[] = [];
	const keys = new Set(chains.map((c) => `${c.strategy}\u0000${c.fixtureId}`));
	for (const k of keys) {
		const cs = chains.filter((c) => `${c.strategy}\u0000${c.fixtureId}` === k);
		const avg = (f: (c: ChainScore) => number | null) =>
			chainMean(present(cs.map(f)));
		perPr.push({
			...(cs[0] as ChainScore),
			recycling: avg((c) => c.recycling),
			convergenceRound: avg((c) => c.convergenceRound) as number,
			recall: avg((c) => c.recall),
			complete: cs.every((c) => c.complete),
		});
	}
	const strategies = plan.strategies.map((s) => s.name);
	const providers = [...new Set(perPr.map((p) => p.provider))];
	return {
		perPr,
		summaries: strategies.flatMap((strategy) =>
			providers.flatMap((provider) => {
				const cs = perPr.filter(
					(p) => p.strategy === strategy && p.provider === provider,
				);
				return cs.length > 0 ? [aggregateChains(cs)] : [];
			}),
		),
		comparisons: strategies
			.filter((s) => s !== args.baseline)
			.flatMap((candidate) =>
				providers.map((provider) => {
					const of = (strategy: string) =>
						perPr.filter(
							(p) => p.strategy === strategy && p.provider === provider,
						);
					return compareChains(
						candidate,
						provider,
						of(candidate),
						of(args.baseline),
						args.opts,
					);
				}),
			),
	};
}

export function scoreExperiment(args: {
	plan: ExperimentPlan;
	records: StoredCell[];
	fixtures: Record<string, ScoredFixture>;
	cache: VerdictLookup;
	final: boolean;
	baseline: string;
	seedGates: Record<string, SeedGate>;
	exploratory: string | null;
	bootstrapSeed?: string;
}): ExperimentScore {
	const { plan, fixtures, final } = args;
	const readable = readableFixtureIds(plan, final);
	const inScope = args.records.filter((r) => readable.has(r.key.fixtureId));
	const staleExcluded = inScope.filter((r) => r.stale).length;
	const fresh = inScope.filter((r) => !r.stale);
	const overCapCells = fresh.filter((r) => r.overCap).length;

	const opts = {
		level: plan.thresholds.precisionBootstrap.level,
		resamples: plan.thresholds.precisionBootstrap.resamples,
		seed: args.bootstrapSeed ?? plan.seed,
	};
	if (plan.mode === "chained") {
		const chained = scoreChained({
			plan,
			fresh,
			fixtures,
			baseline: args.baseline,
			opts,
		});
		const distinctCells = new Set(
			fresh.map(
				(r) =>
					`${r.key.strategy}\u0000${r.key.fixtureId}\u0000${r.key.round}\u0000${r.key.trial}`,
			),
		).size;
		const planned = plan.fixtures
			.filter((f) => readable.has(f.id) && plan.providers.includes(f.provider))
			.reduce(
				(n, f) =>
					n +
					(fixtures[f.id]?.fixture.rounds.length ?? 0) *
						plan.trials *
						plan.strategies.length,
				0,
			);
		return {
			final,
			directional: isDirectional(plan),
			exploratory: args.exploratory,
			partial: distinctCells < planned || overCapCells > 0,
			overCapCells,
			staleExcluded,
			baseline: args.baseline,
			perPr: [],
			summaries: [],
			comparisons: [],
			verdicts: [],
			chained,
		};
	}

	const groups = new Map<string, StoredCell[]>();
	for (const r of fresh) {
		const k = `${r.key.strategy}\u0000${r.key.fixtureId}`;
		groups.set(k, [...(groups.get(k) ?? []), r]);
	}
	const perPr: PrScore[] = [];
	for (const [k, records] of groups) {
		const [strategy, fixtureId] = k.split("\u0000") as [string, string];
		const fx = fixtures[fixtureId];
		if (fx)
			perPr.push(
				scorePr({ strategy, fixtureId, records, fx, cache: args.cache }),
			);
	}

	const expected = plan.fixtures
		.filter((f) => readable.has(f.id) && plan.providers.includes(f.provider))
		.reduce(
			(s, f) =>
				s +
				(fixtures[f.id]?.fixture.rounds.length ?? 0) *
					plan.trials *
					plan.strategies.length,
			0,
		);

	const strategies = plan.strategies.map((s) => s.name);
	const providers = [...new Set(perPr.map((p) => p.provider))];
	const summaries = strategies.flatMap((strategy) =>
		providers.flatMap((provider) => {
			const prs = perPr.filter(
				(p) => p.strategy === strategy && p.provider === provider,
			);
			return prs.length > 0 ? [aggregate(prs)] : [];
		}),
	);

	const fixtureIds = [...new Set(perPr.map((p) => p.fixtureId))];
	const comparisons = strategies
		.filter((s) => s !== args.baseline)
		.flatMap((candidate) =>
			providers.map((provider) => {
				const candPrs: PrScore[] = [];
				const basePrs: PrScore[] = [];
				const empty: string[] = [];
				for (const id of fixtureIds) {
					const fx = fixtures[id];
					if (!fx || fixtureFamily(fx.fixture) !== provider) continue;
					const of = (strategy: string) =>
						fresh.filter(
							(r) => r.key.strategy === strategy && r.key.fixtureId === id,
						);
					const cellOf = (r: StoredCell) => `${r.key.round}:${r.key.trial}`;
					const baseRecs = of(args.baseline);
					const candRecs = of(candidate);
					if (baseRecs.length === 0 && candRecs.length === 0) continue;
					const shared = new Set(
						baseRecs
							.map(cellOf)
							.filter((c) => candRecs.some((r) => cellOf(r) === c)),
					);
					if (shared.size === 0) {
						empty.push(id);
						continue;
					}
					const pick = (recs: StoredCell[], strategy: string) =>
						scorePr({
							strategy,
							fixtureId: id,
							records: recs.filter((r) => shared.has(cellOf(r))),
							fx,
							cache: args.cache,
						});
					candPrs.push(pick(candRecs, candidate));
					basePrs.push(pick(baseRecs, args.baseline));
				}
				const comparison = compareStrategies(candPrs, basePrs, opts);
				return {
					candidate,
					provider,
					comparison: {
						...comparison,
						excludedIncomplete: empty.length,
						emptyIntersectionPrs: empty,
					},
				};
			}),
		);

	const directional = isDirectional(plan);
	const verdicts = final
		? strategies
				.filter((s) => s !== args.baseline)
				.map((candidate) => {
					const pick = (provider: Provider) =>
						comparisons.find(
							(c) => c.candidate === candidate && c.provider === provider,
						)?.comparison ?? null;
					return {
						candidate,
						verdict: verdictFor({
							directional,
							anthropic: pick("anthropic"),
							openai: pick("openai"),
							thresholds: plan.thresholds,
							seedGate: args.seedGates[candidate] ?? null,
						}),
					};
				})
		: [];

	return {
		final,
		directional,
		exploratory: args.exploratory,
		partial: fresh.length < expected || overCapCells > 0,
		overCapCells,
		staleExcluded,
		baseline: args.baseline,
		perPr,
		summaries,
		comparisons,
		verdicts,
	};
}
