import { describe, expect, it } from "vitest";
import {
	applyEnvOverlay,
	describeSecrets,
	ENV_ALIASES,
	envNameForPath,
	providerKeySpec,
	readSecret,
	type SecretSpec,
	secretSpecs,
	UnknownConfigEnvError,
} from "./env.js";

const raw = (review: Record<string, unknown> = {}) => ({ version: 1, review });

describe("envNameForPath", () => {
	it("derives screaming snake names with double underscores between levels", () => {
		expect(
			envNameForPath(["reviewers", "gemini-lite", "tiers", "normal", "model"]),
		).toBe("AI_REVIEW_REVIEWERS__GEMINI_LITE__TIERS__NORMAL__MODEL");
		expect(envNameForPath(["review", "agentConcurrency"])).toBe(
			"AI_REVIEW_REVIEW__AGENT_CONCURRENCY",
		);
	});
});

describe("applyEnvOverlay", () => {
	it("derived name overrides yaml", () => {
		const r = applyEnvOverlay(raw({ agentConcurrency: 2 }), {
			AI_REVIEW_REVIEW__AGENT_CONCURRENCY: "7",
		});
		expect(r.value).toMatchObject({ review: { agentConcurrency: 7 } });
		expect(r.sources["review.agentConcurrency"]).toBe("env");
	});

	it("yaml overrides default", () => {
		const r = applyEnvOverlay(raw({ agentConcurrency: 2 }), {});
		expect(r.value).toMatchObject({ review: { agentConcurrency: 2 } });
		expect(r.sources["review.agentConcurrency"]).toBe("yaml");
		expect(r.sources["review.delaySeconds"]).toBe("default");
	});

	it("alias maps to its path and warns once", () => {
		const r = applyEnvOverlay(raw(), { REVIEW_ENABLED: "false" });
		expect(r.value).toMatchObject({ review: { enabled: false } });
		expect(r.sources["review.enabled"]).toBe("alias");
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("REVIEW_ENABLED");
		expect(r.warnings[0]).toContain("AI_REVIEW_REVIEW__ENABLED");
	});

	it("derived name beats alias and warns about both", () => {
		const r = applyEnvOverlay(raw(), {
			REVIEW_ENABLED: "false",
			AI_REVIEW_REVIEW__ENABLED: "true",
		});
		expect(r.value).toMatchObject({ review: { enabled: true } });
		expect(r.sources["review.enabled"]).toBe("env");
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("REVIEW_ENABLED");
		expect(r.warnings[0]).toContain("AI_REVIEW_REVIEW__ENABLED");
	});

	it("blank value is treated as unset", () => {
		const r = applyEnvOverlay(raw({ delaySeconds: 5 }), {
			REVIEW_DELAY_SECONDS: "  ",
		});
		expect(r.value).toMatchObject({ review: { delaySeconds: 5 } });
		expect(r.sources["review.delaySeconds"]).toBe("yaml");
		expect(r.warnings).toEqual([]);
	});

	it("boolean accepts False and TRUE, rejects 0", () => {
		expect(
			applyEnvOverlay(raw(), { REVIEW_ENABLED: "False" }).value,
		).toMatchObject({ review: { enabled: false } });
		expect(
			applyEnvOverlay(raw(), { REVIEW_ENABLED: "TRUE" }).value,
		).toMatchObject({ review: { enabled: true } });
		expect(() => applyEnvOverlay(raw(), { REVIEW_ENABLED: "0" })).toThrow(
			/REVIEW_ENABLED/,
		);
	});

	it("number rejects abc", () => {
		expect(() =>
			applyEnvOverlay(raw(), { REVIEW_DELAY_SECONDS: "abc" }),
		).toThrow(/REVIEW_DELAY_SECONDS/);
	});

	it("unknown AI_REVIEW_ var throws with a suggestion", () => {
		const call = () =>
			applyEnvOverlay(raw(), {
				AI_REVIEW_REVIEW__AGENT_CONCURENCY: "3",
			});
		expect(call).toThrow(UnknownConfigEnvError);
		expect(call).toThrow(/AI_REVIEW_REVIEW__AGENT_CONCURRENCY/);
	});

	it("AI_REVIEW_GATE_DIR is accepted without a deprecation warning", () => {
		const r = applyEnvOverlay(raw(), { AI_REVIEW_GATE_DIR: "/tmp/gate" });
		expect(r.value).toMatchObject({ cli: { gateDir: "/tmp/gate" } });
		expect(r.sources["cli.gateDir"]).toBe("alias");
		expect(r.warnings).toEqual([]);
		expect(ENV_ALIASES.AI_REVIEW_GATE_DIR?.deprecated).toBe(false);
	});

	it("array values parse as JSON", () => {
		const r = applyEnvOverlay(
			{ version: 1 },
			{ AI_REVIEW_ROUTING__SENSITIVE_PATH_PATTERNS: '["auth","billing"]' },
		);
		expect(r.value).toMatchObject({
			routing: { sensitivePathPatterns: ["auth", "billing"] },
		});
		expect(() =>
			applyEnvOverlay(
				{ version: 1 },
				{ AI_REVIEW_ROUTING__SENSITIVE_PATH_PATTERNS: "[nope" },
			),
		).toThrow(/AI_REVIEW_ROUTING__SENSITIVE_PATH_PATTERNS/);
	});

	it("overrides reviewer entries only when they exist in the yaml", () => {
		const yaml = {
			version: 1,
			reviewers: {
				"gemini-lite": {
					tiers: { normal: { model: "google/a" } },
				},
			},
		};
		const r = applyEnvOverlay(yaml, {
			AI_REVIEW_REVIEWERS__GEMINI_LITE__TIERS__NORMAL__MODEL: "google/b",
		});
		expect(r.value).toMatchObject({
			reviewers: {
				"gemini-lite": { tiers: { normal: { model: "google/b" } } },
			},
		});
		expect(() =>
			applyEnvOverlay(yaml, {
				AI_REVIEW_REVIEWERS__OTHER__ENABLED: "false",
			}),
		).toThrow(UnknownConfigEnvError);
	});

	it("does not mutate the raw input", () => {
		const input = raw({ agentConcurrency: 2 });
		applyEnvOverlay(input, { REVIEW_ENABLED: "false" });
		expect(input).toEqual(raw({ agentConcurrency: 2 }));
	});

	it("rejects prototype-polluting map keys without touching Object.prototype", () => {
		const yaml = JSON.parse(
			'{"version":1,"reviewers":{"__proto__":{"tiers":{"normal":{"model":"google/a"}}}}}',
		);
		const name = envNameForPath([
			"reviewers",
			"__proto__",
			"tiers",
			"normal",
			"model",
		]);
		expect(() => applyEnvOverlay(yaml, { [name]: "polluted" })).toThrow(
			/__proto__/,
		);
		expect(({} as Record<string, unknown>).tiers).toBeUndefined();
	});
});

const reviewersYaml = (...ids: string[]) => ({
	version: 1,
	reviewers: Object.fromEntries(ids.map((id) => [id, {}])),
});

describe("multi-path aliases", () => {
	it("GITHUB_APP_ID is accepted with no warning", () => {
		const r = applyEnvOverlay(reviewersYaml("claude"), { GITHUB_APP_ID: "12" });
		expect(r.value).toMatchObject({ reviewers: { claude: { appId: "12" } } });
		expect(r.sources["reviewers.claude.appId"]).toBe("alias");
		expect(r.warnings).toEqual([]);
	});

	it("OPENAI_APP_ID warns once and names AI_REVIEW_REVIEWERS__CODEX__APP_ID", () => {
		const r = applyEnvOverlay(reviewersYaml("codex"), { OPENAI_APP_ID: "7" });
		expect(r.value).toMatchObject({ reviewers: { codex: { appId: "7" } } });
		expect(r.warnings).toEqual([
			"OPENAI_APP_ID is deprecated; use AI_REVIEW_REVIEWERS__CODEX__APP_ID",
		]);
	});

	it("derived name beats alias for appId and warns", () => {
		const r = applyEnvOverlay(reviewersYaml("claude"), {
			GITHUB_APP_ID: "1",
			AI_REVIEW_REVIEWERS__CLAUDE__APP_ID: "2",
		});
		expect(r.value).toMatchObject({ reviewers: { claude: { appId: "2" } } });
		expect(r.warnings).toEqual([
			"GITHUB_APP_ID and AI_REVIEW_REVIEWERS__CLAUDE__APP_ID are both set; using AI_REVIEW_REVIEWERS__CLAUDE__APP_ID",
		]);
	});

	it("REVIEW_COMMENT_PREFIX sets both claude and codex prefixes, OPENAI_REVIEW_COMMENT_PREFIX wins for codex", () => {
		const yaml = reviewersYaml("claude", "codex");
		const both = applyEnvOverlay(yaml, { REVIEW_COMMENT_PREFIX: "x" });
		expect(both.value).toMatchObject({
			reviewers: {
				claude: { commentPrefix: "x" },
				codex: { commentPrefix: "x" },
			},
		});
		const split = applyEnvOverlay(yaml, {
			REVIEW_COMMENT_PREFIX: "x",
			OPENAI_REVIEW_COMMENT_PREFIX: "y",
		});
		expect(split.value).toMatchObject({
			reviewers: {
				claude: { commentPrefix: "x" },
				codex: { commentPrefix: "y" },
			},
		});
	});
});

describe("secret env names", () => {
	it("AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY is accepted when gemini is in the config", () => {
		const r = applyEnvOverlay(reviewersYaml("gemini"), {
			AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY: "pem",
		});
		expect(r.warnings).toEqual([]);
	});

	it("the same name for a reviewer absent from YAML produces a warning, not an UnknownConfigEnvError", () => {
		const r = applyEnvOverlay(reviewersYaml("claude"), {
			AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY: "pem",
		});
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY");
	});

	it("AI_REVIEW_PROVIDERS__GOOGLE__API_KEY is accepted without a providers.google YAML entry", () => {
		const r = applyEnvOverlay(reviewersYaml("claude"), {
			AI_REVIEW_PROVIDERS__GOOGLE__API_KEY: "k",
			AI_REVIEW_GITHUB__WEBHOOK_SECRET: "s",
		});
		expect(r.warnings).toEqual([]);
	});

	it("a typo still throws with the closest name", () => {
		const call = () =>
			applyEnvOverlay(reviewersYaml("gemini"), {
				AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEYS: "pem",
			});
		expect(call).toThrow(UnknownConfigEnvError);
		expect(call).toThrow(/AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY\?/);
	});

	it("a secret value never appears in applyEnvOverlay's value or sources", () => {
		const r = applyEnvOverlay(reviewersYaml("claude"), {
			AI_REVIEW_REVIEWERS__CLAUDE__PRIVATE_KEY: "TOPSECRET",
			GITHUB_WEBHOOK_SECRET: "TOPSECRET",
			ANTHROPIC_API_KEY: "TOPSECRET",
		});
		expect(JSON.stringify(r)).not.toContain("TOPSECRET");
	});
});

describe("secretSpecs and readSecret", () => {
	const config = {
		reviewers: { claude: {}, codex: {}, gemini: {} },
	} as never;

	it("lists reviewer, provider and shared specs", () => {
		const names = secretSpecs(config).map((s) => s.envName);
		expect(names).toContain("AI_REVIEW_REVIEWERS__CODEX__WEBHOOK_SECRET");
		expect(names).toContain("AI_REVIEW_PROVIDERS__ANTHROPIC__API_KEY");
		expect(names).toContain("AI_REVIEW_GITHUB__WEBHOOK_SECRET");
	});

	it("readSecret prefers the derived name over the standard name", () => {
		const spec = providerKeySpec("anthropic");
		const r = readSecret(spec, {
			ANTHROPIC_API_KEY: "std",
			AI_REVIEW_PROVIDERS__ANTHROPIC__API_KEY: "derived",
		});
		expect(r.value).toBe("derived");
	});

	it("readSecret falls back to the alias and treats blank as unset", () => {
		const spec = providerKeySpec("openai");
		expect(readSecret(spec, { OPENAI_API_KEY: "k" }).value).toBe("k");
		expect(readSecret(spec, { OPENAI_API_KEY: "  " }).value).toBeUndefined();
	});

	it("a deprecated secret alias warns", () => {
		const spec = secretSpecs(config).find(
			(s) => s.envName === "AI_REVIEW_REVIEWERS__CODEX__PRIVATE_KEY",
		) as SecretSpec;
		const r = readSecret(spec, { OPENAI_APP_PRIVATE_KEY: "pem" });
		expect(r.value).toBe("pem");
		expect(r.warnings).toHaveLength(1);
	});

	it("describeSecrets returns presence only", () => {
		const d = describeSecrets(config, {
			GITHUB_APP_PRIVATE_KEY: "TOPSECRET",
		});
		expect(d.AI_REVIEW_REVIEWERS__CLAUDE__PRIVATE_KEY).toBe("present");
		expect(d.AI_REVIEW_REVIEWERS__CODEX__PRIVATE_KEY).toBe("absent");
		expect(JSON.stringify(d)).not.toContain("TOPSECRET");
	});
});
