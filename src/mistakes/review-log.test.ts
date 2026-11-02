import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelReview } from "../review.js";
import { logReviewRun } from "./capture.js";
import { openMistakeLog } from "./log.js";
import { type AgentReview, MistakeRecord } from "./types.js";

const base = {
	severity: "P2" as const,
	category: "bug" as const,
	confidence: 0.9,
	evidence: "e",
	suppressible: false,
	body: "b",
};

function review(titles: string[]): ModelReview {
	return {
		event: "COMMENT",
		general_findings: titles.map((title) => ({ ...base, title })),
		inline_comments: [],
	};
}

const dirs: string[] = [];

function open() {
	const root = mkdtempSync(join(tmpdir(), "rl-"));
	dirs.push(root);
	return openMistakeLog({
		root,
		owner: "o",
		repo: "r",
		source: "review",
		branch: "b",
	});
}

function lines(path: string): MistakeRecord[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((l) => MistakeRecord.parse(JSON.parse(l)));
}

const common = {
	headSha: "abc",
	scope: "working-tree",
	costUsd: 0.5,
	durationSeconds: 12,
	providers: ["anthropic"],
	models: ["m"],
	reportPath: "docs/code-reviews/x.md",
};

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("logReviewRun", () => {
	it("writes one run record then one finding per agent finding", () => {
		const log = open();
		const agentReviews: AgentReview[] = [
			{
				provider: "anthropic",
				model: "m",
				skill: "a",
				review: review(["Keep"]),
			},
			{
				provider: "anthropic",
				model: "m",
				skill: "b",
				review: review(["Lost"]),
			},
		];
		logReviewRun({
			...common,
			log,
			agentsAttempted: 2,
			agentsSucceeded: 2,
			agentReviews,
			merged: review(["keep"]),
			env: { CLAUDE_CODE_SESSION_ID: "sess" },
		});
		const recs = lines(log.path);
		expect(recs.map((r) => r.type)).toEqual(["run", "finding", "finding"]);
		const run = recs[0];
		expect(run).toMatchObject({
			type: "run",
			round: null,
			mergeBase: null,
			partial: false,
			headSha: "abc",
			implementer: { sessionId: "sess", agent: "claude-code" },
		});
		expect(
			recs.slice(1).map((r) => r.type === "finding" && r.survived),
		).toEqual([true, false]);
	});

	it("marks the run partial when some agents failed", () => {
		const log = open();
		logReviewRun({
			...common,
			log,
			agentsAttempted: 3,
			agentsSucceeded: 2,
			agentReviews: [],
			merged: review([]),
			env: {},
		});
		expect(lines(log.path)[0]).toMatchObject({ partial: true });
	});

	it("writes only the run record when zero agents were attempted", () => {
		const log = open();
		logReviewRun({
			...common,
			log,
			agentsAttempted: 0,
			agentsSucceeded: 0,
			agentReviews: [],
			merged: review([]),
			env: {},
		});
		const recs = lines(log.path);
		expect(recs).toHaveLength(1);
		expect(recs[0]).toMatchObject({ type: "run", partial: false });
	});
});
