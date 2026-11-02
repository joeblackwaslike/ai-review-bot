CREATE TYPE "public"."discard_code" AS ENUM('OFF_DIFF_PATH', 'OFF_DIFF_LINE', 'BAD_RANGE');--> statement-breakpoint
CREATE TYPE "public"."discard_disposition" AS ENUM('dropped', 'held');--> statement-breakpoint
CREATE TYPE "public"."discard_reason" AS ENUM('SUPPRESSED_SETTLED', 'SUPPRESSED_OPEN', 'RETRACTION', 'OFF_DIFF', 'CAP', 'DISCARDED_BY_VERIFY', 'RESOLVED_LOCATION');--> statement-breakpoint
CREATE TABLE "finding_discards" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" "provider" NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"review_sha" text NOT NULL,
	"reason" "discard_reason" NOT NULL,
	"code" "discard_code",
	"disposition" "discard_disposition" NOT NULL,
	"natural_key" text NOT NULL,
	"path" text,
	"line" integer,
	"severity" text,
	"title" text NOT NULL,
	"skill" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "finding_discards_uq" ON "finding_discards" USING btree ("provider","owner","repo","pr","review_sha","reason","natural_key",coalesce("skill", ''),coalesce("line", -1));--> statement-breakpoint
CREATE INDEX "finding_discards_pr_idx" ON "finding_discards" USING btree ("provider","owner","repo","pr");