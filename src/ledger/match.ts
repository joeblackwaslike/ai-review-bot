import {
	type ClaimLike,
	type ClaimMatchOptions,
	claimIdentifiers,
	claimTokens,
	DEFAULT_CLAIM_MATCH,
	isSameClaim,
	jaccard,
} from "../claim-dedupe.js";
import { isSettled, type Ledger, type LedgerEntry } from "./types.js";

export const CROSS_ROUND_MATCH: ClaimMatchOptions = {
	lineWindow: Number.POSITIVE_INFINITY,
	titleSimilarity: 0.8,
	identifierSimilarity: 0.8,
	unanchoredSimilarity: 0.6,
	minTokens: 3,
};

/** Bars measured on the six replay fixtures; see the sprint 2 task 3 report. */
export const BODY_MATCH = {
	lineWindow: DEFAULT_CLAIM_MATCH.lineWindow,
	bodySimilarity: 0.19,
	crossSurfaceOverlap: 0.6,
};

const normalizeTitle = (title: string) => title.trim().toLowerCase();

const fullText = (c: ClaimLike) => (c.body ? `${c.title}\n${c.body}` : c.title);

function overlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const item of a) if (b.has(item)) shared += 1;
	return shared / Math.min(a.size, b.size);
}

const CODE_SHAPED = /[a-z]{2}[A-Z]|[A-Za-z]_[A-Za-z]|^\$/;

/** camelCase, snake_case and $-prefixed names. Plain words in backticks are left out: in a body they are prose far more often than code. */
function codeIdentifiers(text: string): Set<string> {
	const ids = new Set<string>();
	for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
		const word = match[0];
		if (word.length > 2 && CODE_SHAPED.test(word)) ids.add(word.toLowerCase());
	}
	return ids;
}

function isMovedFileRepeat(f: ClaimLike, e: LedgerEntry): boolean {
	if (!f.path || !e.path || f.path === e.path) return false;
	if (normalizeTitle(f.title) !== normalizeTitle(e.title)) return false;
	const ids = claimIdentifiers(e.title);
	return [...claimIdentifiers(f.title)].some((id) => ids.has(id));
}

function isBodyRepeat(f: ClaimLike, e: LedgerEntry): boolean {
	if (!f.body || !e.body || !f.path || f.path !== e.path) return false;
	if (f.line == null || e.line == null) return false;
	if (Math.abs(f.line - e.line) > BODY_MATCH.lineWindow) return false;
	const similarity = jaccard(
		claimTokens(fullText(f)),
		claimTokens(fullText(e)),
	);
	return similarity >= BODY_MATCH.bodySimilarity;
}

/** One side inline, the other a general finding: the path gate would always reject it. */
function isCrossSurfaceRepeat(f: ClaimLike, e: LedgerEntry): boolean {
	if (!f.path === !e.path) return false;
	const unanchored = { path: null, line: null };
	if (isSameClaim({ ...f, ...unanchored }, { ...e, ...unanchored }))
		return true;
	const ids = codeIdentifiers(fullText(e));
	if (![...codeIdentifiers(fullText(f))].some((id) => ids.has(id)))
		return false;
	const tokensF = claimTokens(fullText(f));
	const tokensE = claimTokens(fullText(e));
	if (Math.min(tokensF.size, tokensE.size) < DEFAULT_CLAIM_MATCH.minTokens) {
		return false;
	}
	return overlap(tokensF, tokensE) >= BODY_MATCH.crossSurfaceOverlap;
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
	const rules = [isMovedFileRepeat, isBodyRepeat, isCrossSurfaceRepeat];
	for (const rule of rules) {
		const hit = settled.find((e) => rule(f, e));
		if (hit) return hit;
	}
	return null;
}
