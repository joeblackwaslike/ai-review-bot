import { describe, expect, it } from "vitest";
import {
	applyEnvOverlay,
	ENV_ALIASES,
	envNameForPath,
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
});
