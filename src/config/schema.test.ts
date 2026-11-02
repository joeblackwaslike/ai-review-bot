import { describe, expect, it } from "vitest";
import { DEFAULT_DIFF_BUDGET_CHARS } from "../diff-pack.js";
import { ConfigSchema } from "./schema.js";

const tier = { model: "anthropic/claude-sonnet-5-5", effort: "high" };
const tiers = { trivial: tier, normal: tier, complex: tier, deep: tier };
const sonnet = { pricing: { input: 3, cachedInput: 0.3, output: 15 } };
const minimal = () => ({
	version: 1,
	models: { "anthropic/claude-sonnet-5-5": structuredClone(sonnet) },
	reviewers: { claude: { tiers: structuredClone(tiers) } },
});

describe("ConfigSchema", () => {
	it("accepts the minimal valid config", () => {
		const parsed = ConfigSchema.parse(minimal());
		expect(parsed.review.agentConcurrency).toBe(4);
		expect(parsed.review.agentBudgetSeconds).toBe(210);
		expect(parsed.review.diffBudgetChars).toBe(DEFAULT_DIFF_BUDGET_CHARS);
		expect(parsed.review.command).toBe("/ai-review");
		expect(parsed.review.enabled).toBe(true);
		expect(parsed.review.feedbackEnabled).toBe(false);
		expect(parsed.improve.enabled).toBe(false);
		expect(parsed.reviewers.claude?.enabled).toBe(true);
		const model = parsed.models["anthropic/claude-sonnet-5-5"];
		expect(model?.structuredOutput).toBe("native");
		expect(model?.refusalFallback).toBe(false);
	});

	it("rejects a tier model with no models entry", () => {
		const cfg = minimal();
		cfg.reviewers.claude.tiers.deep = {
			model: "openai/gpt-missing",
			effort: "high",
		};
		const result = ConfigSchema.safeParse(cfg);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain(
			"openai/gpt-missing",
		);
	});

	it("rejects a bad reviewer id", () => {
		for (const id of ["Claude", "a_b"]) {
			const cfg = { ...minimal(), reviewers: { [id]: { tiers } } };
			expect(ConfigSchema.safeParse(cfg).success).toBe(false);
		}
	});

	it("rejects a secret key in a reviewer", () => {
		const cfg = minimal();
		Object.assign(cfg.reviewers.claude, { privateKey: "x" });
		const result = ConfigSchema.safeParse(cfg);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain("privateKey");
	});

	it("rejects a bad model id", () => {
		const cfg = { ...minimal(), models: { "claude-sonnet-5-5": sonnet } };
		expect(ConfigSchema.safeParse(cfg).success).toBe(false);
	});

	it("rejects negative pricing", () => {
		const cfg = minimal();
		cfg.models["anthropic/claude-sonnet-5-5"].pricing.input = -1;
		expect(ConfigSchema.safeParse(cfg).success).toBe(false);
	});
});
