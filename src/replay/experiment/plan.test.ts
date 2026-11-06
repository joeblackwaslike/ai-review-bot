import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCommittedPlan,
	ExperimentPlanSchema,
	loadPlan,
	planHash,
} from "./plan.js";
import { samplePlan } from "./testkit.js";

describe("planHash", () => {
	it("is 16 hex chars and stable across key order", () => {
		const plan = samplePlan();
		const reordered = Object.fromEntries(
			Object.entries(plan).reverse(),
		) as ReturnType<typeof samplePlan>;
		expect(planHash(plan)).toMatch(/^[0-9a-f]{16}$/);
		expect(planHash(reordered)).toBe(planHash(plan));
	});

	it("changes when a threshold changes", () => {
		const plan = samplePlan();
		const changed = {
			...plan,
			thresholds: { ...plan.thresholds, maxRecallDropPoints: 6 },
		};
		expect(planHash(changed)).not.toBe(planHash(plan));
	});
});

describe("ExperimentPlanSchema", () => {
	it("accepts the sample", () => {
		expect(ExperimentPlanSchema.safeParse(samplePlan()).success).toBe(true);
	});

	it("rejects an OpenAI cell on a non-test split", () => {
		const plan = samplePlan();
		plan.fixtures.push({
			id: "o/r#3",
			split: "validation",
			provider: "openai",
		});
		const parsed = ExperimentPlanSchema.safeParse(plan);
		expect(parsed.success).toBe(false);
	});

	it("rejects a non per-round mode", () => {
		expect(
			ExperimentPlanSchema.safeParse({ ...samplePlan(), mode: "chained" })
				.success,
		).toBe(false);
	});
});

describe("assertCommittedPlan and loadPlan", () => {
	it("throws when the hash differs", () => {
		const plan = samplePlan();
		expect(() => assertCommittedPlan(plan, planHash(plan))).not.toThrow();
		expect(() => assertCommittedPlan(plan, "0000000000000000")).toThrow(
			/plan hash/,
		);
	});

	it("loads a plan file and checks its sibling plan.lock", () => {
		const dir = mkdtempSync(join(tmpdir(), "plan-"));
		const plan = samplePlan();
		writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
		writeFileSync(join(dir, "plan.lock"), `${planHash(plan)}\n`);
		expect(loadPlan(join(dir, "plan.json"))).toEqual({
			plan,
			lockedHash: planHash(plan),
		});
	});

	it("reports a missing lock as null", () => {
		const dir = mkdtempSync(join(tmpdir(), "plan-"));
		writeFileSync(join(dir, "plan.json"), JSON.stringify(samplePlan()));
		expect(loadPlan(join(dir, "plan.json")).lockedHash).toBeNull();
	});
});
