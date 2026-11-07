import type { JSONObject } from "@ai-sdk/provider";
import { z } from "zod";
import { DEFAULT_DIFF_BUDGET_CHARS } from "../diff-pack.js";
import { supportedEfforts } from "../providers/effort.js";
import { isProviderName, PROVIDER_NAMES } from "../providers/names.js";
import { SKILL_NAMES } from "../skill-names.js";

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
			.optional()
			.describe(
				"Pin token prices for cost reporting; when absent, prices come from OpenRouter. When set, input, cachedInput and output are all required.",
			),
		refusalFallback: z
			.boolean()
			.default(false)
			.describe("Retry once with a fallback when the model refuses."),
		effortControl: z
			.enum(["level", "budget"])
			.optional()
			.describe("How a Google model takes reasoning effort."),
		providerOptions: z
			.record(
				z.string(),
				z
					.custom<JSONObject>(
						(v) => typeof v === "object" && v !== null && !Array.isArray(v),
						"must be an object",
					)
					.describe("Options for one provider."),
			)
			.optional()
			.describe("Provider options merged over the computed options."),
		structuredOutput: z
			.enum(["native", "json"])
			.default("native")
			.describe(
				"Reserved. Not read yet; a later slice will use it to pick the structured output mode.",
			),
	})
	.strict();

const TierChoiceSchema = z
	.object({
		model: modelId("Model for this tier."),
		effort: EffortSchema.optional(),
	})
	.strict();

const RoleChoiceSchema = z
	.object({
		model: modelId("Model for this role."),
		effort: EffortSchema.optional(),
	})
	.strict();

const ReviewerRolesSchema = z
	.object({
		summary: RoleChoiceSchema.optional().describe("Summary writer."),
		triage: RoleChoiceSchema.optional().describe("Reply triage."),
		revalidate: RoleChoiceSchema.optional().describe("Finding revalidation."),
	})
	.strict();

const RolesSchema = ReviewerRolesSchema.extend({
	verifier: RoleChoiceSchema.extend({
		differentFrom: z
			.literal("finder")
			.optional()
			.describe("Require a verifier from a different model than the finder."),
		enabled: z.boolean().default(true).describe("Run the verifier."),
	})
		.strict()
		.optional()
		.describe("Finding verifier."),
	qcJudge: RoleChoiceSchema.optional().describe("Quality-check judge."),
	classifier: RoleChoiceSchema.optional().describe("Finding classifier."),
}).strict();

const RESERVED_REVIEWER_IDS: ReadonlySet<string> = new Set([
	"anthropic",
	"openai",
	"constructor",
	"prototype",
]);

const TIER_KEYS = ["trivial", "normal", "complex", "deep"] as const;

const SkillChoiceSchema = z
	.object({
		model: modelId("Model for this skill in every tier.").optional(),
		effort: EffortSchema.optional().describe(
			"Effort for the skill model; needs model.",
		),
		trivial: TierChoiceSchema.optional().describe(
			"Model and effort for this skill on trivial PRs.",
		),
		normal: TierChoiceSchema.optional().describe(
			"Model and effort for this skill on normal PRs.",
		),
		complex: TierChoiceSchema.optional().describe(
			"Model and effort for this skill on complex PRs.",
		),
		deep: TierChoiceSchema.optional().describe(
			"Model and effort for this skill on deep PRs.",
		),
	})
	.strict()
	.superRefine((choice, ctx) => {
		if (!choice.model && !TIER_KEYS.some((t) => choice[t])) {
			ctx.addIssue({
				code: "custom",
				message: "a skills entry needs a model or at least one tier",
			});
		}
		if (choice.effort && !choice.model) {
			ctx.addIssue({
				code: "custom",
				path: ["effort"],
				message: "effort needs a model on the same skills entry",
			});
		}
	});

const ReviewerSchema = z
	.object({
		enabled: z.boolean().default(true).describe("Run this reviewer."),
		appId: z.coerce
			.string()
			.regex(/^\d+$/, "must be a numeric GitHub App id")
			.optional()
			.describe("GitHub App id; the environment supplies it when unset."),
		appSlug: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]*$/i, "must be a GitHub App slug")
			.optional()
			.describe("GitHub App slug, used to recognize this bot's own reviews."),
		commentPrefix: z
			.string()
			.min(1)
			.optional()
			.describe("Heading prefix on this reviewer's comments."),
		concurrency: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe("Maximum agents run in parallel for this reviewer."),
		runOn: z
			.array(TierSchema)
			.min(1)
			.refine((tiers) => new Set(tiers).size === tiers.length, {
				message: "tiers must be unique",
			})
			.optional()
			.describe("Tiers this reviewer runs on; every tier when unset."),
		roles: ReviewerRolesSchema.optional().describe(
			"Per-reviewer models for non-review roles.",
		),
		skills: z
			.record(z.string(), SkillChoiceSchema)
			.optional()
			.describe("Per-skill model overrides, keyed by skill name."),
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
			.describe(
				"Path substrings (case-insensitive) that force the complex tier.",
			),
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
		roles: RolesSchema.default(() => ({})).describe(
			"Deployment-wide models for non-review roles.",
		),
		providers: z
			.partialRecord(
				z.enum(PROVIDER_NAMES),
				z
					.object({
						baseURL: z
							.string()
							.optional()
							.describe("Override the provider API base URL."),
					})
					.strict(),
			)
			.default({})
			.describe("Per-provider connection settings."),
	})
	.strict()
	.superRefine((cfg, ctx) => {
		const issue = (path: (string | number)[], message: string) =>
			ctx.addIssue({ code: "custom", path, message });

		const bareIds = new Map<string, string>();
		for (const key of Object.keys(cfg.models)) {
			const bare = key.slice(key.indexOf("/") + 1);
			const first = bareIds.get(bare);
			if (first !== undefined) {
				issue(
					["models", key],
					`models "${first}" and "${key}" share the bare model id "${bare}"; cost lookup would be ambiguous`,
				);
			} else {
				bareIds.set(bare, key);
			}
		}

		const providerOf = (path: (string | number)[], id: string) => {
			const prefix = id.split("/")[0] as string;
			if (isProviderName(prefix)) return prefix;
			issue(
				path,
				`unknown provider "${prefix}" in "${id}"; expected one of ${PROVIDER_NAMES.join(", ")}`,
			);
			return undefined;
		};

		const checkChoice = (
			path: (string | number)[],
			id: string,
			effort: string | undefined,
		) => {
			const provider = providerOf([...path, "model"], id);
			if (!provider || !effort) return;
			const control = cfg.models[id]?.effortControl;
			const allowed: readonly string[] = supportedEfforts(provider, control);
			if (!allowed.includes(effort)) {
				issue(
					[...path, "effort"],
					`${provider} models do not take effort "${effort}"`,
				);
			}
		};

		for (const [key, model] of Object.entries(cfg.models)) {
			providerOf(["models", key], key);
			for (const name of Object.keys(model.providerOptions ?? {})) {
				if (!isProviderName(name)) {
					issue(
						["models", key, "providerOptions", name],
						`unknown provider "${name}"; expected one of ${PROVIDER_NAMES.join(", ")}`,
					);
				}
			}
		}

		for (const [name, role] of Object.entries(cfg.roles)) {
			if (typeof role === "object" && role !== null && "model" in role) {
				checkChoice(["roles", name], role.model, role.effort);
			}
		}

		const slugs = new Map<string, string>();
		for (const [id, reviewer] of Object.entries(cfg.reviewers)) {
			if (RESERVED_REVIEWER_IDS.has(id)) {
				issue(
					["reviewers", id],
					`reviewer id "${id}" is reserved: it is a legacy provider name or an unsafe config path key`,
				);
			}
			for (const tier of TIER_KEYS) {
				const choice = reviewer.tiers[tier];
				checkChoice(
					["reviewers", id, "tiers", tier],
					choice.model,
					choice.effort,
				);
			}
			for (const [name, role] of Object.entries(reviewer.roles ?? {})) {
				checkChoice(["reviewers", id, "roles", name], role.model, role.effort);
			}
			for (const [name, skill] of Object.entries(reviewer.skills ?? {})) {
				const base = ["reviewers", id, "skills", name];
				if (!SKILL_NAMES.has(name)) issue(base, `unknown skill "${name}"`);
				if (skill.model) checkChoice(base, skill.model, skill.effort);
				for (const tier of TIER_KEYS) {
					const choice = skill[tier];
					if (choice) checkChoice([...base, tier], choice.model, choice.effort);
				}
			}
			if (reviewer.appSlug) {
				const slug = reviewer.appSlug.toLowerCase();
				const first = slugs.get(slug);
				if (first !== undefined) {
					issue(
						["reviewers", id, "appSlug"],
						`appSlug "${reviewer.appSlug}" is already used by reviewer "${first}"`,
					);
				} else {
					slugs.set(slug, id);
				}
			}
		}
	});

export type Config = z.infer<typeof ConfigSchema>;
