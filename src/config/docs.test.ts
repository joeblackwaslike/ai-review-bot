import { describe, expect, it } from "vitest";
import { buildConfigRows, renderConfigSection } from "./docs.js";

describe("buildConfigRows", () => {
	const rows = buildConfigRows();
	const byPath = new Map(rows.map((r) => [r.path, r]));

	it("gives every row a non-empty description, including optional wrappers", () => {
		expect(rows.filter((r) => r.description.trim() === "")).toEqual([]);
		expect(byPath.get("reviewers.<id>.tiers.normal.effort")?.description).toBe(
			"Reasoning effort passed to the provider.",
		);
		expect(byPath.get("review.customPrompt")?.description).toBe(
			"Extra instructions appended to every agent prompt.",
		);
	});

	it("derives env names, aliases, types and defaults", () => {
		expect(byPath.get("review.delaySeconds")).toMatchObject({
			env: "AI_REVIEW_REVIEW__DELAY_SECONDS",
			alias: "REVIEW_DELAY_SECONDS (deprecated)",
			type: "number",
			default: "0",
		});
		expect(byPath.get("cli.gateDir")?.alias).toBe(
			"AI_REVIEW_GATE_DIR (permanent)",
		);
		expect(byPath.get("review.feedbackEnabled")?.type).toBe("boolean");
		expect(byPath.get("routing.docExtensions")?.type).toBe("string[]");
		expect(byPath.get("reviewers.<id>.tiers.normal.effort")?.type).toContain(
			"xhigh",
		);
	});

	it("documents map sections with placeholder paths and no env var for models", () => {
		expect(byPath.get("models.<provider/model>.pricing.input")?.env).toBe(
			"none",
		);
		expect(byPath.get("reviewers.<id>.enabled")?.env).toBe(
			"AI_REVIEW_REVIEWERS__<ID>__ENABLED",
		);
	});
});

describe("renderConfigSection", () => {
	it("is deterministic", () => {
		expect(renderConfigSection()).toBe(renderConfigSection());
	});
});
