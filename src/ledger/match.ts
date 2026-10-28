import {
	type ClaimLike,
	type ClaimMatchOptions,
	claimIdentifiers,
	DEFAULT_CLAIM_MATCH,
	isSameClaim,
} from "../claim-dedupe.js";
import { isSettled, type Ledger, type LedgerEntry } from "./types.js";

export const CROSS_ROUND_MATCH: ClaimMatchOptions = {
	lineWindow: Number.POSITIVE_INFINITY,
	titleSimilarity: 0.8,
	identifierSimilarity: 0.8,
	unanchoredSimilarity: 0.6,
	minTokens: 3,
};

const normalizeTitle = (title: string) => title.trim().toLowerCase();

function isMovedFileRepeat(f: ClaimLike, e: LedgerEntry): boolean {
	if (!f.path || !e.path || f.path === e.path) return false;
	if (normalizeTitle(f.title) !== normalizeTitle(e.title)) return false;
	const ids = claimIdentifiers(e.title);
	return [...claimIdentifiers(f.title)].some((id) => ids.has(id));
}

/** First settled entry the finding restates, or null. Open entries never match. */
export function findSettledMatch(
	f: ClaimLike,
	ledger: Ledger,
): LedgerEntry | null {
	const settled = ledger.filter(isSettled);
	const tiers = [DEFAULT_CLAIM_MATCH, CROSS_ROUND_MATCH];
	for (const options of tiers) {
		const hit = settled.find((e) => isSameClaim(f, e, options));
		if (hit) return hit;
	}
	return settled.find((e) => isMovedFileRepeat(f, e)) ?? null;
}
