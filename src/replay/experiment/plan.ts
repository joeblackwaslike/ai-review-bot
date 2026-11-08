import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { splitOf } from "./splits.js";

const ProviderSchema = z.enum(["anthropic", "openai"]);
const SplitSchema = z.enum(["tuning", "validation", "test"]);

const FIXTURE_ID = /^[^/#@\s]+\/[^/#@\s]+#\d+(?:@(?:anthropic|openai))?$/;

export const ExperimentPlanSchema = z
	.object({
		planVersion: z.number().int().positive(),
		mode: z.enum(["per-round", "chained"]),
		strategies: z
			.array(z.object({ name: z.string().min(1), version: z.string().min(1) }))
			.min(1),
		models: z.record(z.string(), z.string()),
		providers: z.array(ProviderSchema).min(1),
		budgets: z.object({
			maxAnthropicUsd: z.number().nonnegative(),
			maxOpenAiUsd: z.number().nonnegative(),
			perCellUsd: z.number().positive(),
			perCellWallMs: z.number().positive(),
		}),
		trials: z.number().int().positive(),
		seed: z.string().min(1),
		fixtures: z
			.array(
				z.object({
					id: z.string().regex(FIXTURE_ID),
					split: SplitSchema,
					provider: ProviderSchema,
				}),
			)
			.min(1),
		metrics: z.array(z.string()).min(1),
		thresholds: z.object({
			precisionBootstrap: z.object({
				level: z.number().gt(0).lt(1),
				resamples: z.number().int().positive(),
			}),
			maxRecallDropPoints: z.number().nonnegative(),
			hostedFitShare: z.number().gt(0).lte(1),
			hostedFitSeconds: z.number().positive(),
		}),
		a0Tolerance: z.number().positive().lt(1),
		selectionRule: z.string().min(1),
		draft: z.boolean().optional(),
	})
	.superRefine((plan, ctx) => {
		const seen = new Set<string>();
		for (const [i, f] of plan.fixtures.entries()) {
			if (seen.has(f.id))
				ctx.addIssue({
					code: "custom",
					path: ["fixtures", i, "id"],
					message: `duplicate fixture id ${f.id}`,
				});
			seen.add(f.id);
			const suffix = f.id.split("@")[1];
			if (suffix !== undefined && suffix !== f.provider)
				ctx.addIssue({
					code: "custom",
					path: ["fixtures", i, "id"],
					message: `fixture id ${f.id} names ${suffix} but the provider is ${f.provider}`,
				});
			if (splitOf(f.id, plan.seed) !== f.split)
				ctx.addIssue({
					code: "custom",
					path: ["fixtures", i, "split"],
					message: `split of ${f.id} must be ${splitOf(f.id, plan.seed)} from the seeded hash`,
				});
			if (f.provider === "openai" && f.split !== "test")
				ctx.addIssue({
					code: "custom",
					path: ["fixtures", i, "split"],
					message: `OpenAI cells run only on the test split (${f.id})`,
				});
		}
	});

export type ExperimentPlan = z.infer<typeof ExperimentPlanSchema>;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, canonical(v)]),
		);
	return value;
}

export function planHash(plan: ExperimentPlan): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(plan)))
		.digest("hex")
		.slice(0, 16);
}

export function loadPlan(path: string): {
	plan: ExperimentPlan;
	lockedHash: string | null;
} {
	const plan = ExperimentPlanSchema.parse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	const lock = join(dirname(path), `${basename(path, ".json")}.lock`);
	const lockedHash = existsSync(lock)
		? readFileSync(lock, "utf8").trim()
		: null;
	return { plan, lockedHash };
}

export function assertCommittedPlan(
	plan: ExperimentPlan,
	committedHash: string | null,
): void {
	const actual = planHash(plan);
	if (committedHash === null)
		throw new Error(
			"plan hash is not committed: the plan lock file is missing",
		);
	if (actual !== committedHash)
		throw new Error(
			`plan hash ${actual} differs from the committed hash ${committedHash}`,
		);
}
