import { z } from "zod";
import { TierSchema } from "../config/schema.js";
import { SKILL_NAMES } from "../skill-names.js";

const skillName = z
	.string()
	.refine((name) => SKILL_NAMES.has(name), "unknown skill name");

const ReviewerOverrideSchema = z
	.object({
		enabled: z.literal(false).optional(),
		runOn: z
			.array(TierSchema)
			.min(1)
			.refine((tiers) => new Set(tiers).size === tiers.length, "duplicate tier")
			.optional(),
		skills: z
			.record(skillName, z.object({ enabled: z.literal(false) }).strict())
			.optional(),
	})
	.strict();

export const RepoConfigSchema = z
	.object({
		version: z.literal(1),
		reviewers: z
			.record(
				z.string().regex(/^[a-z][a-z0-9-]*$/, "invalid reviewer id"),
				ReviewerOverrideSchema,
			)
			.optional(),
		routing: z
			.object({
				sensitivePathPatterns: z
					.array(z.string().min(1).max(100))
					.max(50)
					.optional(),
			})
			.strict()
			.optional(),
		review: z
			.object({
				minSeverity: z.enum(["P3", "P2", "P1"]).optional(),
				customPrompt: z.string().max(2000).optional(),
				command: z
					.string()
					.min(1)
					.max(50)
					.refine((c) => c.startsWith("/"), "must start with /")
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
