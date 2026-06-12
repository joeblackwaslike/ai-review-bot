import type { KvClient } from "./kv.js";
import type { FeedbackEvent, PostedCommentRecord, Verdict } from "./types.js";

const POLL_SET = "fb:poll";
const EVENTS_LIST = "fb:events";

function ref(provider: string, commentId: number): string {
	return `${provider}:${commentId}`;
}

function cmtKey(provider: string, commentId: number): string {
	return `fb:cmt:${provider}:${commentId}`;
}

function ttlSeconds(expiresAtMs: number, nowMs: number): number {
	return Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000));
}

export async function recordPostedComment(
	kv: KvClient,
	record: PostedCommentRecord,
	nowMs: number,
): Promise<void> {
	await kv.set(
		cmtKey(record.provider, record.commentId),
		JSON.stringify(record),
		ttlSeconds(record.expiresAtMs, nowMs),
	);
	await kv.zadd(
		POLL_SET,
		record.expiresAtMs,
		ref(record.provider, record.commentId),
	);
}

export async function listActiveComments(
	kv: KvClient,
	nowMs: number,
): Promise<PostedCommentRecord[]> {
	const refs = await kv.zrangebyscore(POLL_SET, nowMs, "+inf");
	const out: PostedCommentRecord[] = [];
	for (const r of refs) {
		const sep = r.indexOf(":");
		const provider = r.slice(0, sep);
		const commentId = Number(r.slice(sep + 1));
		const raw = await kv.get(cmtKey(provider, commentId));
		if (raw) out.push(JSON.parse(raw) as PostedCommentRecord);
	}
	return out;
}

export async function markPolled(
	kv: KvClient,
	record: PostedCommentRecord,
	lastSeenReactions: Record<string, Verdict>,
	nowMs: number,
): Promise<void> {
	const updated: PostedCommentRecord = { ...record, lastSeenReactions };
	await kv.set(
		cmtKey(record.provider, record.commentId),
		JSON.stringify(updated),
		ttlSeconds(record.expiresAtMs, nowMs),
	);
}

export async function appendFeedbackEvent(
	kv: KvClient,
	event: FeedbackEvent,
): Promise<void> {
	await kv.lpush(EVENTS_LIST, JSON.stringify(event));
}

/** Remove comments whose expiry is strictly before now (score < now). Returns count removed. */
export async function prune(kv: KvClient, nowMs: number): Promise<number> {
	const expired = await kv.zrangebyscore(POLL_SET, "-inf", `(${nowMs}`);
	for (const r of expired) {
		const sep = r.indexOf(":");
		await kv.del(cmtKey(r.slice(0, sep), Number(r.slice(sep + 1))));
	}
	return kv.zremrangebyscore(POLL_SET, "-inf", `(${nowMs}`);
}
