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
	it("returns the first branch pointing at HEAD", () => {
		const runGit = () => "feat/a\nfeat/b\n";
		expect(branchForHead(runGit)).toBe("feat/a");
	});

	it("falls back to rev-parse", () => {
		const runGit = (args: readonly string[]) =>
			args[0] === "for-each-ref" ? "" : "main\n";
		expect(branchForHead(runGit)).toBe("main");
	});

	it("returns null on a detached HEAD", () => {
		const runGit = (args: readonly string[]) =>
			args[0] === "for-each-ref" ? "" : "HEAD\n";
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
