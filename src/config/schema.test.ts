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

	it("accepts a tier model that has no models entry", () => {
		const cfg = minimal();
		cfg.reviewers.claude.tiers.deep = {
			model: "openai/gpt-missing",
			effort: "high",
		};
		expect(ConfigSchema.safeParse(cfg).success).toBe(true);
	});

	it("accepts a model entry without pricing", () => {
		const cfg = minimal();
		cfg.models["anthropic/claude-sonnet-5-5"] = {
			refusalFallback: true,
		} as never;
		expect(ConfigSchema.safeParse(cfg).success).toBe(true);
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
		const cfg = minimal();
		Object.assign(cfg.models, { "claude-sonnet-5-5": structuredClone(sonnet) });
		const result = ConfigSchema.safeParse(cfg);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain(
			"must look like provider/model",
		);
		expect(JSON.stringify(result.error?.issues)).not.toContain(
			"is not defined in models",
		);
	});

	it("rejects two models that share a bare id", () => {
		const cfg = minimal();
		Object.assign(cfg.models, {
			"openai/claude-sonnet-5-5": structuredClone(sonnet),
		});
		const result = ConfigSchema.safeParse(cfg);
		expect(result.success).toBe(false);
		const text = JSON.stringify(result.error?.issues);
		expect(text).toContain("anthropic/claude-sonnet-5-5");
		expect(text).toContain("openai/claude-sonnet-5-5");
	});

	it("rejects negative pricing", () => {
		const cfg = minimal();
		cfg.models["anthropic/claude-sonnet-5-5"].pricing.input = -1;
		expect(ConfigSchema.safeParse(cfg).success).toBe(false);
	});
});
