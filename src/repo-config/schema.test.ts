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

	it("rejects a sensitive path pattern shorter than 3 characters", () => {
		for (const bad of ["/", ".", "ab"])
			expect(
				RepoConfigSchema.safeParse({
					version: 1,
					routing: { sensitivePathPatterns: [bad] },
				}).success,
			).toBe(false);
		expect(
			RepoConfigSchema.safeParse({
				version: 1,
				routing: { sensitivePathPatterns: ["abc"] },
			}).success,
		).toBe(true);
	});
	it("rejects a command shorter than 4 characters including the slash", () => {
		for (const bad of ["/a", "/ab"])
			expect(
				RepoConfigSchema.safeParse({ version: 1, review: { command: bad } })
					.success,
			).toBe(false);
		expect(
			RepoConfigSchema.safeParse({ version: 1, review: { command: "/abc" } })
				.success,
		).toBe(true);
	});
});
