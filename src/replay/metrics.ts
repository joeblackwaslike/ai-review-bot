import {
	type ClaimMatchOptions,
	claimTokens,
	DEFAULT_CLAIM_MATCH,
	isSameClaim,
} from "../claim-dedupe.js";
import { type ReplayResult, roundCutoff, visibleLabels } from "./replay.js";
import type {
	CandidateRecord,
	LabelFile,
	PostedClaim,
	ReplayFixture,
} from "./types.js";

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
	joinRate?: { joined: number; candidates: number };
}

/** Claims of the fixture that have an entry in the label file. */
export function labelledClaims(
	f: ReplayFixture,
	labels: LabelFile,
): PostedClaim[] {
	const labelled = new Set(labels.labels.map((l) => l.claimId));
	return f.rounds.flatMap((r) => r.claims.filter((c) => labelled.has(c.id)));
}

/** PROVISIONAL: derived from one fixture's observed pairs (ai-review-bot-demo#2).
 * Within 3 lines a candidate joins a claim at 0.33 title overlap instead of
 * 0.5, because a restatement at the same anchor tends to reword the title
 * ("Preserve the base delay before the first retry" for "Preserve the existing
 * retry-delay schedule", 0.375). Same file is still required. That fixture is
 * the held-out ai-review-bot-demo#2, so its join figure is in-sample. */
export const JOIN_CLAIM_MATCH: ClaimMatchOptions = {
	...DEFAULT_CLAIM_MATCH,
	nearby: { lineWindow: 3, titleSimilarity: 0.33 },
};

/** PROVISIONAL: a labelled claim's title can misstate what its body argues
 * (ai-listings#50: a claim titled "Log condition misses ..." whose body is about
 * an empty `{}` object masking the real payload). So a candidate also joins when
 * its title words are mostly found in the claim's full text (title and body).
 * Coverage alone is fooled by short titles, so a minimum count of shared words is
 * required too. Chosen from 3 positives and 12 negatives on one fixture; not
 * validated on a second repository. */
export const JOIN_BODY_MATCH = {
	lineWindow: 10,
	minShared: 5,
	minCoverage: 0.75,
};

function joinsByBody(cand: CandidateRecord, claim: PostedClaim): boolean {
	if (!cand.path || cand.path !== claim.path) return false;
	if (cand.line === null || claim.line === null) return false;
	if (Math.abs(cand.line - claim.line) > JOIN_BODY_MATCH.lineWindow)
		return false;
	const words = claimTokens(cand.title);
	if (words.size === 0) return false;
	const text = claimTokens(`${claim.title} ${claim.text ?? ""}`);
	let shared = 0;
	for (const w of words) if (text.has(w)) shared += 1;
	return (
		shared >= JOIN_BODY_MATCH.minShared &&
		shared / words.size >= JOIN_BODY_MATCH.minCoverage
	);
}

/** The join rule `countJoined` applies: title match or body match. */
export function joinsClaim(cand: CandidateRecord, claim: PostedClaim): boolean {
	return isSameClaim(cand, claim, JOIN_CLAIM_MATCH) || joinsByBody(cand, claim);
}

/** Distinct candidates, by path, line and title, and how many of them restate
 * one of the given claims. Several agents raising one finding count once. */
export function countJoined(
	candidates: CandidateRecord[],
	claims: PostedClaim[],
): { joined: number; candidates: number } {
	const distinct = [
		...new Map(
			candidates.map((c) => [`${c.path}\0${c.line}\0${c.title}`, c]),
		).values(),
	];
	return {
		joined: distinct.filter((cand) => claims.some((c) => joinsClaim(cand, c)))
			.length,
		candidates: distinct.length,
	};
}

function computeJoinRate(
	f: ReplayFixture,
	labels: LabelFile,
): Metrics["joinRate"] {
	if (!f.rounds.some((r) => r.trace)) return undefined;
	const claims = labelledClaims(f, labels);
	let joined = 0;
	let candidates = 0;
	for (const round of f.rounds) {
		const counted = countJoined(round.trace?.candidates ?? [], claims);
		candidates += counted.candidates;
		joined += counted.joined;
	}
	return { joined, candidates };
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

	const joinRate = computeJoinRate(f, labels);
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
		...(joinRate ? { joinRate } : {}),
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
				...(x.joinRate
					? [`  join rate: ${x.joinRate.joined}/${x.joinRate.candidates}`]
					: []),
			].join("\n"),
		)
		.join("\n\n");
}
