export interface DecisionReply {
	author: string;
	createdAt: string;
	body: string;
	authorAssociation?: string;
	isBot?: boolean;
}

export interface ReplyDisposition {
	status: "deferred" | "rejected" | "fixed";
	reason: string;
	evidence: string[];
}

export const DEFERRED =
	/follow-?up|out of scope|separate pr|later pr|will address (this )?later|tracked in/i;
export const REJECTED =
	/\bintentional(ly)?\b|\bno change\b|\bby design\b|no defect|working as intended|won'?t fix|not a (bug|problem|issue)|\bkept (it |this )?as[- ]is\b|\balready done\b/i;
export const FIX_REF =
	/\bfixed in\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;

const PATTERNS: [ReplyDisposition["status"], RegExp][] = [
	["deferred", DEFERRED],
	["rejected", REJECTED],
	["fixed", FIX_REF],
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
