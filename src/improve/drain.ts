import type { KvClient } from "../feedback/kv.js";
import type { FeedbackEvent } from "../feedback/types.js";
import type { Db } from "./db/client.js";
import { insertRawFeedback, type RawFeedbackInsert } from "./db/repo.js";

const EVENTS_LIST = "fb:events";

/** Pure: a KV feedback event as a corpus row. The dedup key matches the one the
 * backfill writes, so an event drained here and the same reaction harvested by a
 * backfill converge on a single row instead of double-counting. */
export function mapKvEventToRaw(event: FeedbackEvent): RawFeedbackInsert {
	// A reaction on the carrier rates the review as a whole; one on an inline
	// comment rates a single finding. Recording both as inline_reaction would
	// make a review-level verdict look like a verdict on whichever finding
	// happened to share its comment id space.
	const source =
		event.surface === "carrier" ? "review_reaction" : "inline_reaction";
	return {
		source,
		provider: event.provider,
		owner: event.owner,
		repo: event.repo,
		pr: event.pr,
		commentId: event.commentId,
		path: event.path,
		line: event.line,
		skills: event.skills,
		title: event.title,
		verdict: event.verdict,
		actor: event.reactor,
		eventAt: new Date(event.reactedAtMs),
		dedupKey: `react:${source}:${event.commentId}:${event.reactor}:${event.verdict}`,
	};
}

/** Pure: parse the KV list payload, discarding entries that are not events.
 * A malformed entry is skipped rather than aborting the drain — one bad write
 * must not strand every event behind it. */
export function parseEvents(raw: string[]): {
	events: FeedbackEvent[];
	malformed: number;
} {
	const events: FeedbackEvent[] = [];
	let malformed = 0;
	for (const entry of raw) {
		try {
			const parsed = JSON.parse(entry) as FeedbackEvent;
			if (
				typeof parsed?.commentId === "number" &&
				typeof parsed?.reactor === "string" &&
				typeof parsed?.verdict === "string"
			) {
				events.push(parsed);
			} else {
				malformed++;
			}
		} catch {
			malformed++;
		}
	}
	return { events, malformed };
}

/** Copy the KV event buffer into the corpus.
 *
 * Read-only against KV: the list is not trimmed here. Every write is keyed, so
 * re-draining the same events inserts nothing, and leaving the buffer intact
 * means a failure part-way through loses nothing. KV expiry is what bounds the
 * list, not this function. */
export async function drainKvEvents(deps: {
	kv: KvClient;
	db: Db;
	limit?: number;
}): Promise<{ read: number; inserted: number; malformed: number }> {
	// Redis treats a negative stop index as counting back from the end, so a
	// limit of 0 would become lrange(key, 0, -1) — the entire list, the exact
	// opposite of the intent. Clamp to at least one element.
	const limit = Math.max(1, Math.floor(deps.limit ?? 1000));
	const raw = await deps.kv.lrange(EVENTS_LIST, 0, limit - 1);
	const { events, malformed } = parseEvents(raw);
	let inserted = 0;
	for (const event of events) {
		inserted += await insertRawFeedback(deps.db, mapKvEventToRaw(event));
	}
	return { read: raw.length, inserted, malformed };
}
