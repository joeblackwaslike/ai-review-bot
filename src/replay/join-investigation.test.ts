import { describe, expect, it, vi } from "vitest";
import {
	investigateJoin,
	JoinFamilyError,
	type JoinJudge,
	MAX_CLAIMS_PER_CANDIDATE,
} from "./join-investigation.js";
import { claim, makeFixture, makeLabel, makeLabels } from "./testkit.js";
import type { CandidateRecord, ReplayFixture } from "./types.js";

const cand = (
	title: string,
	path: string | null,
	line: number | null,
): CandidateRecord => ({
	skill: "code-reviewer.md",
	title,
	path,
	line,
	severity: "P1",
});

function build(
	candidates: CandidateRecord[],
	claims: ReturnType<typeof claim>[],
) {
	const fixture: ReplayFixture = makeFixture([claims.map((c) => c.id)]);
	fixture.rounds[0] = {
		...(fixture.rounds[0] as ReplayFixture["rounds"][number]),
		claims,
		trace: { candidates, posted: [], usage: {} },
	};
	const labels = makeLabels({
		labels: claims.map((c) => makeLabel(c.id, "fixed")),
	});
	return { fixture, labels };
}

const mk = (id: string, path: string, line: number, title: string) => ({
	...claim(id, 0),
	path,
	line,
	title,
});

const same: JoinJudge = async () => ({ verdict: "same", reason: "r" });

describe("investigateJoin", () => {
	it("counts judge matches the matcher missed and matcher joins", async () => {
		const { fixture, labels } = build(
			[
				cand("Preserve the retry delay schedule", "a.ts", 10),
				cand("Unrelated wording entirely here", "a.ts", 40),
			],
			[mk("c1", "a.ts", 11, "Preserve the retry delay schedule")],
		);
		const judge: JoinJudge = async ({ candidate }) =>
			candidate.line === 40
				? { verdict: "same", reason: "same bug" }
				: { verdict: "same", reason: "same" };
		const r = await investigateJoin({
			fixture,
			labels,
			judge,
			judgeFamily: "openai",
		});
		expect(r.pairs).toHaveLength(2);
		expect(r.matcherJoined).toBe(1);
		expect(r.judgeFoundMatcherMissed).toBe(1);
		expect(r.pairs.map((p) => p.matcherJoined)).toEqual([true, false]);
	});

	it("does not count a different verdict as a miss", async () => {
		const { fixture, labels } = build(
			[cand("Some wording", "a.ts", 40)],
			[mk("c1", "a.ts", 11, "Other thing")],
		);
		const r = await investigateJoin({
			fixture,
			labels,
			judgeFamily: "openai",
			judge: async () => ({ verdict: "different", reason: "no" }),
		});
		expect(r.judgeFoundMatcherMissed).toBe(0);
	});

	it("caps claims per candidate at 3, same path first and nearest line first", async () => {
		const claims = [
			mk("o1", "other.ts", 5, "x"),
			mk("s1", "a.ts", 90, "x"),
			mk("s2", "a.ts", 12, "x"),
			mk("s3", "a.ts", 50, "x"),
			mk("s4", "a.ts", 10, "x"),
		];
		const { fixture, labels } = build(
			[cand("Title here now", "a.ts", 10)],
			claims,
		);
		const judge = vi.fn(same);
		const r = await investigateJoin({
			fixture,
			labels,
			judgeFamily: "openai",
			judge,
			maxCalls: 10,
		});
		expect(MAX_CLAIMS_PER_CANDIDATE).toBe(3);
		expect(judge).toHaveBeenCalledTimes(3);
		expect(r.pairs.map((p) => p.claim.id)).toEqual(["s4", "s2", "s3"]);
	});

	it("defaults the budget to one call per candidate, nearest claim first", async () => {
		const { fixture, labels } = build(
			[cand("First title", "a.ts", 1), cand("Second title", "a.ts", 50)],
			[mk("c1", "a.ts", 1, "z"), mk("c2", "a.ts", 50, "z")],
		);
		const judge = vi.fn(same);
		const r = await investigateJoin({
			fixture,
			labels,
			judge,
			judgeFamily: "openai",
		});
		expect(judge).toHaveBeenCalledTimes(2);
		expect(r.pairs.map((p) => p.claim.id)).toEqual(["c1", "c2"]);
		expect(r.skipped).toBe(2);
	});

	it("dedupes candidates and stops at maxCalls, counting skipped pairs", async () => {
		const { fixture, labels } = build(
			[
				cand("Same title", "a.ts", 1),
				cand("Same title", "a.ts", 1),
				cand("Second title", "a.ts", 2),
				cand("Third title", "a.ts", 3),
			],
			[mk("c1", "a.ts", 2, "z")],
		);
		const judge = vi.fn(same);
		const r = await investigateJoin({
			fixture,
			labels,
			judge,
			judgeFamily: "openai",
			maxCalls: 2,
		});
		expect(judge).toHaveBeenCalledTimes(2);
		expect(r.pairs).toHaveLength(2);
		expect(r.skipped).toBe(1);
	});

	it("passes evidence for the candidate path to the judge", async () => {
		const { fixture, labels } = build(
			[cand("Title here now", "a.ts", 10)],
			[mk("c1", "a.ts", 10, "x")],
		);
		const judge = vi.fn(same);
		await investigateJoin({
			fixture,
			labels,
			judgeFamily: "openai",
			judge,
			evidenceFor: async (path) => `diff of ${path}`,
		});
		expect(judge.mock.calls[0]?.[0].evidence).toBe("diff of a.ts");
	});

	it("throws when the judge family equals the candidate provider", async () => {
		const { fixture, labels } = build(
			[cand("t", "a.ts", 1)],
			[mk("c", "a.ts", 1, "t")],
		);
		await expect(
			investigateJoin({
				fixture,
				labels,
				judge: same,
				judgeFamily: "anthropic",
			}),
		).rejects.toBeInstanceOf(JoinFamilyError);
		await expect(
			investigateJoin({ fixture, labels, judge: same, judgeFamily: "openai" }),
		).resolves.toBeDefined();
	});

	it("rejects a call that omits judgeFamily", async () => {
		const { fixture, labels } = build(
			[cand("t", "a.ts", 1)],
			[mk("c", "a.ts", 1, "t")],
		);
		await expect(
			// @ts-expect-error judgeFamily is required
			investigateJoin({ fixture, labels, judge: same }),
		).rejects.toBeInstanceOf(JoinFamilyError);
	});
});

describe("investigateJoin matcher predicate", () => {
	it("counts a body-text join as matcherJoined, as countJoined does", async () => {
		const c = {
			...mk("c1", "a.ts", 12, "Log condition misses the empty case"),
			text: "A valid prose object with braces can mask the real payload and stop the scan before it",
		};
		const { fixture, labels } = build(
			[cand("Valid prose object braces mask the real payload", "a.ts", 12)],
			[c],
		);
		const r = await investigateJoin({
			fixture,
			labels,
			judge: same,
			judgeFamily: "openai",
		});
		expect(r.matcherJoined).toBe(1);
		expect(r.judgeFoundMatcherMissed).toBe(0);
	});
});
