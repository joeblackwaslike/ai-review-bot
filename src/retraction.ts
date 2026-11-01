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
		const before = last.slice(0, match.index);
		const immediateClause = before.split(/[,;]/).pop() ?? "";
		return !NEGATES_PHRASE.test(immediateClause);
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
