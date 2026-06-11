import type { KvClient } from "./kv.js";
import { diffReactions } from "./reactions.js";
import {
	appendFeedbackEvent,
	listActiveComments,
	markPolled,
	prune,
} from "./store.js";
import type { Provider } from "./types.js";

interface OctokitLike {
	request: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<{ data: unknown }>;
}

export interface PollDeps {
	kv: KvClient;
	getOctokit: (
		provider: Provider,
		installationId: number,
	) => Promise<OctokitLike>;
	nowMs: number;
}

/** One poll pass: for each active comment, fetch reactions, append new verdict events, persist
 * last-seen, then prune expired comments. Per-comment failures are logged and skipped. If
 * event-append partially fails for a comment, markPolled is skipped and its already-appended
 * events may duplicate on the next pass (accepted rare-failure tradeoff). */
export async function runFeedbackPoll(
	deps: PollDeps,
): Promise<{ polled: number; events: number; pruned: number }> {
	const { kv, getOctokit, nowMs } = deps;
	const records = await listActiveComments(kv, nowMs);
	let events = 0;

	for (const record of records) {
		try {
			const octokit = await getOctokit(record.provider, record.installationId);
			const { events: newEvents, lastSeen } = await diffReactions(
				octokit,
				record,
				nowMs,
			);
			for (const event of newEvents) {
				await appendFeedbackEvent(kv, event);
				events++;
			}
			await markPolled(kv, record, lastSeen, nowMs);
		} catch (err) {
			console.error("feedback poll: comment failed", {
				commentId: record.commentId,
				provider: record.provider,
				err,
			});
		}
	}

	const pruned = await prune(kv, nowMs);
	return { polled: records.length, events, pruned };
}
