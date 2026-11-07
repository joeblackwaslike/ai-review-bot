import { describe, expect, it } from "vitest";
import { RepoConfigSchema } from "./schema.js";

describe("RepoConfigSchema", () => {
	it("accepts a minimal file", () => {
		expect(RepoConfigSchema.safeParse({ version: 1 }).success).toBe(true);
	});
	it("rejects enabled true", () => {
		const r = RepoConfigSchema.safeParse({
			version: 1,
			reviewers: { anthropic: { enabled: true } },
		});
		expect(r.success).toBe(false);
	});
	it("rejects an unknown key", () => {
		expect(RepoConfigSchema.safeParse({ version: 1, extra: 1 }).success).toBe(
			false,
		);
		expect(
			RepoConfigSchema.safeParse({ version: 1, review: { nope: 1 } }).success,
		).toBe(false);
	});
	it("rejects an unknown skill name", () => {
		const bad = {
			version: 1,
			reviewers: { a: { skills: { nonsense: { enabled: false } } } },
		};
		expect(RepoConfigSchema.safeParse(bad).success).toBe(false);
		const ok = {
			version: 1,
			reviewers: { a: { skills: { "code-reviewer": { enabled: false } } } },
		};
		expect(RepoConfigSchema.safeParse(ok).success).toBe(true);
	});
	it("rejects duplicate or empty runOn and a command without a slash", () => {
		expect(
			RepoConfigSchema.safeParse({
				version: 1,
				reviewers: { a: { runOn: ["deep", "deep"] } },
			}).success,
		).toBe(false);
		expect(
			RepoConfigSchema.safeParse({
				version: 1,
				reviewers: { a: { runOn: [] } },
			}).success,
		).toBe(false);
		expect(
			RepoConfigSchema.safeParse({ version: 1, review: { command: "x" } })
				.success,
		).toBe(false);
	});
});
