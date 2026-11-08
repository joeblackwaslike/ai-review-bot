import { isSameClaim } from "../../claim-dedupe.js";
import { JOIN_CLAIM_MATCH } from "../metrics.js";
import {
	type CandidateRecord,
	fixtureFamily,
	type Provider,
} from "../types.js";
import { type BootstrapInterval, pairedBootstrap } from "./bootstrap.js";
import { type ScoredFixture, scorePr } from "./score.js";
import type { StoredCell } from "./store.js";

export interface ChainScore {
	strategy: string;
	fixtureId: string;
	provider: Provider;
	recycling: number | null;
	convergenceRound: number;
	complete: boolean;
	recall: number | null;
}

export function scoreChain(args: {
	strategy: string;
	fixtureId: string;
	records: StoredCell[];
	fx: ScoredFixture;
	plannedRounds: number;
}): ChainScore {
	const rounds = [...args.records].sort((a, b) => a.key.round - b.key.round);
	const seen: CandidateRecord[] = [];
	let later = 0;
	let recycled = 0;
	rounds.forEach((rec, i) => {
		for (const c of rec.result.posted) {
			if (i > 0) {
				later++;
				if (seen.some((s) => isSameClaim(c, s, JOIN_CLAIM_MATCH))) recycled++;
			}
		}
		seen.push(...rec.result.posted);
	});
	const complete =
		new Set(rounds.map((r) => r.key.round)).size >= args.plannedRounds;
	const firstEmpty = rounds.find((r) => r.result.posted.length === 0);
	return {
		strategy: args.strategy,
		fixtureId: args.fixtureId,
		provider: fixtureFamily(args.fx.fixture),
		recycling: later > 0 ? recycled / later : null,
		convergenceRound:
			complete && firstEmpty ? firstEmpty.key.round : args.plannedRounds,
		complete,
		recall: scorePr({ ...args, cache: { get: () => undefined } }).recall,
	};
}

const mean = (xs: number[]): number | null =>
	xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

export interface ChainSummary {
	strategy: string;
	provider: Provider;
	nPrs: number;
	recycling: number | null;
	convergenceRound: number | null;
	recall: number | null;
	incompleteRate: number;
}

const present = (xs: (number | null)[]): number[] =>
	xs.flatMap((x) => (x === null ? [] : [x]));

export function aggregateChains(chains: ChainScore[]): ChainSummary {
	return {
		strategy: chains[0]?.strategy ?? "",
		provider: chains[0]?.provider ?? "anthropic",
		nPrs: chains.length,
		recycling: mean(present(chains.map((c) => c.recycling))),
		convergenceRound: mean(chains.map((c) => c.convergenceRound)),
		recall: mean(present(chains.map((c) => c.recall))),
		incompleteRate:
			chains.length > 0
				? chains.filter((c) => !c.complete).length / chains.length
				: 0,
	};
}

export interface ChainComparison {
	candidate: string;
	provider: Provider;
	nPrs: number;
	excludedIncomplete: number;
	recycling: BootstrapInterval;
	convergence: BootstrapInterval;
}

export function compareChains(
	candidate: string,
	provider: Provider,
	cand: ChainScore[],
	base: ChainScore[],
	opts: { level: number; resamples: number; seed: string },
): ChainComparison {
	const baseById = new Map(base.map((b) => [b.fixtureId, b]));
	const pairs = cand.flatMap((c) => {
		const b = baseById.get(c.fixtureId);
		return b && c.complete && b.complete ? [{ c, b }] : [];
	});
	return {
		candidate,
		provider,
		nPrs: pairs.length,
		excludedIncomplete:
			new Set([...cand, ...base].map((x) => x.fixtureId)).size - pairs.length,
		recycling: pairedBootstrap(
			pairs.flatMap(({ c, b }) =>
				c.recycling !== null && b.recycling !== null
					? [{ a: c.recycling, b: b.recycling }]
					: [],
			),
			opts,
		),
		convergence: pairedBootstrap(
			pairs.map(({ c, b }) => ({
				a: c.convergenceRound,
				b: b.convergenceRound,
			})),
			opts,
		),
	};
}

export interface ChainedScore {
	perPr: ChainScore[];
	summaries: ChainSummary[];
	comparisons: ChainComparison[];
}
