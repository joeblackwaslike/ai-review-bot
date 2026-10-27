import { type ReplayResult, roundCutoff, visibleLabels } from "./replay.js";
import type { LabelFile, ReplayFixture } from "./types.js";

export interface RepeatCount {
	count: number;
	posted: number;
	proposedExtra: number;
}

export interface Metrics {
	rejection: { rejected: number; adjudicated: number };
	deferred: number;
	unadjudicated: number;
	recycled: RepeatCount;
	restatedOpen: RepeatCount;
	convergence: {
		roundsWithFirstSeen: number;
		totalRounds: number;
		finalRoundQuiet: boolean;
	};
}

export function earlierRepeats(
	f: ReplayFixture,
	labels: LabelFile,
	id: string,
	confirmed: boolean,
): string[] {
	const roundOf = new Map(
		f.rounds.flatMap((r) => r.claims.map((c) => [c.id, r.index] as const)),
	);
	const own = roundOf.get(id) ?? Number.NEGATIVE_INFINITY;
	return labels.repeatPairs
		.filter(
			(p) =>
				p.later === id &&
				p.confirmed === confirmed &&
				(roundOf.get(p.earlier) ?? Number.POSITIVE_INFINITY) < own,
		)
		.map((p) => p.earlier);
}

const SETTLED = new Set(["fixed", "rejected", "deferred"]);

export function computeMetrics(
	f: ReplayFixture,
	labels: LabelFile,
	result: ReplayResult,
): Metrics {
	const finalLabel = new Map(labels.labels.map((l) => [l.claimId, l.label]));
	let fixed = 0;
	let rejected = 0;
	let deferred = 0;
	let unadjudicated = 0;
	for (const round of f.rounds) {
		for (const c of round.claims) {
			const label = finalLabel.get(c.id);
			if (label === "fixed") fixed++;
			else if (label === "rejected") rejected++;
			else if (label === "deferred") deferred++;
			else unadjudicated++;
		}
	}

	const recycled: RepeatCount = { count: 0, posted: 0, proposedExtra: 0 };
	const restatedOpen: RepeatCount = { count: 0, posted: 0, proposedExtra: 0 };
	let roundsWithFirstSeen = 0;
	let finalRoundQuiet = false;

	for (const res of result.rounds) {
		const round = f.rounds.find((r) => r.index === res.index);
		if (!round) continue;
		const visible = visibleLabels(f, labels, roundCutoff(round));
		const isSettled = (id: string): boolean => {
			const v = visible.get(id);
			return v !== undefined && SETTLED.has(v.label);
		};
		let firstSeen = 0;
		for (const id of res.posted) {
			recycled.posted++;
			restatedOpen.posted++;
			const earlier = (confirmed: boolean) =>
				earlierRepeats(f, labels, id, confirmed);
			const confirmedEarlier = earlier(true);
			if (confirmedEarlier.length === 0) firstSeen++;
			const [target, bucket] =
				confirmedEarlier.length > 0
					? ([confirmedEarlier, "count"] as const)
					: ([earlier(false), "proposedExtra"] as const);
			if (target.length === 0) continue;
			const counter = target.some(isSettled) ? recycled : restatedOpen;
			counter[bucket]++;
		}
		if (firstSeen > 0) roundsWithFirstSeen++;
		finalRoundQuiet = firstSeen === 0;
	}

	return {
		rejection: { rejected, adjudicated: fixed + rejected },
		deferred,
		unadjudicated,
		recycled,
		restatedOpen,
		convergence: {
			roundsWithFirstSeen,
			totalRounds: result.rounds.length,
			finalRoundQuiet,
		},
	};
}

function repeatText(r: RepeatCount): string {
	const extra = r.proposedExtra > 0 ? `, +${r.proposedExtra} proposed` : "";
	return `${r.count} of ${r.posted}${extra}`;
}

export function formatReport(m: Metrics[], ids: string[]): string {
	return m
		.map((x, i) =>
			[
				`${ids[i]}`,
				`  rejected: ${x.rejection.rejected} of ${x.rejection.adjudicated} adjudicated (deferred ${x.deferred}, unadjudicated ${x.unadjudicated})`,
				`  recycled: ${repeatText(x.recycled)}`,
				`  restated open: ${repeatText(x.restatedOpen)}`,
				`  rounds with first-seen claims: ${x.convergence.roundsWithFirstSeen} of ${x.convergence.totalRounds}, final round quiet: ${x.convergence.finalRoundQuiet ? "yes" : "no"}`,
			].join("\n"),
		)
		.join("\n\n");
}
