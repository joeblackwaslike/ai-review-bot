export interface FeedbackRow {
	id: number;
	commentId: number | null;
	inReplyToId: number | null;
	path: string | null;
	line: number | null;
}

export interface CatalogEntry {
	id: number;
	commentId: number | null;
	path: string | null;
	line: number | null;
}

export type MatchMethod = "thread" | "location" | "hint" | "none";

export interface MatchResult {
	findingId: number | null;
	method: MatchMethod;
}

/** Pure: attach a piece of feedback to the finding it concerns.
 *
 * Deterministic routes are tried before the model's guess, because a wrong
 * attribution is worse than none — it credits or blames a finding that was never
 * involved. GitHub sets `in_reply_to_id` to the thread's root comment, which for
 * our threads is the finding comment itself, so thread linkage is exact.
 * `path:line` is next-best but ambiguous when several findings share a location.
 * The classifier's hint is consulted last and only when it names a real row. */
export function matchToFinding(
	row: FeedbackRow,
	catalog: CatalogEntry[],
	hintFindingId?: number | null,
): MatchResult {
	const targetCommentId = row.inReplyToId ?? row.commentId;
	if (targetCommentId !== null) {
		const byThread = catalog.find((c) => c.commentId === targetCommentId);
		if (byThread) return { findingId: byThread.id, method: "thread" };
	}

	if (row.path !== null && row.line !== null) {
		const atLocation = catalog.filter(
			(c) => c.path === row.path && c.line === row.line,
		);
		// Exactly one finding at this location, or the location is shared and we
		// cannot tell which was meant — an ambiguous location is not a match.
		if (atLocation.length === 1) {
			return { findingId: atLocation[0].id, method: "location" };
		}
	}

	if (hintFindingId != null && catalog.some((c) => c.id === hintFindingId)) {
		return { findingId: hintFindingId, method: "hint" };
	}

	return { findingId: null, method: "none" };
}

/** Pure: collapse a finding into a signature that groups the same false positive
 * across different PRs and locations, so a recurring one can be counted rather
 * than re-litigated each time. Punctuation, digits, casing and quoted
 * identifiers are stripped because the same claim recurs with different symbol
 * names and line numbers. */
export function fpSignature(skills: string[], title: string): string {
	const normalized = title
		.toLowerCase()
		.replace(/`[^`]*`/g, " ")
		.replace(/[^a-z\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2)
		.sort()
		.join(" ");
	return `${[...skills].sort().join(",")}|${normalized}`;
}
