import { describe, expect, it } from "vitest";
import { asRecordedPipeline, type ReplayPipeline } from "./pipeline.js";
import { replayFixture, roundCutoff, visibleLabels } from "./replay.js";
import type {
	ClaimLabel,
	LabelFile,
	PostedClaim,
	ReplayFixture,
	Round,
} from "./types.js";

const claim = (id: string, roundIndex: number): PostedClaim => ({
	id,
	roundIndex,
	reviewId: roundIndex,
	source: "inline",
	commentId: null,
	path: "a.ts",
	line: 1,
	severity: "high",
	title: id,
	text: id,
});

const round = (index: number, over: Partial<Round> = {}): Round => ({
	index,
	reviewId: index,
	provider: "anthropic",
	submittedAt: "2026-01-01T12:00:00Z",
	headSha: "h",
	baseSha: "b",
	mergeBase: null,
	triggerAt: null,
	approximate: false,
	commitsSince: [],
	claims: [claim(`c${index}a`, index), claim(`c${index}b`, index)],
	...over,
});

const fixture = (rounds: Round[]): ReplayFixture => ({
	schemaVersion: 1,
	owner: "o",
	repo: "r",
	pull: 1,
	provider: "anthropic",
	author: "me",
	recordedAt: "2026-01-02T00:00:00Z",
	rounds,
	threads: [],
	reactions: [],
});

const label = (claimId: string, evidence: string[]): ClaimLabel => ({
	claimId,
	label: "fixed",
	confidence: "high",
	evidence,
	confirmed: false,
});

const labelFile = (labels: ClaimLabel[]): LabelFile => ({
	fixtureId: "fx",
	provisional: false,
	labels,
	repeatPairs: [],
	negativePairs: [],
	allowedSuppression: [],
});

const cutoff = new Date("2026-01-01T11:00:00Z");

describe("roundCutoff", () => {
	it("is triggerAt when known", () => {
		const r = round(0, { triggerAt: "2026-01-01T11:30:00Z" });
		expect(roundCutoff(r).toISOString()).toBe("2026-01-01T11:30:00.000Z");
	});

	it("is submittedAt minus 15 minutes when triggerAt is null", () => {
		expect(roundCutoff(round(0)).toISOString()).toBe(
			"2026-01-01T11:45:00.000Z",
		);
	});
});

describe("visibleLabels", () => {
	const f = fixture([round(0)]);

	it("hides a label whose evidence is timestamped after the cutoff", () => {
		const lf = labelFile([label("x", ["2026-01-01T11:00:01Z|late"])]);
		expect(visibleLabels(f, lf, cutoff).size).toBe(0);
	});

	it("hides a label with unknown evidence timestamp", () => {
		const lf = labelFile([label("x", ["unknown|resolved"])]);
		expect(visibleLabels(f, lf, cutoff).size).toBe(0);
	});

	it("shows only the visible evidence entries", () => {
		const lf = labelFile([
			label("x", ["2026-01-01T10:00:00Z|early", "2026-01-01T13:00:00Z|late"]),
		]);
		expect(visibleLabels(f, lf, cutoff).get("x")?.evidence).toEqual([
			"2026-01-01T10:00:00Z|early",
		]);
	});

	it("shows an edited reply by its original createdAt", () => {
		const f2 = fixture([round(0)]);
		f2.threads.push({
			threadId: "t",
			commentId: 1,
			isResolved: false,
			isOutdated: false,
			resolvedBy: null,
			replies: [
				{
					id: 1,
					author: "me",
					createdAt: "2026-01-01T10:00:00Z",
					editedAt: "2026-01-01T20:00:00Z",
					body: "fixed",
				},
			],
		});
		const lf = labelFile([label("x", ["2026-01-01T10:00:00Z|fixed"])]);
		expect(visibleLabels(f2, lf, cutoff).has("x")).toBe(true);
	});
});

describe("replayFixture", () => {
	const f = fixture([round(0), round(1), round(2)]);
	const lf = labelFile([]);

	it("passes round N a ledger of claims from earlier rounds only", () => {
		const seen: string[][] = [];
		const spy: ReplayPipeline = (input) => {
			seen.push(input.ledger.priorClaims.map((c) => c.id));
			return asRecordedPipeline(input);
		};
		replayFixture(f, lf, spy);
		expect(seen).toEqual([[], ["c0a", "c0b"], ["c0a", "c0b", "c1a", "c1b"]]);
	});

	it("asRecordedPipeline posts every claim and suppresses none", () => {
		const res = replayFixture(f, lf, asRecordedPipeline);
		expect(res.fixtureId).toBe("fx");
		expect(res.rounds[1]).toEqual({
			index: 1,
			posted: ["c1a", "c1b"],
			suppressed: [],
		});
	});

	it("records a custom pipeline's suppressed ids per round", () => {
		const dropB: ReplayPipeline = ({ claims }) => ({
			posted: claims.filter((c) => !c.id.endsWith("b")).map((c) => c.id),
			suppressed: claims.filter((c) => c.id.endsWith("b")).map((c) => c.id),
		});
		const res = replayFixture(f, lf, dropB);
		expect(res.rounds.map((r) => r.suppressed)).toEqual([
			["c0b"],
			["c1b"],
			["c2b"],
		]);
	});
});
