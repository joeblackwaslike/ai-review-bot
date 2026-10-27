import type { LedgerView, ReplayPipeline } from "./pipeline.js";
import type { ClaimLabel, LabelFile, ReplayFixture, Round } from "./types.js";

const FALLBACK_LEAD_MS = 15 * 60 * 1000;

export interface ReplayResult {
	fixtureId: string;
	rounds: { index: number; posted: string[]; suppressed: string[] }[];
}

export function roundCutoff(round: Round): Date {
	if (round.triggerAt) return new Date(round.triggerAt);
	return new Date(new Date(round.submittedAt).getTime() - FALLBACK_LEAD_MS);
}

function isVisible(entry: string, cutoff: Date): boolean {
	const stamp = entry.slice(0, entry.indexOf("|"));
	if (stamp === "unknown") return false;
	const t = new Date(stamp).getTime();
	return !Number.isNaN(t) && t < cutoff.getTime();
}

export function visibleLabels(
	_f: ReplayFixture,
	labels: LabelFile,
	cutoff: Date,
): Map<string, ClaimLabel> {
	const out = new Map<string, ClaimLabel>();
	for (const label of labels.labels) {
		const evidence = label.evidence.filter((e) => isVisible(e, cutoff));
		if (evidence.length > 0) out.set(label.claimId, { ...label, evidence });
	}
	return out;
}

export function replayFixture(
	f: ReplayFixture,
	labels: LabelFile,
	pipeline: ReplayPipeline,
): ReplayResult {
	const rounds = f.rounds.map((round) => {
		const ledger: LedgerView = {
			priorClaims: f.rounds
				.filter((r) => r.index < round.index)
				.flatMap((r) => r.claims),
			labels: visibleLabels(f, labels, roundCutoff(round)),
		};
		const { posted, suppressed } = pipeline({
			round,
			claims: round.claims,
			ledger,
		});
		return { index: round.index, posted, suppressed };
	});
	return { fixtureId: labels.fixtureId, rounds };
}
