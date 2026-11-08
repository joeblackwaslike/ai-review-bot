import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCommittedPlan,
	ExperimentPlanSchema,
	loadPlan,
	planHash,
} from "./plan.js";
import { splitOf } from "./splits.js";
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
		let n = 10;
		while (splitOf(`o/r#${n}`, plan.seed) !== "validation") n++;
		plan.fixtures.push({
			id: `o/r#${n}`,
			split: "validation",
			provider: "openai",
		});
		const parsed = ExperimentPlanSchema.safeParse(plan);
		expect(parsed.success).toBe(false);
		const messages = (parsed.error?.issues ?? []).map((i) => i.message);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatch(/OpenAI cells run only on the test split/);
	});

	it("rejects duplicate fixture ids", () => {
		const plan = samplePlan();
		plan.fixtures.push({
			...(plan.fixtures[0] as (typeof plan.fixtures)[number]),
		});
		const parsed = ExperimentPlanSchema.safeParse(plan);
		expect(parsed.success).toBe(false);
		expect(JSON.stringify(parsed.error?.issues)).toMatch(/duplicate/i);
	});

	it.each([
		"not-an-id",
		"o/r#x",
		"o/r#1@gemini",
		"o/r/x#1",
		"o/r#1@openai@openai",
	])("rejects the malformed fixture id %s", (id) => {
		const plan = samplePlan();
		plan.fixtures.push({ id, split: "tuning", provider: "anthropic" });
		expect(ExperimentPlanSchema.safeParse(plan).success).toBe(false);
	});

	it("rejects a provider suffix that disagrees with the provider", () => {
		const plan = samplePlan();
		plan.fixtures.push({
			id: "o/r#7@openai",
			split: splitOf("o/r#7", plan.seed),
			provider: "anthropic",
		});
		expect(ExperimentPlanSchema.safeParse(plan).success).toBe(false);
	});

	it("rejects a split that does not follow the seeded hash", () => {
		const plan = samplePlan();
		const f = plan.fixtures[0] as (typeof plan.fixtures)[number];
		f.split = f.split === "tuning" ? "validation" : "tuning";
		expect(ExperimentPlanSchema.safeParse(plan).success).toBe(false);
	});

	it("accepts both providers of one PR in the hashed split", () => {
		const plan = samplePlan();
		plan.fixtures.push({
			id: "o/r#2@anthropic",
			split: "test",
			provider: "anthropic",
		});
		expect(ExperimentPlanSchema.safeParse(plan).success).toBe(true);
	});

	it("accepts an optional draft flag", () => {
		const parsed = ExperimentPlanSchema.safeParse({
			...samplePlan(),
			draft: true,
		});
		expect(parsed.success && parsed.data.draft).toBe(true);
	});

	it("rejects an unknown mode", () => {
		expect(
			ExperimentPlanSchema.safeParse({ ...samplePlan(), mode: "bogus" })
				.success,
		).toBe(false);
	});

	it("mode chained is accepted and hashes differently from per-round", () => {
		const chained = { ...samplePlan(), mode: "chained" as const };
		expect(ExperimentPlanSchema.safeParse(chained).success).toBe(true);
		expect(planHash(chained)).not.toBe(planHash(samplePlan()));
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

	it("gives each plan file in one directory its own lock", () => {
		const dir = mkdtempSync(join(tmpdir(), "plan-"));
		const per = samplePlan();
		const chained = { ...samplePlan(), mode: "chained" as const };
		writeFileSync(join(dir, "plan.json"), JSON.stringify(per));
		writeFileSync(join(dir, "plan-chained.json"), JSON.stringify(chained));
		writeFileSync(join(dir, "plan.lock"), `${planHash(per)}\n`);
		writeFileSync(join(dir, "plan-chained.lock"), `${planHash(chained)}\n`);
		expect(loadPlan(join(dir, "plan.json")).lockedHash).toBe(planHash(per));
		expect(loadPlan(join(dir, "plan-chained.json")).lockedHash).toBe(
			planHash(chained),
		);
	});

	it("does not read plan.lock for another plan file", () => {
		const dir = mkdtempSync(join(tmpdir(), "plan-"));
		writeFileSync(join(dir, "plan-chained.json"), JSON.stringify(samplePlan()));
		writeFileSync(join(dir, "plan.lock"), "0000000000000000\n");
		expect(loadPlan(join(dir, "plan-chained.json")).lockedHash).toBeNull();
	});

	it("reports a missing lock as null", () => {
		const dir = mkdtempSync(join(tmpdir(), "plan-"));
		writeFileSync(join(dir, "plan.json"), JSON.stringify(samplePlan()));
		expect(loadPlan(join(dir, "plan.json")).lockedHash).toBeNull();
	});
});

describe("committed draft plan", () => {
	const dir = join(process.cwd(), "docs", "review-experiments");

	it("is valid, marked draft, and has no lock yet", () => {
		const parsed = ExperimentPlanSchema.parse(
			JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")),
		);
		expect(parsed.draft).toBe(true);
		expect(existsSync(join(dir, "plan.lock"))).toBe(false);
	});
});
