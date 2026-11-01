import type { ClaimLike } from "../claim-dedupe.js";
import { recoverLocation } from "../review-state.js";
import { findOpenMatch, findSettledMatch } from "./match.js";
import { isSettled, type Ledger, type LedgerEntry } from "./types.js";

export interface Suppressed<T> {
	finding: T;
	entry: LedgerEntry;
}

export function suppressSettled<T extends ClaimLike>(
	findings: readonly T[],
	ledger: Ledger,
): { kept: T[]; suppressed: Suppressed<T>[] } {
	const kept: T[] = [];
	const suppressed: Suppressed<T>[] = [];
	for (const finding of findings) {
		const entry = findSettledMatch(finding, ledger);
		if (entry) suppressed.push({ finding, entry });
		else kept.push(finding);
	}
	return { kept, suppressed };
}

/** Drops findings that restate an open entry. Entries are matched, and returned,
 * with the location a `` (`path:line`) `` title suffix carries. */
export function suppressOpenRestatements<T extends ClaimLike>(
	findings: readonly T[],
	ledger: Ledger,
): { kept: T[]; suppressed: Suppressed<T>[] } {
	const open = ledger.filter((e) => !isSettled(e)).map(recoverLocation);
	const kept: T[] = [];
	const suppressed: Suppressed<T>[] = [];
	for (const finding of findings) {
		const entry = findOpenMatch(finding, open);
		if (entry) suppressed.push({ finding, entry });
		else kept.push(finding);
	}
	return { kept, suppressed };
}

const isBlockingSeverity = (s: string | null | undefined) =>
	s === "P0" || s === "P1";

/** A restated open entry holds the verdict the way a carried finding blocks it:
 * it is anchored to a path, or the entry or the restatement is P0/P1. */
function holdsVerdict(s: Suppressed<ClaimLike>): boolean {
	return (
		Boolean(s.entry.path) ||
		isBlockingSeverity(s.entry.severity) ||
		isBlockingSeverity(s.finding.severity)
	);
}

/** Returns a copy without settled repeats or restatements of open entries.
 * REQUEST_CHANGES becomes COMMENT only when that removed every finding and no
 * restated open entry holds the verdict. */
export function suppressInReview<
	R extends {
		event: string;
		general_findings: ClaimLike[];
		inline_comments: ClaimLike[];
	},
>(
	review: R,
	ledger: Ledger,
): {
	review: R;
	suppressed: Suppressed<ClaimLike>[];
	restatedOpen: Suppressed<ClaimLike>[];
} {
	const general = suppressSettled(review.general_findings, ledger);
	const inline = suppressSettled(review.inline_comments, ledger);
	const generalOpen = suppressOpenRestatements(general.kept, ledger);
	const inlineOpen = suppressOpenRestatements(inline.kept, ledger);
	const restatedOpen = [...generalOpen.suppressed, ...inlineOpen.suppressed];
	const hadFindings =
		review.general_findings.length + review.inline_comments.length > 0;
	const hasFindings = generalOpen.kept.length + inlineOpen.kept.length > 0;
	const event =
		review.event === "REQUEST_CHANGES" &&
		hadFindings &&
		!hasFindings &&
		!restatedOpen.some(holdsVerdict)
			? "COMMENT"
			: review.event;
	return {
		review: {
			...review,
			event,
			general_findings: generalOpen.kept,
			inline_comments: inlineOpen.kept,
		},
		suppressed: [...general.suppressed, ...inline.suppressed],
		restatedOpen,
	};
}
