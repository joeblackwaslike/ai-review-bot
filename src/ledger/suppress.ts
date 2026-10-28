import type { ClaimLike } from "../claim-dedupe.js";
import { findSettledMatch } from "./match.js";
import type { Ledger, LedgerEntry } from "./types.js";

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

/** Returns a copy; REQUEST_CHANGES becomes COMMENT only when suppression removed every finding. */
export function suppressInReview<
	R extends {
		event: string;
		general_findings: ClaimLike[];
		inline_comments: ClaimLike[];
	},
>(
	review: R,
	ledger: Ledger,
): { review: R; suppressed: Suppressed<ClaimLike>[] } {
	const general = suppressSettled(review.general_findings, ledger);
	const inline = suppressSettled(review.inline_comments, ledger);
	const hadFindings =
		review.general_findings.length + review.inline_comments.length > 0;
	const hasFindings = general.kept.length + inline.kept.length > 0;
	const event =
		review.event === "REQUEST_CHANGES" && hadFindings && !hasFindings
			? "COMMENT"
			: review.event;
	return {
		review: {
			...review,
			event,
			general_findings: general.kept,
			inline_comments: inline.kept,
		},
		suppressed: [...general.suppressed, ...inline.suppressed],
	};
}
