import { eq, sql } from "drizzle-orm";
import type { FindingOutcome } from "../trends.js";
import type { Db } from "./client.js";
import {
	classifiedFeedback,
	findingCatalog,
	qcRuns,
	rawFeedback,
} from "./schema.js";

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
		-- Aggregated, not joined: a thread is a conversation and can carry several
		-- replies. A plain join would emit one bundle per reply, so the classifier
		-- would be billed for the same reaction repeatedly and the work queue would
		-- overstate what is left to do.
		--
		-- Keyed on the thread ROOT, not on rf's own id, so it behaves the same for a
		-- reaction (root = the finding it sits on) and for a reply-only row (root =
		-- in_reply_to_id) — the latter then picks up its own body plus any siblings
		-- instead of only itself.
		--
		-- Ordered by id so the first reply — the direct answer to the finding, which
		-- carries the verdict phrase — stays at the front where the deterministic
		-- opener match can still see it.
		left join lateral (
		       select string_agg(r.body, E'\n\n---\n\n' order by r.id) as body
		       from raw_feedback r
		       where r.in_reply_to_id = coalesce(rf.in_reply_to_id, rf.comment_id)
		         and r.source = 'inline_reply'
		) reply on true
		-- A maintainer who answers a finding without also reacting leaves only an
		-- inline_reply row. Excluding replies outright dropped that free-text
		-- signal entirely — 36% of replies in the corpus have no reaction on their
		-- thread. Reply rows are admitted only when their thread carries no
		-- reaction, so a reaction and its reply are still classified as one bundle
		-- rather than counted twice.
		where (
		        rf.source <> 'inline_reply'
		        or (
		              not exists (
		                select 1 from raw_feedback rx
		                where rx.comment_id = rf.in_reply_to_id
		                  and rx.source <> 'inline_reply'
		              )
		              -- One bundle per thread, not per reply: without this a
		              -- reaction-less thread carrying three replies would be
		              -- classified three times over, each pointing at the same
		              -- finding. The lateral above already gathers the siblings.
		              and rf.id = (
		                select min(r2.id) from raw_feedback r2
		                where r2.in_reply_to_id = rf.in_reply_to_id
		                  and r2.source = 'inline_reply'
		              )
		            )
		      )
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

/** Every classified finding with the outcome its feedback implies, for the
 * trend layer. A finding with several pieces of feedback appears once per
 * piece, which is intended: several people reacting the same way to one finding
 * is a stronger signal than one, whichever way they reacted. */
export async function listFindingOutcomes(db: Db): Promise<FindingOutcome[]> {
	const result = await db.execute(sql`
		select f.id, f.pr, f.path, f.title, f.severity, f.skills, f.backfilled,
		       c.intent
		from classified_feedback c
		join finding_catalog f on f.id = c.matched_finding_id
	`);
	// Raw SQL, so the row shape is asserted rather than inferred. `id` is a
	// bigserial and the driver hands those back as strings to avoid precision
	// loss, hence the explicit Number(); `backfilled` and `pr` are parsed to
	// boolean/number by the driver's type handlers. Verified against the live
	// database rather than assumed.
	return (
		result.rows as unknown as {
			id: string | number;
			pr: number;
			path: string | null;
			title: string;
			severity: string | null;
			skills: string[] | null;
			backfilled: boolean;
			intent: FindingOutcome["intent"];
		}[]
	).map((r) => ({
		findingId: Number(r.id),
		pr: Number(r.pr),
		path: r.path,
		title: r.title,
		severity: r.severity,
		skills: r.skills ?? [],
		backfilled: r.backfilled,
		intent: r.intent,
	}));
}

/** Findings posted on one PR, for QC to judge.
 *
 * `comment_id` comes back because the catalog stores the title only: the judge
 * needs the finding's full text and the code it was anchored to, and both are
 * read back from the posted comment rather than duplicated into this table. */
export async function listFindingsForPr(
	db: Db,
	owner: string,
	repo: string,
	pr: number,
): Promise<
	{
		id: number;
		provider: "anthropic" | "openai";
		commentId: number | null;
		path: string | null;
		line: number | null;
		title: string;
		severity: string | null;
	}[]
> {
	const result = await db.execute(sql`
		select id, provider, comment_id, path, line, title, severity
		from finding_catalog
		where owner = ${owner} and repo = ${repo} and pr = ${pr}
		order by id
	`);
	return (
		result.rows as unknown as {
			id: string | number;
			provider: "anthropic" | "openai";
			comment_id: string | number | null;
			path: string | null;
			line: number | null;
			title: string;
			severity: string | null;
		}[]
	).map(({ comment_id, ...r }) => ({
		...r,
		id: Number(r.id),
		commentId: comment_id === null ? null : Number(comment_id),
	}));
}

/** Claim a QC run for a PR head. Returns the number of rows inserted, which the
 * unique index on `dedup_key` pins to exactly 0 or 1: 0 means a run already
 * exists, which is how a second /qc on an unchanged PR is prevented from
 * re-spending budget. Callers depend on that 0/1 contract, so a change here
 * that returns anything else silently breaks the dedup gate. */
export async function recordQcRun(
	db: Db,
	row: typeof qcRuns.$inferInsert,
): Promise<0 | 1> {
	const inserted = await db
		.insert(qcRuns)
		.values(row)
		.onConflictDoNothing({ target: qcRuns.dedupKey })
		.returning({ id: qcRuns.id });
	return inserted.length === 0 ? 0 : 1;
}

/** Write the real counts onto a claimed run once it has been reported.
 *
 * The row is inserted with placeholder counts before any judging happens, so
 * without this the table records that a run occurred but never what it found.
 *
 * `prCommentId` doubles as the completion marker: it is null on a claim and set
 * here, so a row that still has none is a run that never finished. */
export async function finalizeQcRun(
	db: Db,
	dedupKey: string,
	result: {
		findingsJudged: number;
		falsePositives: number;
		prCommentId: number;
	},
): Promise<void> {
	await db.update(qcRuns).set(result).where(eq(qcRuns.dedupKey, dedupKey));
}

/** Release a claimed run so /qc can be retried against the same PR head.
 *
 * The claim is taken before any work so two concurrent runs cannot both spend
 * model budget; dropping it on failure is what keeps that from turning a
 * transient error into a permanent lockout. */
export async function releaseQcRun(db: Db, dedupKey: string): Promise<void> {
	await db.delete(qcRuns).where(eq(qcRuns.dedupKey, dedupKey));
}

/** Drop a claim left behind by a run that died without reporting, so the head
 * becomes eligible for /qc again. Returns whether a row was actually removed.
 *
 * Releasing on error covers a throw, but not a hard function timeout or an
 * instance being killed — no catch block runs in either case, and the claim
 * would otherwise be held forever. An unfinished row (`pr_comment_id is null`)
 * older than the function's own wall-clock limit cannot still be in flight, so
 * it is safe to reclaim without racing a live run. */
export async function reclaimStaleQcRun(
	db: Db,
	dedupKey: string,
	staleAfterSeconds: number,
): Promise<boolean> {
	const deleted = await db.execute(sql`
		delete from qc_runs
		where dedup_key = ${dedupKey}
		  and pr_comment_id is null
		  and ran_at < now() - make_interval(secs => ${staleAfterSeconds})
		returning id
	`);
	return deleted.rows.length > 0;
}
