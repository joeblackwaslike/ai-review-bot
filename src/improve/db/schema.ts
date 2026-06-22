import {
	bigint,
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const provider = pgEnum("provider", ["anthropic", "openai"]);
export const feedbackSource = pgEnum("feedback_source", [
	"inline_reaction",
	"review_reaction",
	"inline_reply",
	"pr_comment",
]);
export const feedbackIntent = pgEnum("feedback_intent", [
	"downvote",
	"upvote",
	"bug_report",
	"noise",
]);
export const trendKind = pgEnum("trend_kind", [
	"skill_downvote_ratio",
	"skill_positive_signal",
	"repeated_fp_signature",
	"qc_disagreement",
	"downvote_spike",
]);
export const qcTrigger = pgEnum("qc_trigger", ["command", "sample"]);
export const proposalKind = pgEnum("proposal_kind", ["issue", "pr"]);
export const proposalStatus = pgEnum("proposal_status", [
	"open",
	"spec_ready",
	"approved",
	"pr_open",
	"closed_merged",
	"closed_rejected",
]);

export const findingCatalog = pgTable(
	"finding_catalog",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		provider: provider("provider").notNull(),
		owner: text("owner").notNull(),
		repo: text("repo").notNull(),
		pr: integer("pr").notNull(),
		commentId: bigint("comment_id", { mode: "number" }),
		reviewId: bigint("review_id", { mode: "number" }),
		path: text("path"),
		line: integer("line"),
		skills: text("skills").array().notNull(),
		title: text("title").notNull(),
		severity: text("severity"),
		headSha: text("head_sha").notNull(),
		postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
		naturalKey: text("natural_key").notNull(),
	},
	(t) => [
		uniqueIndex("finding_catalog_natural_key_uq").on(t.naturalKey),
		index("finding_catalog_pr_idx").on(t.provider, t.owner, t.repo, t.pr),
	],
);

export const rawFeedback = pgTable(
	"raw_feedback",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		source: feedbackSource("source").notNull(),
		provider: provider("provider").notNull(),
		owner: text("owner").notNull(),
		repo: text("repo").notNull(),
		pr: integer("pr").notNull(),
		commentId: bigint("comment_id", { mode: "number" }),
		reviewId: bigint("review_id", { mode: "number" }),
		inReplyToId: bigint("in_reply_to_id", { mode: "number" }),
		path: text("path"),
		line: integer("line"),
		skills: text("skills").array(),
		title: text("title"),
		verdict: text("verdict"),
		actor: text("actor").notNull(),
		body: text("body"),
		eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
		capturedAt: timestamp("captured_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [
		uniqueIndex("raw_feedback_dedup_key_uq").on(t.dedupKey),
		index("raw_feedback_pr_idx").on(t.provider, t.owner, t.repo, t.pr),
		index("raw_feedback_source_idx").on(t.source),
		index("raw_feedback_captured_at_idx").on(t.capturedAt),
	],
);

export const classifiedFeedback = pgTable(
	"classified_feedback",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		rawFeedbackId: bigint("raw_feedback_id", { mode: "number" })
			.notNull()
			.references(() => rawFeedback.id),
		intent: feedbackIntent("intent").notNull(),
		confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
		isBotRelated: boolean("is_bot_related").notNull(),
		matchedFindingId: bigint("matched_finding_id", {
			mode: "number",
		}).references(() => findingCatalog.id),
		fpSignature: text("fp_signature"),
		model: text("model").notNull(),
		classifiedAt: timestamp("classified_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		uniqueIndex("classified_feedback_raw_uq").on(t.rawFeedbackId),
		index("classified_feedback_intent_idx").on(t.intent),
		index("classified_feedback_fp_sig_idx").on(t.fpSignature),
	],
);

export const qcScores = pgTable(
	"qc_scores",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		findingId: bigint("finding_id", { mode: "number" })
			.notNull()
			.references(() => findingCatalog.id),
		provider: provider("provider").notNull(),
		trigger: qcTrigger("trigger").notNull(),
		isFalsePositive: boolean("is_false_positive").notNull(),
		isUseful: boolean("is_useful").notNull(),
		severityCorrect: boolean("severity_correct").notNull(),
		suggestedSeverity: text("suggested_severity"),
		rationale: text("rationale").notNull(),
		prCommentId: bigint("pr_comment_id", { mode: "number" }),
		model: text("model").notNull(),
		judgedAt: timestamp("judged_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [uniqueIndex("qc_scores_dedup_key_uq").on(t.dedupKey)],
);

export const qcRuns = pgTable(
	"qc_runs",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		owner: text("owner").notNull(),
		repo: text("repo").notNull(),
		pr: integer("pr").notNull(),
		trigger: qcTrigger("trigger").notNull(),
		prCommentId: bigint("pr_comment_id", { mode: "number" }),
		findingsJudged: integer("findings_judged").notNull(),
		falsePositives: integer("false_positives").notNull(),
		ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [uniqueIndex("qc_runs_dedup_key_uq").on(t.dedupKey)],
);

export const trends = pgTable(
	"trends",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		kind: trendKind("kind").notNull(),
		signature: text("signature").notNull(),
		windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
		windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
		metricValue: numeric("metric_value").notNull(),
		sampleSize: integer("sample_size").notNull(),
		detail: jsonb("detail").notNull(),
		detectedAt: timestamp("detected_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [uniqueIndex("trends_dedup_key_uq").on(t.dedupKey)],
);

export const proposals = pgTable(
	"proposals",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		trendId: bigint("trend_id", { mode: "number" }).references(() => trends.id),
		kind: proposalKind("kind").notNull(),
		status: proposalStatus("status").notNull().default("open"),
		signature: text("signature").notNull(),
		githubNumber: integer("github_number"),
		githubUrl: text("github_url"),
		targetFile: text("target_file"),
		openedAt: timestamp("opened_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [uniqueIndex("proposals_dedup_key_uq").on(t.dedupKey)],
);
