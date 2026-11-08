import { describe, expect, it } from "vitest";
import { makeFixture, makeLabel, makeLabels } from "../testkit.js";
import type { CandidateRecord } from "../types.js";
import { scoreChain } from "./chain-score.js";
import type { ScoredFixture } from "./score.js";
import type { StoredCell } from "./store.js";

const C1 = "retry delay skipped before first attempt";
const C2 = "cache key ignores tenant identifier value";

const cand = (title: string, path = "a.ts", line = 1): CandidateRecord => ({
	skill: null,
	title,
	path,
	line,
	severity: null,
});

const fx = (): ScoredFixture => ({
	fixture: makeFixture([[C1], [C2], [C1]], { pull: 1 }),
	labels: makeLabels({
		labels: [makeLabel(C1, "fixed"), makeLabel(C2, "rejected")],
	}),
});

const cell = (round: number, posted: CandidateRecord[]): StoredCell => ({
	key: { strategy: "a", version: "v1", fixtureId: "o/r#1", round, trial: 0 },
	provider: "anthropic",
	planHash: "h",
	at: "t",
	costUsd: 1,
	fitIn210s: true,
	failedAttempts: 0,
	cacheTemperature: "unknown",
	stale: false,
	result: {
		findings: [],
		candidates: posted,
		posted,
		agentReviews: [],
		usage: {},
		toolCalls: [],
		wallMs: 1000,
	},
});

const score = (records: StoredCell[], plannedRounds = 3) =>
	scoreChain({
		strategy: "a",
		fixtureId: "o/r#1",
		records,
		fx: fx(),
		plannedRounds,
	});

describe("scoreChain", () => {
	it("recycling counts a later-round restatement of the strategy's own earlier finding", () => {
		const s = score([
			cell(0, [cand(C1)]),
			cell(1, [cand(C1), cand(C2, "b.ts", 90)]),
			cell(2, []),
		]);
		expect(s.recycling).toBe(0.5);
	});

	it("recycling is null when no later round posted anything", () => {
		const s = score([cell(0, [cand(C1)]), cell(1, []), cell(2, [])]);
		expect(s.recycling).toBeNull();
	});

	it("convergence is the first empty round", () => {
		const s = score([cell(0, [cand(C1)]), cell(1, []), cell(2, [cand(C2)])]);
		expect(s.convergenceRound).toBe(1);
		expect(s.complete).toBe(true);
	});

	it("convergence equals plannedRounds when no round is empty", () => {
		const s = score([
			cell(0, [cand(C1)]),
			cell(1, [cand(C1)]),
			cell(2, [cand(C1)]),
		]);
		expect(s.convergenceRound).toBe(3);
	});

	it("an incomplete chain is flagged and not counted as converged", () => {
		const s = score([cell(0, [cand(C1)]), cell(1, [])]);
		expect(s.complete).toBe(false);
		expect(s.convergenceRound).toBe(3);
	});
});
