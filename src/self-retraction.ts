export interface RetractionCandidate {
	title: string;
	body: string;
}

interface PhraseFamily {
	name: string;
	pattern: RegExp;
	lastSentenceOnly?: boolean;
	wholeFindingOnly?: boolean;
	keepIfExceptionFollows?: boolean;
}

const PHRASE_FAMILIES: PhraseFamily[] = [
	{
		name: "no-actionable-defect",
		pattern:
			/\bno (?:actionable (?:defects?|bugs?|issues?|problems?|findings?)|(?:issues?|defects?|bugs?|problems?) (?:found|here|identified))\b/i,
		keepIfExceptionFollows: true,
	},
	{
		name: "not-flagging",
		pattern: /\bnot flagging (?:this )?as an? (?:defect|bug|issue)\b/i,
	},
	{ name: "retracted", pattern: /\b(?:retracted|withdrawn)\W*$/i },
	{
		name: "withdrawing",
		pattern: /\bwithdraw(?:ing|n)? (?:this|my|the) /i,
	},
	{
		name: "looks-consistent-or-resolved",
		pattern:
			/\b(?:this|it|that) (?:now )?(?:looks|appears|seems) (?:internally )?(?:consistent|resolved|addressed)\b/i,
		lastSentenceOnly: true,
	},
	{
		name: "no-new-findings",
		pattern:
			/(?:^|[;:,\u2014\u2013]\s)no (?:new|additional|further) (?:[\w-]+ ){0,3}(?:findings?|issues?|concerns?|problems?)\b/i,
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
			/(?:^|[;:,\u2014\u2013]\s)no (?:[\w-]+ ){0,2}(?:changes?|tests?) (?:this round|applicable)\b/i,
		wholeFindingOnly: true,
	},
];

const EXCEPTION_FOLLOWS =
	/^\s*(?:(?:found|identified|here|detected)\s+)?(?:beyond|other than|apart from|aside from|except)\b/i;

const KEEP_AFTER_PHRASE =
	/\b(?:but|however|although|though|unless|except|whereas|consider|should)\b|\b(?:just|only) (?:confirm|verify|check|make sure)\b|\bwould be (?:clearer|better|safer)\b|\bsuggest/i;

function normalize(s: string): string {
	return s
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/[*_]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function familiesInTail(text: string): string[] {
	const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
	const tail = sentences.slice(-2);
	const last = tail[tail.length - 1];
	const window = tail.join(" ");
	return PHRASE_FAMILIES.filter(
		({
			pattern,
			lastSentenceOnly,
			wholeFindingOnly,
			keepIfExceptionFollows,
		}) => {
			if (wholeFindingOnly && sentences.length !== 1) return false;
			const scope = lastSentenceOnly ? last : window;
			const match = scope ? pattern.exec(scope) : null;
			if (!match) return false;
			const rest = scope.slice(match.index + match[0].length);
			if (keepIfExceptionFollows && EXCEPTION_FOLLOWS.test(rest)) return false;
			return !KEEP_AFTER_PHRASE.test(rest);
		},
	).map((f) => f.name);
}

export function retractionFamilies(f: RetractionCandidate): string[] {
	return [
		...new Set(
			[f.title, f.body].flatMap((s) => familiesInTail(normalize(s ?? ""))),
		),
	];
}

/** True when a finding's own title or closing sentences say nothing is wrong,
 * e.g. "No actionable defect found" or "this looks resolved by ...". Code
 * spans are ignored, and a contrast word after the phrase keeps the finding. */
export function isSelfRetracted(f: RetractionCandidate): boolean {
	return retractionFamilies(f).length > 0;
}
