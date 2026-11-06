ALTER TABLE "finding_catalog" ADD COLUMN IF NOT EXISTS "reviewer" text;--> statement-breakpoint
ALTER TABLE "finding_discards" ADD COLUMN IF NOT EXISTS "reviewer" text;--> statement-breakpoint
ALTER TABLE "qc_scores" ADD COLUMN IF NOT EXISTS "reviewer" text;--> statement-breakpoint
ALTER TABLE "raw_feedback" ADD COLUMN IF NOT EXISTS "reviewer" text;--> statement-breakpoint
UPDATE "finding_catalog" SET "reviewer" = CASE "provider"::text WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'codex' ELSE "provider"::text END WHERE "reviewer" IS NULL;--> statement-breakpoint
UPDATE "finding_discards" SET "reviewer" = CASE "provider"::text WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'codex' ELSE "provider"::text END WHERE "reviewer" IS NULL;--> statement-breakpoint
UPDATE "qc_scores" SET "reviewer" = CASE "provider"::text WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'codex' ELSE "provider"::text END WHERE "reviewer" IS NULL;--> statement-breakpoint
UPDATE "raw_feedback" SET "reviewer" = CASE "provider"::text WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'codex' ELSE "provider"::text END WHERE "reviewer" IS NULL;--> statement-breakpoint
ALTER TABLE "finding_catalog" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "finding_discards" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "qc_scores" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "raw_feedback" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."provider";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finding_catalog_reviewer_idx" ON "finding_catalog" USING btree ("reviewer","owner","repo","pr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finding_discards_reviewer_idx" ON "finding_discards" USING btree ("reviewer","owner","repo","pr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_feedback_reviewer_idx" ON "raw_feedback" USING btree ("reviewer","owner","repo","pr");
