import { describe, expect, it } from "vitest";
import { describeConfig, loadConfig } from "./load.js";

describe("describeConfig", () => {
	it("lists every leaf with its dotted path, value and source", () => {
		const rows = describeConfig(
			loadConfig({ env: { AI_REVIEW_REVIEW__DELAY_SECONDS: "7" } }),
		);
		const byPath = new Map(rows.map((r) => [r.path, r]));
		expect(byPath.get("review.delaySeconds")).toEqual({
			path: "review.delaySeconds",
			value: 7,
			source: "env",
		});
		expect(byPath.get("review.command")?.source).toBe("yaml");
		expect(byPath.get("routing.sensitivePathPatterns")?.value).toEqual(
			expect.arrayContaining(["auth"]),
		);
	});

	it("reports the alias source", () => {
		const rows = describeConfig(loadConfig({ env: { REVIEW_COMMAND: "/x" } }));
		expect(rows.find((r) => r.path === "review.command")?.source).toBe("alias");
	});

	it("lists models and reviewers entries by path like any other leaf", () => {
		const paths = describeConfig(loadConfig({ env: {} })).map((r) => r.path);
		expect(paths).toContain("reviewers.claude.tiers.normal.model");
		expect(
			paths.some(
				(p) => p.startsWith("models.") && p.endsWith(".refusalFallback"),
			),
		).toBe(true);
	});

	it("has unique paths", () => {
		const paths = describeConfig(loadConfig({ env: {} })).map((r) => r.path);
		expect(new Set(paths).size).toBe(paths.length);
	});
});
