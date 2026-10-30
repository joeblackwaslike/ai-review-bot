export interface RetractionCandidate {
	title: string;
	body: string;
}

interface PhraseFamily {
	name: string;
	pattern: RegExp;
	lastSentenceOnly?: boolean;
}

const PHRASE_FAMILIES: PhraseFamily[] = [
	{
		name: "no-actionable-defect",
		pattern:
			/\bno (?:(?:actionable|functional|actual|real|material|substantive) (?:defects?|bugs?|issues?|problems?|findings?|concerns?)|(?:issues?|defects?|bugs?|problems?) (?:found|here|identified))\b/i,
	},
	{
		name: "not-a-bug",
		pattern:
			/\bnot (?:(?:itself |really |actually )?an? (?:bug|defect|issue|problem)|flagging (?:this )?as an? (?:defect|bug|issue))\b/i,
	},
	{ name: "retracted", pattern: /\b(?:retracted|withdrawn)\W*$/i },
	{
		name: "looks-consistent-or-resolved",
		pattern:
			/\b(?:this|it|that) (?:now )?(?:looks|appears|seems) (?:internally )?(?:consistent|resolved|addressed)\b/i,
		lastSentenceOnly: true,
	},
	{
		name: "no-new-findings",
		pattern:
			/\bno (?:new|additional|further) (?:[\w-]+ ){0,3}(?:findings?|issues?|concerns?|problems?)\b/i,
	},
	{
		name: "covered-by-prior",
		pattern:
			/\balready (?:\w+ )?covered by (?:the )?(?:prior|previous|earlier)\b/i,
	},
	{
		name: "nothing-this-round",
		pattern:
			/\bno (?:[\w-]+ ){0,2}(?:changes?|tests?) (?:this round|applicable)\b/i,
	},
];

const CONTRAST = /\b(?:but|however|although|though|unless|except|whereas)\b/i;

function normalize(s: string): string {
	return s
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/[*_]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function tailSentences(s: string, count: number): string[] {
	return s
		.split(/(?<=[.!?])\s+/)
		.filter(Boolean)
		.slice(-count);
}

function familiesInTail(text: string): string[] {
	const tail = tailSentences(text, 2);
	const last = tail[tail.length - 1];
	const window = tail.join(" ");
	return PHRASE_FAMILIES.filter(({ pattern, lastSentenceOnly }) => {
		const scope = lastSentenceOnly ? last : window;
		const match = scope ? pattern.exec(scope) : null;
		if (!match) return false;
		return !CONTRAST.test(scope.slice(match.index + match[0].length));
	}).map((f) => f.name);
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
