import {
	suppressOpenRestatements,
	suppressSettled,
} from "../ledger/suppress.js";
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
}) => {
	posted: string[];
	suppressed: string[];
	/** Restatements of a prior claim that is still open. */
	held?: string[];
	/** Suppressed claim id to the id of the prior claim it was matched to. */
	matchedTo?: Record<string, string>;
};

export const asRecordedPipeline: ReplayPipeline = ({ claims }) => ({
	posted: claims.map((c) => c.id),
	suppressed: [],
});

const SETTLED_LABELS = new Set<string>(["fixed", "rejected", "deferred"]);

const evidenceText = (entry: string) => entry.slice(entry.indexOf("|") + 1);

/** Every prior claim as a ledger entry: settled when a visible high-confidence
 * label settles it, open otherwise, as an unanswered thread is. */
export function ledgerFromView(view: LedgerView): Ledger {
	return view.priorClaims.map((c): LedgerEntry => {
		const base = {
			id: c.id,
			round: c.roundIndex,
			path: c.path,
			line: c.line,
			severity: c.severity,
			title: c.title,
			body: c.text,
		};
		const label = view.labels.get(c.id);
		if (
			!label ||
			label.confidence !== "high" ||
			!SETTLED_LABELS.has(label.label)
		)
			return {
				...base,
				status: "open",
				decidedBy: null,
				reason: null,
				evidence: [],
			};
		const first = label.evidence[0];
		return {
			...base,
			status: label.label as LedgerStatus,
			decidedBy: "author",
			reason: first === undefined ? null : evidenceText(first),
			evidence: label.evidence,
		};
	});
}

export const todaysCodePipeline: ReplayPipeline = ({ claims, ledger }) => {
	const findings = claims.map((c) => ({ ...c, body: c.text }));
	const entries = ledgerFromView(ledger);
	const settled = suppressSettled(findings, entries);
	const open = suppressOpenRestatements(settled.kept, entries);
	const matched = [...settled.suppressed, ...open.suppressed];
	return {
		posted: open.kept.map((c) => c.id),
		suppressed: settled.suppressed.map((s) => s.finding.id),
		held: open.suppressed.map((s) => s.finding.id),
		matchedTo: Object.fromEntries(
			matched.map((s) => [s.finding.id, s.entry.id]),
		),
	};
};
