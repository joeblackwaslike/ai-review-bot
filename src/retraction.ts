export interface RetractionCandidate {
	title: string;
	body: string;
}

export interface DroppableFinding extends RetractionCandidate {
	severity?: string;
	suppressible?: boolean;
}

interface PhraseFamily {
	name: string;
	pattern: RegExp;
	wholeFindingOnly?: boolean;
}

/**
 * Every pattern is end-anchored (optionally through a trailing `.`): a family
 * matches only when the retraction phrase is the end of the unit, with
 * nothing actionable trailing it. This makes qualifier tails (exceptions,
 * conditions, scope, elsewhere/outside) structurally impossible to match
 * instead of requiring a dedicated guard per qualifier shape.
 */
const PHRASE_FAMILIES: PhraseFamily[] = [
	{
		name: "no-actionable-defect",
		pattern:
			/\bno (?:actionable (?:defects?|bugs?|issues?|problems?|findings?)(?:\s+(?:found\s+here|found|here|identified))?|(?:issues?|defects?|bugs?|problems?)\s+(?:found\s+here|found|here|identified))\.?$/i,
	},
	{
		name: "not-flagging",
		pattern: /\bnot flagging (?:this )?as an? (?:defect|bug|issue)\.?$/i,
	},
	{
		name: "not-a-finding",
		pattern: /\b(?:this|it) is not a finding\.?$/i,
	},
	{ name: "retracted", pattern: /(?:^|[.;:]\s*)(?:retracted|withdrawn)\.?$/i },
	{
		name: "withdrawing",
		pattern:
			/\bwithdrawing (?:this|my) (?:observation|finding|comment|concern|note)\.?$/i,
	},
	{
		name: "looks-consistent-or-resolved",
		pattern:
			/\b(?:this|it|that) (?:now )?(?:looks|appears|seems) (?:internally )?(?:consistent|resolved|addressed)\.?$/i,
	},
	{
		name: "no-new-findings",
		pattern:
			/\bno (?:new|additional|further) (?:[\w-]+ ){0,3}(?:findings?|issues?|concerns?|problems?)(?:\s+beyond (?:the )?(?:prior|previous|earlier)(?:\s+reviews?)?)?\.?$/i,
		wholeFindingOnly: true,
	},
	{
		name: "covered-by-prior",
		pattern:
			/\balready (?:\w+ )?covered by (?:the )?(?:prior|previous|earlier)(?:\s+review(?:s|ers)?)?\.?$/i,
		wholeFindingOnly: true,
	},
	{
		name: "nothing-this-round",
		pattern:
			/\bno (?:[\w-]+ ){0,2}(?:changes?|tests?)\s+(?:this round|applicable)\.?$/i,
		wholeFindingOnly: true,
	},
];

const NEGATES_PHRASE =
	/\b(?:not|never|cannot|can't|unsure|may|however|although|though|otherwise|but|yet|while)\b|n't\b/i;

const COORDINATING_CONJUNCTION = /^(?:so|and|but|yet|or|however|therefore)\b/i;

/** A clause this short ("No actionable defect", "Documentation-only change")
 * reads as a label, not a competing claim, so it is allowed ahead of a
 * retraction phrase. A clause at or past this length ("The access token is
 * logged in plaintext") states its own fact and must not be swallowed by a
 * retraction phrase that follows it. */
const MAX_TRIVIAL_PREFIX_WORDS = 3;

function countWords(s: string): number {
	return s.split(/[\s,;:.]+/).filter(Boolean).length;
}

/** Decides whether the text preceding a matched retraction phrase, within
 * the same unit, lets that match stand. A comma followed by a coordinating
 * conjunction ("...emits, so this looks consistent.") only hands off to a
 * new independent clause, so only that trailing clause is checked for
 * negation. A semicolon/colon splits two independent clauses outright, so
 * the clause before it must itself be a short label, not a competing claim.
 * With neither, the whole prefix is one clause: for a `wholeFindingOnly`
 * family it IS the finding's own summary (the `all.length === 1` gate
 * already guarantees nothing else exists alongside it), so only negation is
 * checked; otherwise it could still be an unrelated claim the finding
 * started with, so it also gets the word-count check. */
function prefixAllowsMatch(before: string, wholeFindingOnly: boolean): boolean {
	if (!before.trim()) return true;

	let softBoundaryEnd = -1;
	const commaRe = /,\s*/g;
	for (let m = commaRe.exec(before); m; m = commaRe.exec(before)) {
		const rest = before.slice(m.index + m[0].length);
		if (COORDINATING_CONJUNCTION.test(rest)) {
			softBoundaryEnd = m.index + m[0].length;
		}
	}
	if (softBoundaryEnd >= 0) {
		return !NEGATES_PHRASE.test(before.slice(softBoundaryEnd));
	}

	const hardIdx = Math.max(before.lastIndexOf(";"), before.lastIndexOf(":"));
	if (hardIdx >= 0) {
		const preClause = before.slice(0, hardIdx);
		const postClause = before.slice(hardIdx + 1);
		if (NEGATES_PHRASE.test(postClause) || NEGATES_PHRASE.test(preClause))
			return false;
		return countWords(preClause) <= MAX_TRIVIAL_PREFIX_WORDS;
	}

	if (NEGATES_PHRASE.test(before)) return false;
	return wholeFindingOnly || countWords(before) <= MAX_TRIVIAL_PREFIX_WORDS;
}

const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/;

function units(s: string): string[] {
	return s
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/"[^"\n]*"/g, " ")
		.replace(/\u201c[^\u201d\n]*\u201d/g, " ")
		.replace(/(?<![a-zA-Z])'[^'\n]*'(?![a-zA-Z])/g, " ")
		.split("\n")
		.map((line) =>
			line
				.replace(LIST_MARKER, "")
				.replace(/[*_]+/g, "")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter(Boolean)
		.flatMap((line) => line.split(/(?<=[.!?])\s+/));
}

function familiesInLastUnit(text: string): string[] {
	const all = units(text);
	const last = all[all.length - 1];
	if (!last) return [];
	return PHRASE_FAMILIES.filter((family) => {
		if (family.wholeFindingOnly && all.length !== 1) return false;
		const match = family.pattern.exec(last);
		if (!match) return false;
		return prefixAllowsMatch(
			last.slice(0, match.index),
			family.wholeFindingOnly ?? false,
		);
	}).map((f) => f.name);
}

export function retractionFamilies(f: RetractionCandidate): string[] {
	const bodyFamilies = familiesInLastUnit(f.body ?? "");
	const titleFamilies = familiesInLastUnit(f.title ?? "");
	const bodyIsEmpty = !(f.body ?? "").trim();
	const titleFamiliesAllowed =
		bodyIsEmpty || bodyFamilies.length > 0 ? titleFamilies : [];
	return [...new Set([...bodyFamilies, ...titleFamiliesAllowed])];
}

/** Labels findings whose own title or closing sentence says nothing is wrong.
 * The replay classifier uses it unfiltered; the posting path only acts on
 * `candidateFamilies`, which adds the severity and suppressible guards. */
export function isRetractionCandidate(f: RetractionCandidate): boolean {
	return retractionFamilies(f).length > 0;
}

/** The families that would match a finding the rule is allowed to consider:
 * P2 and P3 only, and never one marked not suppressible. */
export function candidateFamilies(f: DroppableFinding): string[] {
	if (f.severity !== "P2" && f.severity !== "P3") return [];
	if (f.suppressible === false) return [];
	return retractionFamilies(f);
}

const keepsFinding = (f: DroppableFinding) => candidateFamilies(f).length === 0;

/** Removes strict retraction filler from a review: P2 and P3 findings that are
 * suppressible and whose own title or closing sentence says nothing is wrong.
 * REQUEST_CHANGES becomes COMMENT only when this removed every finding. */
export function dropRetractions<
	R extends {
		event: string;
		general_findings: DroppableFinding[];
		inline_comments: DroppableFinding[];
	},
>(review: R): { review: R; dropped: DroppableFinding[] } {
	const general = review.general_findings.filter(keepsFinding);
	const inline = review.inline_comments.filter(keepsFinding);
	const hadFindings =
		review.general_findings.length + review.inline_comments.length > 0;
	const hasFindings = general.length + inline.length > 0;
	const event =
		review.event === "REQUEST_CHANGES" && hadFindings && !hasFindings
			? "COMMENT"
			: review.event;
	return {
		review: {
			...review,
			event,
			general_findings: general,
			inline_comments: inline,
		},
		dropped: [
			...review.general_findings.filter((f) => !keepsFinding(f)),
			...review.inline_comments.filter((f) => !keepsFinding(f)),
		],
	};
}
