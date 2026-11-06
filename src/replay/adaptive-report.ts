import type {
	ModelFinding,
	ModelInlineComment,
	ModelReview,
	PullFile,
} from "../review.js";
import { REVIEWER_TUNING } from "../reviewer-tuning.js";
import { fixtureId } from "./claims.js";
import { candidateKey, joinsClaim, labelledClaims } from "./metrics.js";
import {
	adaptiveInputForRound,
	ledgerForRound,
	postFilterTrace,
} from "./trace.js";
import type {
	CandidateRecord,
	LabelFile,
	ReplayFixture,
	Round,
} from "./types.js";

export type AdjudicatedVerdict = "real" | "not-real" | "unclear";

/** Minimum removed candidates carrying a label or an adjudicated verdict. */
export const MIN_EVIDENCE = 10;

export interface AdaptiveFixtureInput {
	fixture: ReplayFixture;
	labels: LabelFile;
	/** Cached adjudication verdict for a candidate, if any. Read-only. */
	verdictFor?: (c: CandidateRecord) => AdjudicatedVerdict | undefined;
}

export interface RoundRun {
	before: CandidateRecord[];
	after: CandidateRecord[];
	removed: CandidateRecord[];
}

export type RoundRunner = (
	fixture: ReplayFixture,
	labels: LabelFile,
	round: Round,
) => RoundRun;

export interface AdaptiveRow {
	fixtureId: string;
	heldOut: boolean;
	rounds: number[];
	removedReal: number;
	removedRejected: number;
	removedUnjoined: number;
	realRemovals: { round: number; candidate: CandidateRecord }[];
	unjoined: { round: number; candidate: CandidateRecord }[];
	postedBefore: number[];
	postedAfter: number[];
	roundsToClean: { before: number | null; after: number | null };
}

export type AdaptiveGate = "pass" | "fail" | "inconclusive";

const reviewFromCandidates = (
	candidates: CandidateRecord[],
): { skill: string; review: ModelReview }[] => {
	const bySkill = new Map<string, CandidateRecord[]>();
	for (const c of candidates) {
		const skill = (c.skill ?? "unknown").replace(/\.md$/, "");
		bySkill.set(skill, [...(bySkill.get(skill) ?? []), c]);
	}
	const base = (c: CandidateRecord) => ({
		title: c.title,
		body: c.title,
		severity: (c.severity ?? "P2") as ModelFinding["severity"],
		category: "correctness" as ModelFinding["category"],
		confidence: 1,
		evidence: c.title,
		suppressible: true,
		relation: null,
	});
	return [...bySkill].map(([skill, list]) => ({
		skill,
		review: {
			event: "COMMENT",
			general_findings: list
				.filter((c) => c.path === null || c.line === null)
				.map(base),
			inline_comments: list
				.filter((c) => c.path !== null && c.line !== null)
				.map(
					(c): ModelInlineComment => ({
						...base(c),
						path: c.path as string,
						line: c.line as number,
						start_line: null,
						suggestion: null,
					}),
				),
		} as ModelReview,
	}));
};

/** Every candidate line counts as on-diff: saved traces carry no patch text. */
const filesFromCandidates = (candidates: CandidateRecord[]): PullFile[] => {
	const maxLine = new Map<string, number>();
	for (const c of candidates)
		if (c.path !== null && c.line !== null)
			maxLine.set(c.path, Math.max(maxLine.get(c.path) ?? 1, c.line));
	return [...maxLine].map(([filename, n]) => ({
		filename,
		status: "added",
		additions: n,
		deletions: 0,
		patch: `@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, () => "+x").join("\n")}`,
	}));
};

/** Runs the saved candidates of `round` through the posting filters without and with the adaptive step. */
export const traceRoundRunner: RoundRunner = (fixture, labels, round) => {
	const candidates = round.trace?.candidates ?? [];
	const common = {
		agentReviews: reviewFromCandidates(candidates),
		ledger: ledgerForRound(fixture, labels, round),
		files: filesFromCandidates(candidates),
	};
	const before = postFilterTrace({
		...common,
		tuning: { ...REVIEWER_TUNING, adaptiveLimits: false },
	});
	const after = postFilterTrace({
		...common,
		tuning: { ...REVIEWER_TUNING, adaptiveLimits: true },
		adaptive: adaptiveInputForRound(fixture, labels, round),
	});
	return {
		before: before.posted,
		after: after.posted,
		removed: after.adaptiveRemoved ?? [],
	};
};

const SEVERITIES = ["P0", "P1", "P2", "P3"];
const severityRank = (c: CandidateRecord): number => {
	const i = SEVERITIES.indexOf(c.severity ?? "");
	return i < 0 ? SEVERITIES.length : i;
};

const firstClean = (rounds: number[], posted: number[]): number | null => {
	const i = posted.findIndex((n) => n === 0);
	return i < 0 ? null : (rounds[i] as number);
};

type Side = "real" | "rejected" | "none";

function sideOf(
	cand: CandidateRecord,
	input: AdaptiveFixtureInput,
	claims: ReturnType<typeof labelledClaims>,
): Side {
	const kinds = new Set(
		claims
			.filter((c) => joinsClaim(cand, c))
			.map((c) => input.labels.labels.find((l) => l.claimId === c.id)?.label),
	);
	if (kinds.has("fixed")) return "real";
	if (kinds.has("rejected")) return "rejected";
	const verdict = input.verdictFor?.(cand);
	if (verdict === "real") return "real";
	if (verdict === "not-real") return "rejected";
	return "none";
}

function rowFor(input: AdaptiveFixtureInput, run: RoundRunner): AdaptiveRow {
	const { fixture, labels } = input;
	const claims = labelledClaims(fixture, labels);
	const row: AdaptiveRow = {
		fixtureId: fixtureId(fixture),
		heldOut: fixture.heldOut === true,
		rounds: [],
		removedReal: 0,
		removedRejected: 0,
		removedUnjoined: 0,
		realRemovals: [],
		unjoined: [],
		postedBefore: [],
		postedAfter: [],
		roundsToClean: { before: null, after: null },
	};
	const distinct = new Map<
		string,
		{ round: number; candidate: CandidateRecord }
	>();
	for (const round of fixture.rounds) {
		if (!round.trace) continue;
		const r = run(fixture, labels, round);
		row.rounds.push(round.index);
		row.postedBefore.push(r.before.length);
		row.postedAfter.push(r.after.length);
		for (const candidate of r.removed) {
			const key = candidateKey(candidate);
			const seen = distinct.get(key);
			if (!seen) distinct.set(key, { round: round.index, candidate });
			else if (severityRank(candidate) < severityRank(seen.candidate))
				seen.candidate = candidate;
		}
	}
	for (const entry of distinct.values()) {
		const side = sideOf(entry.candidate, input, claims);
		if (side === "real") {
			row.removedReal++;
			row.realRemovals.push(entry);
		} else if (side === "rejected") row.removedRejected++;
		else {
			row.removedUnjoined++;
			row.unjoined.push(entry);
		}
	}
	row.roundsToClean = {
		before: firstClean(row.rounds, row.postedBefore),
		after: firstClean(row.rounds, row.postedAfter),
	};
	return row;
}

const where = (c: CandidateRecord) =>
	c.path === null ? "general" : `${c.path}:${c.line ?? "?"}`;

const ctn = (n: number | null) => (n === null ? "never" : String(n));

function formatReport(rows: AdaptiveRow[], gate: AdaptiveGate): string {
	const sum = (pick: (r: AdaptiveRow) => number) =>
		rows.reduce((n, r) => n + pick(r), 0);
	const real = rows.flatMap((r) =>
		r.realRemovals.map((x) => ({ ...x, row: r })),
	);
	const heldOutReal = real.filter((x) => x.row.heldOut);
	const evidence = sum((r) => r.removedReal + r.removedRejected);
	const lines = [
		`adaptive limits (REVIEWER_TUNING.adaptiveLimits, off): gate ${gate.toUpperCase()}`,
		`  would remove ${sum((r) => r.removedReal)} labelled-real (confirmed or provisional \`fixed\`), ${sum((r) => r.removedRejected)} rejected, ${sum((r) => r.removedUnjoined)} unjoined (counted for neither side); ${evidence} of ${MIN_EVIDENCE} needed labelled or adjudicated`,
	];
	if (heldOutReal.length > 0) {
		lines.push(
			`  HELD-OUT REAL REMOVALS (${heldOutReal.length}), a gate failure once at least ${MIN_EVIDENCE} removals carry evidence:`,
		);
		for (const x of heldOutReal)
			lines.push(
				`    ${x.row.fixtureId} round ${x.round} ${x.candidate.severity ?? "?"} ${where(x.candidate)} ${x.candidate.title}`,
			);
	}
	if (real.length > 0) {
		lines.push("  removed labelled-real findings by severity:");
		for (const x of real)
			lines.push(
				`    ${x.candidate.severity ?? "?"} ${x.row.fixtureId} round ${x.round} ${where(x.candidate)} ${x.candidate.title}`,
			);
	}
	for (const r of rows)
		lines.push(
			`  ${r.fixtureId}: ${r.removedReal} real, ${r.removedRejected} rejected, ${r.removedUnjoined} unjoined; posted before [${r.postedBefore.join(",")}] after [${r.postedAfter.join(",")}]; rounds to clean ${ctn(r.roundsToClean.before)} before, ${ctn(r.roundsToClean.after)} after`,
		);
	lines.push(
		"  counts are over distinct removed findings per fixture (path, line, title), however many rounds removed them; severity shown is the highest seen",
		"  unadjudicated and unclear items do not count for or against; labels are provisional",
		"  a label wins over an adjudicated verdict, and real wins over rejected when a candidate joins both",
		"  push-shape factor is not modeled, so the band budget is unscaled: removals are under-counted for small pushes",
		"  off-diff drops are not modeled, every candidate line is treated as on the diff: this slightly enlarges the pool the limits see, so removals can be over-counted",
		"  candidate confidence is not recorded in traces and is set to 1 for every reconstructed candidate, so ties among equal-severity candidates are broken by agent support and input order",
		"  rounds to clean is the index of the first traced round that posts nothing",
	);
	return lines.join("\n");
}

/**
 * Replays each traced round with the adaptive limits off and on and reports what they remove against labels and adjudicated verdicts.
 * Gate: inconclusive under 10 labelled or adjudicated removals, then fail on a confirmed-real removal from a held-out fixture, else pass.
 */
export function adaptiveReport(
	fixtures: AdaptiveFixtureInput[],
	run: RoundRunner = traceRoundRunner,
): { perFixture: AdaptiveRow[]; gate: AdaptiveGate; text: string } {
	const perFixture = fixtures.map((f) => rowFor(f, run));
	const evidence = perFixture.reduce(
		(n, r) => n + r.removedReal + r.removedRejected,
		0,
	);
	const heldOutReal = perFixture.some((r) => r.heldOut && r.removedReal > 0);
	const gate: AdaptiveGate =
		evidence < MIN_EVIDENCE ? "inconclusive" : heldOutReal ? "fail" : "pass";
	return { perFixture, gate, text: formatReport(perFixture, gate) };
}
