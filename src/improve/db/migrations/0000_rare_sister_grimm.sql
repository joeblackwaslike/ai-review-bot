CREATE TYPE "public"."feedback_intent" AS ENUM('downvote', 'upvote', 'bug_report', 'noise');--> statement-breakpoint
CREATE TYPE "public"."feedback_source" AS ENUM('inline_reaction', 'review_reaction', 'inline_reply', 'pr_comment');--> statement-breakpoint
CREATE TYPE "public"."proposal_kind" AS ENUM('issue', 'pr');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('open', 'spec_ready', 'approved', 'pr_open', 'closed_merged', 'closed_rejected');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('anthropic', 'openai');--> statement-breakpoint
CREATE TYPE "public"."qc_trigger" AS ENUM('command', 'sample');--> statement-breakpoint
CREATE TYPE "public"."trend_kind" AS ENUM('skill_downvote_ratio', 'skill_positive_signal', 'repeated_fp_signature', 'qc_disagreement', 'downvote_spike');--> statement-breakpoint
CREATE TABLE "classified_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"raw_feedback_id" bigint NOT NULL,
	"intent" "feedback_intent" NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"is_bot_related" boolean NOT NULL,
	"matched_finding_id" bigint,
	"fp_signature" text,
	"model" text NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_catalog" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" "provider" NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"comment_id" bigint,
	"review_id" bigint,
	"path" text,
	"line" integer,
	"skills" text[] NOT NULL,
	"title" text NOT NULL,
	"severity" text,
	"head_sha" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"natural_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trend_id" bigint,
	"kind" "proposal_kind" NOT NULL,
	"status" "proposal_status" DEFAULT 'open' NOT NULL,
	"signature" text NOT NULL,
	"github_number" integer,
	"github_url" text,
	"target_file" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedup_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qc_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"trigger" "qc_trigger" NOT NULL,
	"pr_comment_id" bigint,
	"findings_judged" integer NOT NULL,
	"false_positives" integer NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedup_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qc_scores" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"finding_id" bigint NOT NULL,
	"provider" "provider" NOT NULL,
	"trigger" "qc_trigger" NOT NULL,
	"is_false_positive" boolean NOT NULL,
	"is_useful" boolean NOT NULL,
	"severity_correct" boolean NOT NULL,
	"suggested_severity" text,
	"rationale" text NOT NULL,
	"pr_comment_id" bigint,
	"model" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedup_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" "feedback_source" NOT NULL,
	"provider" "provider" NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"comment_id" bigint,
	"review_id" bigint,
	"in_reply_to_id" bigint,
	"path" text,
	"line" integer,
	"skills" text[],
	"title" text,
	"verdict" text,
	"actor" text NOT NULL,
	"body" text,
	"event_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedup_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trends" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" "trend_kind" NOT NULL,
	"signature" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"metric_value" numeric NOT NULL,
	"sample_size" integer NOT NULL,
	"detail" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedup_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classified_feedback" ADD CONSTRAINT "classified_feedback_raw_feedback_id_raw_feedback_id_fk" FOREIGN KEY ("raw_feedback_id") REFERENCES "public"."raw_feedback"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classified_feedback" ADD CONSTRAINT "classified_feedback_matched_finding_id_finding_catalog_id_fk" FOREIGN KEY ("matched_finding_id") REFERENCES "public"."finding_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_trend_id_trends_id_fk" FOREIGN KEY ("trend_id") REFERENCES "public"."trends"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_scores" ADD CONSTRAINT "qc_scores_finding_id_finding_catalog_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."finding_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "classified_feedback_raw_uq" ON "classified_feedback" USING btree ("raw_feedback_id");--> statement-breakpoint
CREATE INDEX "classified_feedback_intent_idx" ON "classified_feedback" USING btree ("intent");--> statement-breakpoint
CREATE INDEX "classified_feedback_fp_sig_idx" ON "classified_feedback" USING btree ("fp_signature");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_catalog_natural_key_uq" ON "finding_catalog" USING btree ("natural_key");--> statement-breakpoint
CREATE INDEX "finding_catalog_pr_idx" ON "finding_catalog" USING btree ("provider","owner","repo","pr");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_dedup_key_uq" ON "proposals" USING btree ("dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "qc_runs_dedup_key_uq" ON "qc_runs" USING btree ("dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "qc_scores_dedup_key_uq" ON "qc_scores" USING btree ("dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_feedback_dedup_key_uq" ON "raw_feedback" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "raw_feedback_pr_idx" ON "raw_feedback" USING btree ("provider","owner","repo","pr");--> statement-breakpoint
CREATE INDEX "raw_feedback_source_idx" ON "raw_feedback" USING btree ("source");--> statement-breakpoint
CREATE INDEX "raw_feedback_captured_at_idx" ON "raw_feedback" USING btree ("captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trends_dedup_key_uq" ON "trends" USING btree ("dedup_key");