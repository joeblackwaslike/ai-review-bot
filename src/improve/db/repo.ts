import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { findingCatalog, rawFeedback } from "./schema.js";

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
