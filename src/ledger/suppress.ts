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

/** Drops findings that restate an open entry, except one that blocks the
 * verdict where the entry would not. Entries are matched, and returned,
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
		const wouldLoseBlock =
			entry !== null &&
			blocksVerdict(finding) &&
			!holdsVerdict({ finding, entry });
		if (entry && !wouldLoseBlock) suppressed.push({ finding, entry });
		else kept.push(finding);
	}
	return { kept, suppressed };
}

const isBlockingSeverity = (s: string | null | undefined) =>
	s === "P0" || s === "P1";

/** Whether an open finding or entry blocks the verdict. One with a path has a
 * thread the author can settle, so it blocks at every severity; a path-less
 * (general) one has no thread, so only P0 and P1 decide. An advisory one
 * never blocks. */
export function blocksVerdict(f: {
	path?: string | null;
	severity?: string | null;
	advisory?: boolean;
}): boolean {
	return (!f.advisory && Boolean(f.path)) || isBlockingSeverity(f.severity);
}

/** A restated open entry holds the verdict if the entry blocks, or the
 * restatement is P0/P1. */
function holdsVerdict(s: Suppressed<ClaimLike>): boolean {
	return blocksVerdict(s.entry) || isBlockingSeverity(s.finding.severity);
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
