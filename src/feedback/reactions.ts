import type { FeedbackEvent, PostedCommentRecord, Verdict } from "./types.js";

export interface RawReaction {
	login: string;
	content: string;
	createdAtMs: number;
}

interface VerdictChange {
	reactor: string;
	verdict: Verdict;
	reactedAtMs: number;
}

/** Pure: reduce current reactions to one verdict per reactor (latest +1/-1 wins), then diff
 * against the last-seen map. New/changed verdicts become changes; removals drop from the map
 * but emit no change. */
export function computeReactionDelta(
	current: RawReaction[],
	lastSeen: Record<string, Verdict>,
): { changes: VerdictChange[]; lastSeen: Record<string, Verdict> } {
	const latest = new Map<string, { verdict: Verdict; reactedAtMs: number }>();
	for (const r of current) {
		const verdict: Verdict | null =
			r.content === "+1" ? "up" : r.content === "-1" ? "down" : null;
		if (!verdict) continue;
		const prev = latest.get(r.login);
		if (!prev || r.createdAtMs > prev.reactedAtMs) {
			latest.set(r.login, { verdict, reactedAtMs: r.createdAtMs });
		}
	}

	const changes: VerdictChange[] = [];
	const nextLastSeen: Record<string, Verdict> = {};
	for (const [login, { verdict, reactedAtMs }] of latest) {
		nextLastSeen[login] = verdict;
		if (lastSeen[login] !== verdict)
			changes.push({ reactor: login, verdict, reactedAtMs });
	}
	return { changes, lastSeen: nextLastSeen };
}

interface OctokitLike {
	request: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<{ data: unknown }>;
}

interface RawReactionResponse {
	user: { login: string } | null;
	content: string;
	created_at: string;
}

/** Fetch a comment's reactions and return the new verdict events + the new last-seen map. */
export async function diffReactions(
	octokit: OctokitLike,
	record: PostedCommentRecord,
	nowMs: number,
): Promise<{ events: FeedbackEvent[]; lastSeen: Record<string, Verdict> }> {
	const res = await octokit.request(
		"GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
		{
			owner: record.owner,
			repo: record.repo,
			comment_id: record.commentId,
			per_page: 100,
		},
	);
	const raw: RawReaction[] = (res.data as RawReactionResponse[]).map((x) => {
		const ts = Date.parse(x.created_at);
		return {
			login: x.user?.login ?? "unknown",
			content: x.content,
			createdAtMs: Number.isFinite(ts) ? ts : nowMs,
		};
	});

	const { changes, lastSeen } = computeReactionDelta(
		raw,
		record.lastSeenReactions,
	);
	const events: FeedbackEvent[] = changes.map((c) => ({
		commentId: record.commentId,
		provider: record.provider,
		owner: record.owner,
		repo: record.repo,
		pr: record.pr,
		path: record.path,
		line: record.line,
		skills: record.skills,
		title: record.title,
		verdict: c.verdict,
		reactor: c.reactor,
		reactedAtMs: c.reactedAtMs,
		capturedAtMs: nowMs,
	}));
	return { events, lastSeen };
}
