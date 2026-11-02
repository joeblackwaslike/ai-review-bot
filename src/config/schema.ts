import { z } from "zod";
import { DEFAULT_DIFF_BUDGET_CHARS } from "../diff-pack.js";

export const EffortSchema = z
	.enum(["none", "low", "medium", "high", "xhigh", "max"])
	.describe("Reasoning effort passed to the provider.");

export const TierSchema = z
	.enum(["trivial", "normal", "complex", "deep"])
	.describe("PR size and risk tier chosen by the router.");

const MODEL_ID = /^[^/\s]+\/\S+$/;
const REVIEWER_ID = /^[a-z][a-z0-9-]*$/;

const modelId = (what: string) =>
	z.string().regex(MODEL_ID, "must look like provider/model").describe(what);

const price = (what: string) =>
	z.number().nonnegative().describe(`${what}, USD per million tokens.`);

const ModelSchema = z
	.object({
		pricing: z
			.object({
				input: price("Input token price"),
				cachedInput: price("Cached input token price"),
				output: price("Output token price"),
			})
			.strict()
			.describe("Token prices used for cost reporting."),
		refusalFallback: z
			.boolean()
			.default(false)
			.describe("Retry once with a fallback when the model refuses."),
		structuredOutput: z
			.enum(["native", "json"])
			.default("native")
			.describe("How structured output is requested from this model."),
	})
	.strict();

const TierChoiceSchema = z
	.object({
		model: modelId("Model for this tier; must exist in models."),
		effort: EffortSchema.optional(),
	})
	.strict();

const ReviewerSchema = z
	.object({
		enabled: z.boolean().default(true).describe("Run this reviewer."),
		tiers: z
			.object({
				trivial: TierChoiceSchema,
				normal: TierChoiceSchema,
				complex: TierChoiceSchema,
				deep: TierChoiceSchema,
			})
			.strict()
			.describe("Model and effort per tier."),
	})
	.strict();

const ReviewSchema = z
	.object({
		enabled: z
			.boolean()
			.default(true)
			.describe("Review pull requests automatically."),
		delaySeconds: z
			.number()
			.nonnegative()
			.default(0)
			.describe("Delay before the first automatic review."),
		resyncDelaySeconds: z
			.number()
			.nonnegative()
			.default(0)
			.describe("Delay before re-reviewing after a push."),
		command: z
			.string()
			.min(1)
			.default("/ai-review")
			.describe("Comment command that triggers a review."),
		customPrompt: z
			.string()
			.optional()
			.describe("Extra instructions appended to every agent prompt."),
		agentConcurrency: z
			.number()
			.min(1)
			.default(4)
			.describe("Maximum review agents run in parallel per PR."),
		agentBudgetSeconds: z
			.number()
			.positive()
			.default(210)
			.describe("Wall-clock deadline for agents, in seconds."),
		diffBudgetChars: z
			.number()
			.int()
			.positive()
			.default(DEFAULT_DIFF_BUDGET_CHARS)
			.describe("PR-wide character budget for the serialized diff."),
		tier2Enabled: z
			.boolean()
			.default(true)
			.describe("Run conditional Tier 2 review skills."),
		feedbackEnabled: z
			.boolean()
			.default(false)
			.describe("Record reaction feedback on findings."),
	})
	.strict();

const ImproveSchema = z
	.object({
		enabled: z
			.boolean()
			.default(false)
			.describe("Capture the improvement corpus."),
		carrierEnabled: z
			.boolean()
			.default(false)
			.describe("Post the review summary carrier comment."),
	})
	.strict();

const InfraSchema = z
	.object({
		publicUrl: z
			.string()
			.optional()
			.describe("Stable public origin used for QStash callbacks."),
		qstashUrl: z.string().optional().describe("QStash regional endpoint."),
	})
	.strict();

const CliSchema = z
	.object({
		gateDir: z.string().optional().describe("Directory for the gate store."),
		mistakesDir: z
			.string()
			.optional()
			.describe("Directory for the mistake log."),
		logFile: z.string().optional().describe("Path of the agent outcome log."),
	})
	.strict();

const RoutingSchema = z
	.object({
		sensitivePathPatterns: z
			.array(z.string())
			.default([
				"auth",
				"crypto",
				"jwt",
				"password",
				"secret",
				"/db/",
				"database",
				"migration",
				"schema",
			])
			.describe("Lowercase path substrings that force the complex tier."),
		docExtensions: z
			.array(z.string())
			.default([".md", ".txt", ".rst", ".mdx"])
			.describe("File extensions treated as documentation."),
		deepLabel: z
			.string()
			.default("deep-review")
			.describe("PR label that forces the deep tier."),
		complexLines: z
			.number()
			.int()
			.nonnegative()
			.default(500)
			.describe("Changed lines above which a PR is complex."),
		trivialDocLines: z
			.number()
			.int()
			.nonnegative()
			.default(20)
			.describe("Changed lines below which a docs-only PR is trivial."),
	})
	.strict();

export const ConfigSchema = z
	.object({
		version: z.literal(1).describe("Config schema version."),
		review: ReviewSchema.default(() => ReviewSchema.parse({})).describe(
			"Review behavior.",
		),
		improve: ImproveSchema.default(() => ImproveSchema.parse({})).describe(
			"Improvement corpus.",
		),
		infra: InfraSchema.default(() => ({})).describe("Hosting endpoints."),
		cli: CliSchema.default(() => ({})).describe("Local CLI paths."),
		routing: RoutingSchema.default(() => RoutingSchema.parse({})).describe(
			"Tier routing rules.",
		),
		models: z
			.record(
				z.string().regex(MODEL_ID, "must look like provider/model"),
				ModelSchema,
			)
			.describe("Known models, keyed provider/model."),
		reviewers: z
			.record(
				z.string().regex(REVIEWER_ID, "must match ^[a-z][a-z0-9-]*$"),
				ReviewerSchema,
			)
			.describe("Reviewers, keyed by id."),
	})
	.strict()
	.superRefine((cfg, ctx) => {
		for (const [id, reviewer] of Object.entries(cfg.reviewers)) {
			for (const [tier, choice] of Object.entries(reviewer.tiers)) {
				if (!(choice.model in cfg.models)) {
					ctx.addIssue({
						code: "custom",
						path: ["reviewers", id, "tiers", tier, "model"],
						message: `model "${choice.model}" is not defined in models`,
					});
				}
			}
		}
	});

export type Config = z.infer<typeof ConfigSchema>;
