/** Collapsing several agents' restatements of one claim into a single finding.
 *
 * Every agent sees the same diff, so a real bug is often found by several of
 * them at once. The existing merge keys on exact `path:line`, which only catches
 * the case where two agents anchored to the identical line — and they rarely do.
 * Observed on #43: `body: f.title` was reported eight times across six adjacent
 * lines of one expression, the missing body column four times across four lines
 * of one SQL query, and a double-verification concern twelve times across two
 * statements. Each was one claim.
 *
 * The rule here is deliberately narrow: same file, nearby lines, and either a
 * shared code identifier or substantial word overlap. Two genuinely different
 * bugs in one file survive it — they name different things. */

import type { Severity } from "./review.js";

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"not",
	"but",
	"with",
	"this",
	"that",
	"then",
	"than",
	"from",
	"into",
	"when",
	"will",
	"would",
	"should",
	"could",
	"can",
	"may",
	"are",
	"was",
	"were",
	"been",
	"being",
	"has",
	"have",
	"had",
	"its",
	"it",
	"instead",
	"rather",
	"still",
	"also",
	"only",
	"even",
	"does",
	"did",
	"doing",
	"which",
	"what",
	"where",
	"while",
	"because",
	"since",
	"here",
	"there",
	"any",
	"all",
	"some",
	"one",
	"two",
	"use",
	"used",
	"uses",
	"using",
	"via",
]);

/** Crude suffix stripping so "duplicates"/"duplicating"/"duplicated" collapse.
 * Not linguistically correct and does not need to be — it only has to make two
 * phrasings of the same claim compare equal more often than two different
 * claims do. */
function stem(word: string): string {
	let root = word;
	if (root.endsWith("ies") && root.length > 4) root = `${root.slice(0, -3)}y`;
	else if (root.endsWith("ing") && root.length > 5) root = root.slice(0, -3);
	else if (root.endsWith("ed") && root.length > 4) root = root.slice(0, -2);
	else if (root.endsWith("s") && !root.endsWith("ss") && root.length > 3) {
		root = root.slice(0, -1);
	}
	// Trailing "e" last, so duplicate/duplicates/duplicating all land on the
	// same root rather than three near-misses.
	if (root.endsWith("e") && root.length > 4) root = root.slice(0, -1);
	return root;
}

/** Content words of a title, with code spans removed — those are compared
 * separately and would otherwise dominate the overlap score. */
export function claimTokens(title: string): Set<string> {
	const tokens = title
		.toLowerCase()
		.replace(/`[^`]*`/g, " ")
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 2 && !STOPWORDS.has(word))
		.map(stem);
	return new Set(tokens);
}

/** Code identifiers a title names, from backticked spans. Two findings that
 * both name `listFindingsForPr` are talking about the same thing far more
 * reliably than two that merely share adjectives. */
export function claimIdentifiers(title: string): Set<string> {
	const identifiers = new Set<string>();
	const add = (raw: string) => {
		for (const part of raw.split(/[^A-Za-z0-9_$]+/)) {
			if (part.length > 2) identifiers.add(part.toLowerCase());
		}
	};

	for (const match of title.matchAll(/`([^`]+)`/g)) add(match[1]);
	// Reviewers backtick inconsistently — the same claim arrives as `f.title`
	// once and as bare f.title the next time. Dotted paths and camelCase read as
	// code either way, and missing them was enough to split one claim in two.
	for (const match of title.matchAll(
		/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+/g,
	)) {
		add(match[0]);
	}
	for (const match of title.matchAll(
		/\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g,
	)) {
		add(match[0]);
	}
	return identifiers;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const item of a) if (b.has(item)) shared += 1;
	return shared / (a.size + b.size - shared);
}

export interface ClaimLike {
	/** Absent on a general finding, which has no anchor at all. */
	path?: string | null;
	line?: number | null;
	title: string;
	severity?: string | null;
}

export interface ClaimMatchOptions {
	/** How far apart two anchors can be and still be the same claim. Sized for
	 * "several lines of one expression", not "same function". */
	lineWindow: number;
	/** Word overlap required when the two titles name no identifier in common. */
	titleSimilarity: number;
	/** Lower bar when they do — a shared identifier is the stronger signal. */
	identifierSimilarity: number;
	/** Bar for two findings with no anchor at all. Higher than the anchored case
	 * because "same file, nearby lines" is doing none of the work: every general
	 * finding compares against every other, so only the wording separates two
	 * unrelated repo-wide concerns. */
	unanchoredSimilarity: number;
	/** Titles with fewer content words than this are not compared at all. Two
	 * two-word titles sharing one word score a perfect 1.0, which says nothing
	 * about whether they are the same claim. */
	minTokens: number;
}

export const DEFAULT_CLAIM_MATCH: ClaimMatchOptions = {
	lineWindow: 30,
	titleSimilarity: 0.5,
	identifierSimilarity: 0.25,
	unanchoredSimilarity: 0.6,
	minTokens: 3,
};

/** Whether two findings are restatements of one claim.
 *
 * Requires the same file unconditionally: the same wording about two different
 * files is two findings, and merging them would silently drop one. */
export function isSameClaim(
	a: ClaimLike,
	b: ClaimLike,
	options: ClaimMatchOptions = DEFAULT_CLAIM_MATCH,
): boolean {
	if ((a.path ?? "") !== (b.path ?? "")) return false;

	const lineA = a.line ?? null;
	const lineB = b.line ?? null;
	const bothAnchored = lineA !== null && lineB !== null;
	if (bothAnchored && Math.abs(lineA - lineB) > options.lineWindow)
		return false;
	// Exactly one anchored: proximity cannot vouch for them, so they fall back to
	// the unanchored bar rather than silently skipping the distance check.
	const anchored = bothAnchored && Boolean(a.path);

	const tokensA = claimTokens(a.title);
	const tokensB = claimTokens(b.title);
	if (tokensA.size < options.minTokens || tokensB.size < options.minTokens) {
		return false;
	}

	const identifiersA = claimIdentifiers(a.title);
	const identifiersB = claimIdentifiers(b.title);
	const sharesIdentifier = [...identifiersA].some((id) => identifiersB.has(id));

	const similarity = jaccard(tokensA, tokensB);
	if (!anchored) return similarity >= options.unanchoredSimilarity;
	return sharesIdentifier
		? similarity >= options.identifierSimilarity
		: similarity >= options.titleSimilarity;
}

// Keyed on the shared severity scale so a typo is a compile error rather than a
// silent rank of 0, which would make a high-severity member lose its cluster.
const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

function severityRank(severity: string | null | undefined): number {
	return severity && severity in SEVERITY_RANK
		? SEVERITY_RANK[severity as Severity]
		: 0;
}

/** The representative of a cluster: most severe first, then the longest body —
 * the version that actually explains the problem rather than restating it. */
function preferred<T extends ClaimLike & { body?: string }>(a: T, b: T): T {
	const rankA = severityRank(a.severity);
	const rankB = severityRank(b.severity);
	if (rankA !== rankB) return rankA > rankB ? a : b;
	return (b.body?.length ?? 0) > (a.body?.length ?? 0) ? b : a;
}

export interface DedupeResult<T> {
	kept: T[];
	/** Count per surviving finding, so the caller can report what it collapsed
	 * rather than silently shrinking the review. */
	collapsed: number;
	/** Each collapsed finding paired with the survivor now representing it.
	 *
	 * Callers that recorded anything against a finding's own anchor — provenance,
	 * in particular — have to move it: collapsing deliberately spans different
	 * nearby lines, so the survivor's key is not the collapsed finding's key and
	 * whatever was filed under the latter is otherwise orphaned. */
	merges: Array<{ from: T; into: T }>;
}

/** Collapse restatements, keeping input order of the survivors.
 *
 * Greedy and O(n²), which is correct at this scale — a review carries tens of
 * findings, not thousands — and keeps the result independent of sort order in a
 * way clustering by centroid would not. */
export function dedupeClaims<T extends ClaimLike & { body?: string }>(
	findings: readonly T[],
	options: ClaimMatchOptions = DEFAULT_CLAIM_MATCH,
): DedupeResult<T> {
	const kept: T[] = [];
	const members: T[][] = [];

	for (const finding of findings) {
		const index = kept.findIndex((existing) =>
			isSameClaim(existing, finding, options),
		);
		if (index === -1) {
			kept.push(finding);
			members.push([finding]);
			continue;
		}
		members[index].push(finding);
		// The representative can change as a cluster grows, so which member was
		// absorbed is only knowable once every finding has been placed.
		kept[index] = preferred(kept[index], finding);
	}

	const merges: Array<{ from: T; into: T }> = [];
	members.forEach((group, index) => {
		for (const member of group) {
			if (member !== kept[index])
				merges.push({ from: member, into: kept[index] });
		}
	});

	return { kept, collapsed: merges.length, merges };
}
