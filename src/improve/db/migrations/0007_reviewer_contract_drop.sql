-- Contract step 2 of 2. Apply AFTER the code that no longer touches `provider`
-- is deployed everywhere. Drops the column, the provider-based indexes and the
-- enum type, then replaces the interim reviewer indexes from 0005/0006 with the
-- ones schema.ts declares (same columns, final names).
DROP INDEX IF EXISTS "finding_discards_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "finding_catalog_pr_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "finding_discards_pr_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "raw_feedback_pr_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "finding_discards_uq_reviewer";--> statement-breakpoint
DROP INDEX IF EXISTS "finding_catalog_reviewer_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "finding_discards_reviewer_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "raw_feedback_reviewer_idx";--> statement-breakpoint
ALTER TABLE "finding_catalog" DROP COLUMN IF EXISTS "provider";--> statement-breakpoint
ALTER TABLE "finding_discards" DROP COLUMN IF EXISTS "provider";--> statement-breakpoint
ALTER TABLE "qc_scores" DROP COLUMN IF EXISTS "provider";--> statement-breakpoint
ALTER TABLE "raw_feedback" DROP COLUMN IF EXISTS "provider";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."provider";--> statement-breakpoint
CREATE UNIQUE INDEX "finding_discards_uq" ON "finding_discards" USING btree ("reviewer","owner","repo","pr","review_sha","reason","natural_key",coalesce("skill", ''),coalesce("line", -1));--> statement-breakpoint
CREATE INDEX "finding_catalog_pr_idx" ON "finding_catalog" USING btree ("reviewer","owner","repo","pr");--> statement-breakpoint
CREATE INDEX "finding_discards_pr_idx" ON "finding_discards" USING btree ("reviewer","owner","repo","pr");--> statement-breakpoint
CREATE INDEX "raw_feedback_pr_idx" ON "raw_feedback" USING btree ("reviewer","owner","repo","pr");
