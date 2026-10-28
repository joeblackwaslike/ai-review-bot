import { suppressSettled } from "../ledger/suppress.js";
import type { Ledger, LedgerEntry, LedgerStatus } from "../ledger/types.js";
import type { ClaimLabel, PostedClaim, Round } from "./types.js";

export interface LedgerView {
	priorClaims: PostedClaim[];
	labels: Map<string, ClaimLabel>;
}

export type ReplayPipeline = (input: {
	round: Round;
	claims: PostedClaim[];
	ledger: LedgerView;
}) => { posted: string[]; suppressed: string[] };

export const asRecordedPipeline: ReplayPipeline = ({ claims }) => ({
	posted: claims.map((c) => c.id),
	suppressed: [],
});

const SETTLED_LABELS = new Set<string>(["fixed", "rejected", "deferred"]);

const evidenceText = (entry: string) => entry.slice(entry.indexOf("|") + 1);

export function ledgerFromView(view: LedgerView): Ledger {
	return view.priorClaims.flatMap((c): LedgerEntry[] => {
		const label = view.labels.get(c.id);
		if (!label || label.confidence !== "high") return [];
		if (!SETTLED_LABELS.has(label.label)) return [];
		const first = label.evidence[0];
		return [
			{
				id: c.id,
				round: c.roundIndex,
				path: c.path,
				line: c.line,
				severity: c.severity,
				title: c.title,
				body: c.text,
				status: label.label as LedgerStatus,
				decidedBy: "author",
				reason: first === undefined ? null : evidenceText(first),
				evidence: label.evidence,
			},
		];
	});
}

export const todaysCodePipeline: ReplayPipeline = ({ claims, ledger }) => {
	const findings = claims.map((c) => ({ ...c, body: c.text }));
	const { kept, suppressed } = suppressSettled(
		findings,
		ledgerFromView(ledger),
	);
	return {
		posted: kept.map((c) => c.id),
		suppressed: suppressed.map((s) => s.finding.id),
	};
};
