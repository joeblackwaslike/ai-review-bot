import { isSameClaim } from "../claim-dedupe.js";
import { candidateFamilies } from "../retraction.js";
import type { PullFile } from "../review.js";
import { countJoined, labelledClaims } from "./metrics.js";
import type { ReviewStrategy, StrategyInput } from "./strategy.js";
import { ledgerForRound } from "./trace.js";
import type {
	CandidateRecord,
	LabelFile,
	ReplayFixture,
	Round,
	RoundTrace,
	RoundUsage,
} from "./types.js";

export interface LiveFinding {
	title: string;
	path: string | null;
	line: number | null;
	body?: string;
	severity?: string;
	suppressible?: boolean;
}

/** What one live review produced: findings, every agent candidate, what the
 * posting path would post from them, and per-skill usage. */
export interface LiveReviewOutput {
	findings: LiveFinding[];
	candidates: CandidateRecord[];
	posted: CandidateRecord[];
	usage: RoundUsage;
}

const ROUND_WALL_MS = 210_000;

export interface LiveRoundReport {
	index: number;
	matchedFixed: number;
	matchedRejected: number;
	newUnlabeled: number;
	raw: number;
	retracted: number;
	approximate: boolean;
	candidates: number;
	joined: number;
	posted: number;
	usage: RoundUsage;
	wallMs: number;
	toolCalls: number;
	trace: RoundTrace;
}

/** An estimate that is NaN, infinite or negative. The live tier refuses to run
 * rather than treat the round as free, since the round spends real money. */
export class InvalidEstimateError extends Error {}

export interface LiveReport {
	spentUsd: number;
	rounds: LiveRoundReport[];
}

/** A strategy run that threw, carrying the spend and rows of the rounds that finished. */
export class LiveRunError extends Error {
	constructor(
		message: string,
		readonly partial: LiveReport,
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

export interface LiveOptions {
	fixture: ReplayFixture;
	labels: LabelFile;
	rounds: number[];
	maxCostUsd: number;
	strategy: ReviewStrategy;
	fetchDiff: (
		round: Round,
	) => Promise<{ diff: string; files: PullFile[]; approximate: boolean }>;
	out?: (s: string) => void;
}

function confirmedClaimIds(labels: LabelFile): Set<string> {
	const ids = new Set<string>();
	for (const p of labels.repeatPairs) {
		if (!p.confirmed) continue;
		ids.add(p.later);
		ids.add(p.earlier);
	}
	return ids;
}

/**
 * Re-run the reviewer on recorded rounds. A live finding counts toward fixed or
 * rejected only when it restates a recorded claim that sits in a confirmed
 * repeat pair; everything else is new and unlabeled, with no accuracy claimed.
 */
export async function runLiveTier(opts: LiveOptions): Promise<LiveReport> {
	const out = opts.out ?? ((s: string) => console.log(s));
	const selected = opts.fixture.rounds.filter((r) =>
		opts.rounds.includes(r.index),
	);
	const diffs = await Promise.all(
		selected.map(async (r) => ({ round: r, ...(await opts.fetchDiff(r)) })),
	);
	const inputFor = (
		d: (typeof diffs)[number],
		maxUsd: number,
	): StrategyInput => ({
		fixture: opts.fixture,
		round: d.round,
		labels: opts.labels,
		diff: d.diff,
		files: d.files,
		approximateDiff: d.approximate,
		checkout: null,
		history: { ledger: ledgerForRound(opts.fixture, opts.labels, d.round) },
		budget: { maxUsd, maxWallMs: ROUND_WALL_MS },
		signal: new AbortController().signal,
	});
	const estimates = diffs.map((d) => {
		const e = opts.strategy.estimateCost(inputFor(d, opts.maxCostUsd));
		if (!Number.isFinite(e) || e < 0)
			throw new InvalidEstimateError(
				`round ${d.round.index}: invalid cost estimate ${e}`,
			);
		return e;
	});
	const total = estimates.reduce((a, b) => a + b, 0);
	out(
		`live: ${selected.length} round(s), estimated spend $${total.toFixed(2)} (cap $${opts.maxCostUsd.toFixed(2)})`,
	);

	const matchable = confirmedClaimIds(opts.labels);
	const labelOf = new Map(opts.labels.labels.map((l) => [l.claimId, l.label]));
	const labelled = labelledClaims(opts.fixture, opts.labels);
	const report: LiveReport = { spentUsd: 0, rounds: [] };

	for (const [i, d] of diffs.entries()) {
		const estimate = estimates[i] as number;
		if (report.spentUsd + estimate > opts.maxCostUsd) {
			out(
				`live: stopping before round ${d.round.index}; ${report.rounds.length} of ${diffs.length} rounds run (cap $${opts.maxCostUsd.toFixed(2)})`,
			);
			break;
		}
		let result: Awaited<ReturnType<ReviewStrategy["run"]>>;
		try {
			result = await opts.strategy.run(
				inputFor(d, opts.maxCostUsd - report.spentUsd),
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new LiveRunError(
				`${opts.strategy.name} round ${d.round.index}: ${message}`,
				report,
				{ cause: err },
			);
		}
		const { findings, candidates, posted, usage } = result;
		report.spentUsd += estimate;
		const counted = countJoined(candidates, labelled);
		const row: LiveRoundReport = {
			index: d.round.index,
			matchedFixed: 0,
			matchedRejected: 0,
			newUnlabeled: 0,
			raw: findings.length,
			retracted: findings.filter(
				(f) => candidateFamilies({ ...f, body: f.body ?? "" }).length > 0,
			).length,
			approximate: d.approximate,
			candidates: counted.candidates,
			joined: counted.joined,
			posted: posted.length,
			usage,
			wallMs: result.wallMs,
			toolCalls: result.toolCalls.length,
			trace: { candidates, posted, usage },
		};
		for (const f of findings) {
			const hit = d.round.claims.find(
				(c) => matchable.has(c.id) && isSameClaim(f, c),
			);
			const label = hit ? labelOf.get(hit.id) : undefined;
			if (label === "fixed") row.matchedFixed++;
			else if (label === "rejected") row.matchedRejected++;
			else row.newUnlabeled++;
		}
		report.rounds.push(row);
		out(
			`round ${row.index}${row.approximate ? " (approximate diff)" : ""}: ${row.matchedFixed} of ${findings.length} matched fixed, ${row.matchedRejected} of ${findings.length} matched rejected, ${row.newUnlabeled} new unlabeled (no accuracy claimed); ${row.raw} raw findings, ${row.retracted} candidate retractions; ${row.candidates} candidates, ${row.joined} joined to labelled claims, ${row.posted} would post`,
		);
		const usageLine = Object.entries(usage)
			.map(([s, u]) => `${s} ${u.promptTokens}+${u.completionTokens}`)
			.join(", ");
		if (usageLine) out(`  usage: ${usageLine}`);
	}
	return report;
}
