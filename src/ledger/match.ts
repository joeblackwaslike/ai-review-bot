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
	bodySimilarity: 0.25,
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

/** camelCase starting with two lowercase letters, snake_case or SCREAMING_CASE, or a $name. PascalCase (GitHub, TypeScript, OpenAI) and eBay-style names do not qualify. */
const CODE_SHAPED =
	/^[a-z]{2}[a-z0-9]*[A-Z]|[A-Za-z0-9]_[A-Za-z0-9]|^\$[A-Za-z_]/;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const PRODUCT_NAME = /\b[a-z][A-Z][a-z]+\b/g;
const TEST_GAP =
	/\b(?:no|missing|lacks?|without|never)\b[^.]{0,40}\b(?:tests?|test coverage)\b|\buntested\b|(?:\bnot|n't) (?:directly )?(?:cover(?:ed)?|tested|exercised)\b|\btest coverage\b|\bcovered by (?:\w+ )?tests?\b/i;

/** eBay and iPhone read as camelCase to claimIdentifiers; they are names, not code. */
const withoutProductNames = <T extends ClaimLike>(c: T): T => ({
	...c,
	title: c.title.replace(PRODUCT_NAME, (w) => w.toLowerCase()),
});

const isTestGap = (c: ClaimLike) => TEST_GAP.test(c.title);

/** Plain words in backticks are left out: in a body they are prose far more often than code. */
function codeIdentifiers(text: string): Set<string> {
	const ids = new Set<string>();
	for (const match of text.matchAll(IDENTIFIER)) {
		const word = match[0];
		if (word.length > 2 && CODE_SHAPED.test(word)) ids.add(word.toLowerCase());
	}
	return ids;
}

/** An identifier counts as one word, not one per underscore-separated part. */
const proseOf = (c: ClaimLike) =>
	fullText(c).replace(IDENTIFIER, (w) =>
		CODE_SHAPED.test(w) ? w.replace(/[_$]/g, "") : w,
	);

const similarity = (f: ClaimLike, e: LedgerEntry) =>
	jaccard(claimTokens(fullText(f)), claimTokens(fullText(e)));

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
	return similarity(f, e) >= BODY_MATCH.bodySimilarity;
}

const isCrossSurface = (f: ClaimLike, e: LedgerEntry) => !f.path !== !e.path;

/** One side inline, the other a general finding: the path gate would always reject it. */
function isCrossSurfaceTitleRepeat(f: ClaimLike, e: LedgerEntry): boolean {
	const unanchored = { path: null, line: null };
	return (
		isCrossSurface(f, e) &&
		isSameClaim({ ...f, ...unanchored }, { ...e, ...unanchored })
	);
}

function isCrossSurfaceIdentifierRepeat(f: ClaimLike, e: LedgerEntry): boolean {
	if (!isCrossSurface(f, e)) return false;
	const ids = codeIdentifiers(fullText(e));
	if (![...codeIdentifiers(fullText(f))].some((id) => ids.has(id)))
		return false;
	const tokensF = claimTokens(proseOf(f));
	const tokensE = claimTokens(proseOf(e));
	if (Math.min(tokensF.size, tokensE.size) < DEFAULT_CLAIM_MATCH.minTokens) {
		return false;
	}
	return overlap(tokensF, tokensE) >= BODY_MATCH.crossSurfaceOverlap;
}

type Rule = (f: ClaimLike, e: LedgerEntry) => boolean;

const tierRule =
	(options: ClaimMatchOptions): Rule =>
	(f, e) =>
		isSameClaim(f, e, options);

const isCrossSurfaceRepeat: Rule = (f, e) =>
	isCrossSurfaceTitleRepeat(f, e) || isCrossSurfaceIdentifierRepeat(f, e);

const RULES: Rule[] = [
	tierRule(DEFAULT_CLAIM_MATCH),
	tierRule(CROSS_ROUND_MATCH),
	isMovedFileRepeat,
	isBodyRepeat,
	isCrossSurfaceRepeat,
];

/** A wrongly suppressed P0 costs the most, so it gets only the title rules, and
 * a shared identifier does not lower the tier 1 bar. */
const P0_RULES: Rule[] = [
	tierRule({
		...DEFAULT_CLAIM_MATCH,
		identifierSimilarity: DEFAULT_CLAIM_MATCH.titleSimilarity,
	}),
	tierRule(CROSS_ROUND_MATCH),
	isMovedFileRepeat,
	isCrossSurfaceTitleRepeat,
];

/** The ledger entry the finding restates among those `pick` admits, or null. A
 * test-gap finding never matches a defect entry, a P0 finding uses P0_RULES, and
 * when several entries match at the first matching rule the most similar one wins
 * (ties: latest round, then lowest id). */
function findMatch(
	finding: ClaimLike,
	ledger: Ledger,
	pick: (e: LedgerEntry) => boolean,
): LedgerEntry | null {
	const f = withoutProductNames(finding);
	const candidates = ledger
		.filter((e) => pick(e) && isTestGap(e) === isTestGap(f))
		.map((entry) => ({ entry, e: withoutProductNames(entry) }));
	for (const rule of finding.severity === "P0" ? P0_RULES : RULES) {
		const hits = candidates.filter(({ e }) => rule(f, e));
		if (hits.length === 0) continue;
		const ranked = hits
			.map((hit) => ({ ...hit, score: similarity(f, hit.e) }))
			.sort(
				(a, b) =>
					b.score - a.score ||
					b.entry.round - a.entry.round ||
					(a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
			);
		return ranked[0].entry;
	}
	return null;
}

/** The settled entry the finding restates, or null. Open entries never match. */
export function findSettledMatch(
	finding: ClaimLike,
	ledger: Ledger,
): LedgerEntry | null {
	return findMatch(finding, ledger, isSettled);
}

/** The open entry the finding restates, or null. Settled entries never match. */
export function findOpenMatch(
	finding: ClaimLike,
	ledger: Ledger,
): LedgerEntry | null {
	return findMatch(finding, ledger, (e) => !isSettled(e));
}
