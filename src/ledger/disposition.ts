export interface DecisionReply {
	author: string;
	createdAt: string;
	body: string;
	authorAssociation?: string;
	isBot?: boolean;
}

export interface ReplyDisposition {
	status: "deferred" | "rejected" | "fixed" | "acknowledged";
	reason: string;
	evidence: string[];
}

export const DEFERRED =
	/follow[- ]?up|out of scope|separate pr|later pr|will (address|fix) (this |it )?later|tracked in/i;
export const REJECTED =
	/\bintentional(ly)?\b|\bno change\b|\bby design\b|no defect|working as intended|won'?t fix|not a (bug|problem|issue)|\bkept (it |this )?as[- ]is\b|\balready done\b/i;
export const FIX_REF =
	/\bfixed in\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;

const AGREES =
	/(?:^|[.!?\n]\s*)(?:good catch|you'?re (?:absolutely |totally )?right|agreed|makes sense|fair point|thanks for catching)\b/gi;
const PROMISES_FIX =
	/\b(?:will|i'?ll|i'?m going to|i am going to|going to|gonna|we'?ll)\s+(?:fix|address|handle|update|change|resolve|patch|take care of)\b(?!\s+later)/gi;
const NEGATED_BEFORE =
	/\b(?:don'?t|do not|won'?t|will not|not|never|wouldn'?t)\W+(?:\w+\W+){0,3}$/i;

/** An agreeing reply that promises a fix but cites no commit. The agreement
 * opens the reply or a sentence, the promise is forward-looking and not
 * negated, no "but" sits between them, and quoted lines are ignored. */
export const ACKNOWLEDGED = {
	test(body: string): boolean {
		const text = body
			.split("\n")
			.filter((l) => !l.trimStart().startsWith(">"))
			.join("\n");
		for (const agree of text.matchAll(AGREES)) {
			const rest = text.slice(agree.index + agree[0].length);
			for (const promise of rest.matchAll(PROMISES_FIX)) {
				const gap = rest.slice(0, promise.index);
				if (/\bbut\b/i.test(gap) || NEGATED_BEFORE.test(gap)) continue;
				return true;
			}
		}
		return false;
	},
};

const PATTERNS: [ReplyDisposition["status"], { test(s: string): boolean }][] = [
	["deferred", DEFERRED],
	["rejected", REJECTED],
	["fixed", FIX_REF],
	["acknowledged", ACKNOWLEDGED],
];

export function classifyReplies(
	replies: DecisionReply[],
	isDecider: (r: DecisionReply) => boolean,
): ReplyDisposition | null {
	const deciders = replies.filter(isDecider);
	for (const [status, re] of PATTERNS) {
		const hits = deciders.filter((r) => re.test(r.body));
		if (hits.length) {
			return {
				status,
				reason: hits[0].body,
				evidence: hits.map((r) => `${r.createdAt || "unknown"}|${r.body}`),
			};
		}
	}
	return null;
}
