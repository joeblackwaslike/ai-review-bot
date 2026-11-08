import { describe, expect, it } from "vitest";
import { parseReviewCommand } from "../commands.js";
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
	it("restricts review.command to a single safe token", () => {
		const parse = (command: string) =>
			RepoConfigSchema.safeParse({ version: 1, review: { command } }).success;
		for (const bad of [
			"/re`view",
			"/review\nme",
			"/re view",
			"/<img>x",
			"/@someone",
			"/rev]ew",
			"/rev(ew",
			"//review",
			"/lgtm ",
			"/lgtm\n",
			" /lgtm",
		])
			expect(parse(bad), bad).toBe(false);
		expect(parse(`/${"a".repeat(50)}`)).toBe(false);
		expect(parse("/lgtm")).toBe(true);
		expect(parse("/re-review_2")).toBe(true);
	});
	it("every command the schema accepts is matched by parseReviewCommand", () => {
		for (const command of [
			"/lgtm",
			"/re-review_2",
			"/ABC",
			"/a".padEnd(50, "b"),
		]) {
			const ok = RepoConfigSchema.safeParse({
				version: 1,
				review: { command },
			}).success;
			expect(ok, command).toBe(true);
			expect(parseReviewCommand(command, command), command).not.toBeNull();
			expect(
				parseReviewCommand(`${command}\n`, command),
				command,
			).not.toBeNull();
		}
	});
	it("rejects an empty or whitespace-only customPrompt", () => {
		const parse = (customPrompt: string) =>
			RepoConfigSchema.safeParse({ version: 1, review: { customPrompt } })
				.success;
		expect(parse("")).toBe(false);
		expect(parse("  \n\t")).toBe(false);
		expect(parse("Check billing.")).toBe(true);
	});
});
