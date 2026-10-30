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
	maxWordsAfter?: number;
}

const NO_ACTIONABLE_AFTER_WORDS = 4;

const PHRASE_FAMILIES: PhraseFamily[] = [
	{
		name: "no-actionable-defect",
		pattern:
			/\bno (?:actionable (?:defects?|bugs?|issues?|problems?|findings?)|(?:issues?|defects?|bugs?|problems?) (?:found|here|identified))\b/i,
		maxWordsAfter: NO_ACTIONABLE_AFTER_WORDS,
	},
	{
		name: "not-flagging",
		pattern: /\bnot flagging (?:this )?as an? (?:defect|bug|issue)\b/i,
	},
	{
		name: "not-a-finding",
		pattern: /\b(?:this|it) is not a finding\b/i,
	},
	{ name: "retracted", pattern: /(?:^|[.;:]\s*)(?:retracted|withdrawn)\W*$/i },
	{
		name: "withdrawing",
		pattern:
			/\bwithdrawing (?:this|my) (?:observation|finding|comment|concern|note)\b/i,
	},
	{
		name: "looks-consistent-or-resolved",
		pattern:
			/\b(?:this|it|that) (?:now )?(?:looks|appears|seems) (?:internally )?(?:consistent|resolved|addressed)\b(?!\s+with\b)/i,
	},
	{
		name: "no-new-findings",
		pattern:
			/^no (?:new|additional|further) (?:[\w-]+ ){0,3}(?:findings?|issues?|concerns?|problems?)(?:\s+beyond (?:the )?(?:prior|previous|earlier)\b[^.]*)?\W*$|(?:^|[;:,—–]\s)no (?:new|additional|further) (?:[\w-]+ ){0,3}(?:findings?|issues?|concerns?|problems?)\s+beyond (?:the )?(?:prior|previous|earlier)\b/i,
		wholeFindingOnly: true,
	},
	{
		name: "covered-by-prior",
		pattern:
			/\balready (?:\w+ )?covered by (?:the )?(?:prior|previous|earlier)\b/i,
		wholeFindingOnly: true,
	},
	{
		name: "nothing-this-round",
		pattern:
			/(?:^|[;:,—–]\s)no (?:[\w-]+ ){0,2}(?:changes?|tests?) (?:this round|applicable)\b/i,
		wholeFindingOnly: true,
	},
];

const EXCEPTION_FOLLOWS =
	/^[\s,;:—–-]*(?:(?:found|identified|here|detected)[\s,;:—–-]+)?(?:beyond|other than|apart from|aside from|except)\b/i;

const CONTRAST =
	/\b(?:but|however|although|though|unless|except|whereas|yet|while|otherwise)\b/i;

const SCOPE_FOLLOWS =
	/^[\s,]*(?:(?:found|identified|detected|here)[\s,]+)?(?:in|by|with|for|from|during|on|within|under|at|across|inside|via|after|before|when|if|as|per|of|using|through|among)\b/i;

const KEEP_AFTER_PHRASE = new RegExp(
	`${CONTRAST.source}|\\b(?:apart from|other than|aside from)\\b|\\b(?:consider|should)\\b|\\b(?:just|only) (?:confirm|verify|check|make sure)\\b|\\bwould be (?:clearer|better|safer)\\b|\\bsuggest`,
	"i",
);

const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/;

function units(s: string): string[] {
	return s
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/"[^"\n]*"/g, " ")
		.replace(/\u201c[^\u201d\n]*\u201d/g, " ")
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

const wordCount = (s: string) => (s.match(/\b\w+\b/g) ?? []).length;

function familiesInLastUnit(text: string): string[] {
	const all = units(text);
	const last = all[all.length - 1];
	if (!last) return [];
	return PHRASE_FAMILIES.filter((family) => {
		if (family.wholeFindingOnly && all.length !== 1) return false;
		const match = family.pattern.exec(last);
		if (!match) return false;
		const rest = last.slice(match.index + match[0].length);
		if (CONTRAST.test(last.slice(0, match.index))) return false;
		if (EXCEPTION_FOLLOWS.test(rest)) return false;
		const opensTheWholeFinding = all.length === 1 && match.index === 0;
		if (!opensTheWholeFinding && SCOPE_FOLLOWS.test(rest)) return false;
		if (
			family.maxWordsAfter !== undefined &&
			!opensTheWholeFinding &&
			wordCount(rest) > family.maxWordsAfter
		)
			return false;
		return !KEEP_AFTER_PHRASE.test(rest);
	}).map((f) => f.name);
}

export function retractionFamilies(f: RetractionCandidate): string[] {
	return [
		...new Set([f.title, f.body].flatMap((s) => familiesInLastUnit(s ?? ""))),
	];
}

/** Measurement rule, not used in production. It labels findings whose own
 * title or closing sentence says nothing is wrong, for the replay classifier
 * and the filter-margin report. Reviewers kept finding real findings it would
 * drop, so it is not wired into the merge. */
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
