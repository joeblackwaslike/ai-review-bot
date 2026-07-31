import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { classifiedFeedback, findingCatalog, rawFeedback } from "./schema.js";

export type RawFeedbackInsert = typeof rawFeedback.$inferInsert;
export type FindingInsert = typeof findingCatalog.$inferInsert;

/** Insert a raw feedback row; a duplicate dedup_key is a no-op.
 * Returns the number of rows actually inserted (1 on insert, 0 on conflict). */
export async function insertRawFeedback(
	db: Db,
	row: RawFeedbackInsert,
): Promise<number> {
	const inserted = await db
		.insert(rawFeedback)
		.values(row)
		.onConflictDoNothing({ target: rawFeedback.dedupKey })
		.returning({ id: rawFeedback.id });
	return inserted.length;
}

/** Upsert a finding by its natural_key, returning the row id (stable across
 * updates). Later phases join feedback/QC against finding_catalog.id.
 *
 * The conflict clause is written to be order-independent, because the same
 * finding can arrive from live capture (rich: real skills) and from the
 * historical backfill (thin: no skills), in either order. Merging by taking the
 * better of each field means neither pass can degrade what the other recorded. */
export async function upsertFinding(
	db: Db,
	row: FindingInsert,
): Promise<number> {
	const result = await db
		.insert(findingCatalog)
		.values(row)
		.onConflictDoUpdate({
			target: findingCatalog.naturalKey,
			set: {
				title: row.title,
				headSha: row.headSha,
				severity: sql`coalesce(excluded.severity, ${findingCatalog.severity})`,
				commentId: sql`coalesce(excluded.comment_id, ${findingCatalog.commentId})`,
				reviewId: sql`coalesce(excluded.review_id, ${findingCatalog.reviewId})`,
				// Spelled as CASE/`<> '{}'` rather than least()/cardinality(): both
				// are equivalent here because posted_at and skills are NOT NULL, and
				// these forms are also executable by the pg-mem test harness, so the
				// merge logic is covered by unit tests rather than integration-only.
				postedAt: sql`case when excluded.posted_at < ${findingCatalog.postedAt} then excluded.posted_at else ${findingCatalog.postedAt} end`,
				// Never let an empty backfill array erase skills a live capture knew.
				skills: sql`case when excluded.skills <> '{}' then excluded.skills else ${findingCatalog.skills} end`,
				// Backfilled only while *every* pass that saw this row was a backfill.
				backfilled: sql`${findingCatalog.backfilled} and excluded.backfilled`,
			},
		})
		.returning({ id: findingCatalog.id });
	return result[0].id;
}

export type ClassifiedInsert = typeof classifiedFeedback.$inferInsert;

/** Feedback that has no classification yet, joined to the finding it concerns
 * and to the reply on its thread. A reaction and its reply are returned as one
 * row so the classifier always sees them together. */
export async function listUnclassifiedBundles(
	db: Db,
	limit: number,
): Promise<
	{
		rawFeedbackId: number;
		findingId: number | null;
		findingTitle: string;
		skills: string[];
		verdict: string | null;
		replyBody: string | null;
	}[]
> {
	const result = await db.execute(sql`
		select rf.id as raw_feedback_id,
		       f.id as finding_id,
		       coalesce(f.title, rf.title, '') as finding_title,
		       coalesce(f.skills, '{}') as skills,
		       rf.verdict,
		       reply.body as reply_body
		from raw_feedback rf
		left join finding_catalog f
		       on f.comment_id = coalesce(rf.in_reply_to_id, rf.comment_id)
		left join raw_feedback reply
		       on reply.in_reply_to_id = rf.comment_id
		      and reply.source = 'inline_reply'
		where rf.source <> 'inline_reply'
		  and not exists (
		        select 1 from classified_feedback c where c.raw_feedback_id = rf.id
		      )
		order by rf.id
		limit ${limit}
	`);
	return (
		result.rows as unknown as {
			raw_feedback_id: number;
			finding_id: number | null;
			finding_title: string;
			skills: string[];
			verdict: string | null;
			reply_body: string | null;
		}[]
	).map((r) => ({
		rawFeedbackId: Number(r.raw_feedback_id),
		findingId: r.finding_id === null ? null : Number(r.finding_id),
		findingTitle: r.finding_title,
		skills: r.skills ?? [],
		verdict: r.verdict,
		replyBody: r.reply_body,
	}));
}

/** Record one classification. A duplicate raw_feedback_id is a no-op, so a
 * re-run after a partially failed batch cannot double-count a signal. */
export async function insertClassified(
	db: Db,
	row: ClassifiedInsert,
): Promise<number> {
	const inserted = await db
		.insert(classifiedFeedback)
		.values(row)
		.onConflictDoNothing({ target: classifiedFeedback.rawFeedbackId })
		.returning({ id: classifiedFeedback.id });
	return inserted.length;
}
