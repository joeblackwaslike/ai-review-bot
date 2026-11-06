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

	it("rejects reviewer ids that collide with the legacy provider names", () => {
		for (const id of ["anthropic", "openai"]) {
			const cfg = { ...minimal(), reviewers: { [id]: { tiers } } };
			const result = ConfigSchema.safeParse(cfg);
			expect(result.success).toBe(false);
			expect(JSON.stringify(result.error?.issues)).toContain("reserved");
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

const issuesOf = (cfg: unknown) => {
	const result = ConfigSchema.safeParse(cfg);
	expect(result.success).toBe(false);
	return result.error?.issues ?? [];
};

const withTier = (deep: { model: string; effort?: string }) => {
	const cfg = minimal();
	cfg.reviewers.claude.tiers.deep = deep as never;
	return cfg;
};

const withClaude = (extra: Record<string, unknown>) => {
	const cfg = minimal();
	Object.assign(cfg.reviewers.claude, extra);
	return cfg;
};

describe("ConfigSchema reviewer identity and cross-checks", () => {
	it("rejects a model with an unknown provider prefix", () => {
		const issues = issuesOf(
			withTier({ model: "moonshot/kimi", effort: "low" }),
		);
		expect(issues.map((i) => i.path.join("."))).toContain(
			"reviewers.claude.tiers.deep.model",
		);
		const cfg = minimal();
		Object.assign(cfg.models, { "moonshot/kimi": {} });
		expect(issuesOf(cfg).map((i) => i.path.join("."))).toContain(
			"models.moonshot/kimi",
		);
	});

	it("rejects an unknown provider key inside providerOptions", () => {
		const cfg = minimal();
		Object.assign(cfg.models["anthropic/claude-sonnet-5-5"], {
			providerOptions: { gogle: { x: 1 } },
		});
		expect(issuesOf(cfg).map((i) => i.path.join("."))).toContain(
			"models.anthropic/claude-sonnet-5-5.providerOptions.gogle",
		);
	});

	it("rejects an effort the model cannot take", () => {
		const anthropicNone = issuesOf(
			withTier({ model: "anthropic/claude-sonnet-5-5", effort: "none" }),
		);
		expect(anthropicNone.map((i) => i.path.join("."))).toContain(
			"reviewers.claude.tiers.deep.effort",
		);
		const googleXhigh = issuesOf(
			withTier({ model: "google/gemini-3.1-flash-lite", effort: "xhigh" }),
		);
		expect(googleXhigh.map((i) => i.path.join("."))).toContain(
			"reviewers.claude.tiers.deep.effort",
		);
		const budget = withTier({
			model: "google/gemini-3.1-flash-lite",
			effort: "max",
		});
		Object.assign(budget.models, {
			"google/gemini-3.1-flash-lite": { effortControl: "budget" },
		});
		expect(issuesOf(budget).map((i) => i.path.join("."))).toContain(
			"reviewers.claude.tiers.deep.effort",
		);
	});

	it("rejects an effort a skill model cannot take", () => {
		const cfg = withClaude({
			skills: {
				"code-reviewer": {
					model: "google/gemini-3.1-flash-lite",
					effort: "max",
				},
			},
		});
		expect(issuesOf(cfg).map((i) => i.path.join("."))).toContain(
			"reviewers.claude.skills.code-reviewer.effort",
		);
	});

	it("rejects an unknown skill name", () => {
		const cfg = withClaude({
			skills: { "code-reviwer": { model: "anthropic/claude-sonnet-5-5" } },
		});
		expect(issuesOf(cfg).map((i) => i.path.join("."))).toContain(
			"reviewers.claude.skills.code-reviwer",
		);
	});

	it("rejects a skills entry with effort and no model", () => {
		const cfg = withClaude({
			skills: { "code-reviewer": { effort: "low", deep: tier } },
		});
		expect(issuesOf(cfg).map((i) => i.path.join("."))).toContain(
			"reviewers.claude.skills.code-reviewer.effort",
		);
	});

	it("rejects a skills entry with neither a model nor a tier", () => {
		const cfg = withClaude({ skills: { "code-reviewer": {} } });
		expect(issuesOf(cfg).map((i) => i.path.join("."))).toContain(
			"reviewers.claude.skills.code-reviewer",
		);
	});

	it("accepts a skills entry with a model or a tier", () => {
		const cfg = withClaude({
			skills: {
				"code-reviewer": { model: "openai/gpt-6.1-sol", effort: "low" },
				"security-sast": { deep: tier },
			},
		});
		expect(ConfigSchema.safeParse(cfg).success).toBe(true);
	});

	it("rejects a duplicate appSlug", () => {
		const cfg = withClaude({ appSlug: "same-bot" });
		Object.assign(cfg.reviewers, {
			codex: { tiers: structuredClone(tiers), appSlug: "same-bot" },
		});
		expect(issuesOf(cfg).map((i) => i.path.join("."))).toContain(
			"reviewers.codex.appSlug",
		);
	});

	it("allows a duplicate commentPrefix", () => {
		const cfg = withClaude({ commentPrefix: "ai-review-bot" });
		Object.assign(cfg.reviewers, {
			codex: { tiers: structuredClone(tiers), commentPrefix: "ai-review-bot" },
		});
		expect(ConfigSchema.safeParse(cfg).success).toBe(true);
	});

	it("rejects an empty runOn and a duplicate tier in runOn", () => {
		expect(ConfigSchema.safeParse(withClaude({ runOn: [] })).success).toBe(
			false,
		);
		expect(
			ConfigSchema.safeParse(withClaude({ runOn: ["deep", "deep"] })).success,
		).toBe(false);
		expect(
			ConfigSchema.safeParse(withClaude({ runOn: ["normal", "deep"] })).success,
		).toBe(true);
	});

	it("rejects a bad appSlug, commentPrefix and concurrency", () => {
		for (const extra of [
			{ appSlug: "-bad" },
			{ commentPrefix: "" },
			{ concurrency: 0 },
			{ appId: "abc" },
		]) {
			expect(ConfigSchema.safeParse(withClaude(extra)).success).toBe(false);
		}
	});

	it("rejects secret keys in a reviewer", () => {
		for (const key of ["privateKey", "webhookSecret", "apiKey"]) {
			const result = ConfigSchema.safeParse(withClaude({ [key]: "x" }));
			expect(result.success).toBe(false);
			expect(JSON.stringify(result.error?.issues)).toContain(key);
		}
	});

	it("accepts appId as a YAML number and coerces it to a string", () => {
		const parsed = ConfigSchema.parse(withClaude({ appId: 12345 }));
		expect(parsed.reviewers.claude?.appId).toBe("12345");
		expect(
			ConfigSchema.parse(minimal()).reviewers.claude?.appId,
		).toBeUndefined();
	});

	it("defaults providers to empty and rejects an unknown provider", () => {
		expect(ConfigSchema.parse(minimal()).providers).toEqual({});
		const ok = { ...minimal(), providers: { google: { baseURL: "http://x" } } };
		expect(ConfigSchema.safeParse(ok).success).toBe(true);
		const bad = { ...minimal(), providers: { moonshot: {} } };
		expect(ConfigSchema.safeParse(bad).success).toBe(false);
	});
});
