-- Contract step 1 of 2. Apply BEFORE deploying the code that stops writing
-- `provider`. Safe with the old code still running: nothing is dropped, the old
-- provider-based indexes stay, and the old code's writes (provider and reviewer
-- both set, ON CONFLICT DO NOTHING with no target) satisfy every new constraint.
UPDATE "finding_catalog" SET "reviewer" = CASE "provider" WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'codex' ELSE "provider" END WHERE "reviewer" IS NULL;--> statement-breakpoint
UPDATE "finding_discards" SET "reviewer" = CASE "provider" WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'codex' ELSE "provider" END WHERE "reviewer" IS NULL;--> statement-breakpoint
UPDATE "qc_scores" SET "reviewer" = CASE "provider" WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'codex' ELSE "provider" END WHERE "reviewer" IS NULL;--> statement-breakpoint
UPDATE "raw_feedback" SET "reviewer" = CASE "provider" WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'codex' ELSE "provider" END WHERE "reviewer" IS NULL;--> statement-breakpoint
ALTER TABLE "finding_catalog" ALTER COLUMN "reviewer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "finding_discards" ALTER COLUMN "reviewer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "qc_scores" ALTER COLUMN "reviewer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_feedback" ALTER COLUMN "reviewer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "finding_catalog" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "finding_discards" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "qc_scores" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_feedback" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finding_discards_uq_reviewer" ON "finding_discards" USING btree ("reviewer","owner","repo","pr","review_sha","reason","natural_key",coalesce("skill", ''),coalesce("line", -1));
