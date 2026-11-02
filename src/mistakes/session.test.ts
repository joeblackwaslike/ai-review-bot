import { describe, expect, it } from "vitest";
import { branchForHead, headShaFor, implementerFromEnv } from "./session.js";

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
	const REV_PARSE = ["rev-parse", "--abbrev-ref", "HEAD"];
	const SYMBOLIC = ["symbolic-ref", "--quiet", "--short", "HEAD"];
	const POINTS_AT = [
		"for-each-ref",
		"--points-at",
		"HEAD",
		"--format=%(refname:short)",
		"refs/heads/",
	];
	const stub =
		(answers: Array<[readonly string[], string | Error]>) =>
		(args: readonly string[]) => {
			const hit = answers.find(([argv]) => argv.join("\0") === args.join("\0"));
			if (!hit) throw new Error(`unexpected git ${args.join(" ")}`);
			if (hit[1] instanceof Error) throw hit[1];
			return hit[1];
		};

	it("returns the current branch", () => {
		expect(branchForHead(stub([[REV_PARSE, "feature\n"]]))).toBe("feature");
	});

	it("falls back to the first branch pointing at HEAD when detached", () => {
		const runGit = stub([
			[REV_PARSE, "HEAD\n"],
			[POINTS_AT, "feat/a\nfeat/b\n"],
		]);
		expect(branchForHead(runGit)).toBe("feat/a");
	});

	it("returns null on a detached HEAD with no branch", () => {
		const runGit = stub([
			[REV_PARSE, "HEAD\n"],
			[POINTS_AT, ""],
		]);
		expect(branchForHead(runGit)).toBeNull();
	});

	it("reads the branch name of an unborn repository via symbolic-ref", () => {
		const runGit = stub([
			[REV_PARSE, new Error("ambiguous argument 'HEAD'")],
			[SYMBOLIC, "main\n"],
		]);
		expect(branchForHead(runGit)).toBe("main");
	});

	it("returns null when git throws", () => {
		expect(
			branchForHead(() => {
				throw new Error("no git");
			}),
		).toBeNull();
	});
});

describe("headShaFor", () => {
	it("records the reviewed commit for a commit scope", () => {
		expect(headShaFor({ kind: "commit", sha: "abc123" }, "headsha")).toBe(
			"abc123",
		);
	});

	it("records HEAD for the other scopes", () => {
		expect(headShaFor({ kind: "changed" }, "headsha")).toBe("headsha");
		expect(headShaFor({ kind: "full" }, null)).toBe("unknown");
	});
});
