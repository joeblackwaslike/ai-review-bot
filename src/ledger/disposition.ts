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
	/follow-?up|out of scope|separate pr|later pr|will (address|fix) (this |it )?later|tracked in/i;
export const REJECTED =
	/\bintentional(ly)?\b|\bno change\b|\bby design\b|no defect|working as intended|won'?t fix|not a (bug|problem|issue)|\bkept (it |this )?as[- ]is\b|\balready done\b/i;
export const FIX_REF =
	/\bfixed in\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;

const AGREES =
	/\b(good catch|you'?re (absolutely |totally )?right|agreed|fair point|makes sense)\b/i;
const PROMISES_FIX =
	/(?<!\b(?:not|be|n't)\s)\b(will fix|i'?ll fix|fixing|will address|i'?ll address|on it)\b(?!\s+later)/i;

/** An agreeing reply that promises a fix but cites no commit. */
export const ACKNOWLEDGED = {
	test: (body: string) => AGREES.test(body) && PROMISES_FIX.test(body),
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
