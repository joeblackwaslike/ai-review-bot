import { describe, expect, it } from "vitest";
import { branchForHead, implementerFromEnv } from "./session.js";

describe("implementerFromEnv", () => {
	it("reads the Claude Code session id", () => {
		expect(implementerFromEnv({ CLAUDE_CODE_SESSION_ID: "abc" })).toEqual({
			agent: "claude-code",
			sessionId: "abc",
			source: "env",
			confidence: "high",
		});
	});

	it("is all null for an empty env", () => {
		expect(implementerFromEnv({})).toEqual({
			agent: null,
			sessionId: null,
			source: null,
			confidence: null,
		});
	});
});

describe("branchForHead", () => {
	it("prefers the current branch over other branches at HEAD", () => {
		const runGit = (args: readonly string[]) =>
			args[0] === "rev-parse" ? "feature\n" : "main\nfeature\n";
		expect(branchForHead(runGit)).toBe("feature");
	});

	it("falls back to the first branch pointing at HEAD when detached", () => {
		const runGit = (args: readonly string[]) =>
			args[0] === "rev-parse" ? "HEAD\n" : "feat/a\nfeat/b\n";
		expect(branchForHead(runGit)).toBe("feat/a");
	});

	it("returns null on a detached HEAD with no branch", () => {
		const runGit = (args: readonly string[]) =>
			args[0] === "rev-parse" ? "HEAD\n" : "";
		expect(branchForHead(runGit)).toBeNull();
	});

	it("returns null when git throws", () => {
		expect(
			branchForHead(() => {
				throw new Error("no git");
			}),
		).toBeNull();
	});
});
