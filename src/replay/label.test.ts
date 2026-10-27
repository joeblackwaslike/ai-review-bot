import { describe, expect, it } from "vitest";
import { fixtureId } from "./claims.js";
import { labelFixture, mergeConfirmations } from "./label.js";
import type {
	CommitMeta,
	LabelFile,
	PostedClaim,
	ReplayFixture,
	Round,
} from "./types.js";

const AUTHOR = "joe";

function claim(over: Partial<PostedClaim> & { id: string }): PostedClaim {
	return {
		roundIndex: 0,
		reviewId: 1,
		source: "inline",
		commentId: 100,
		path: "src/a.ts",
		line: 10,
		severity: "P1",
		title: "Unchecked parseConfig result may throw",
		text: "body",
		...over,
	};
}

function round(
	index: number,
	claims: PostedClaim[],
	commitsSince: CommitMeta[] = [],
): Round {
	return {
		index,
		reviewId: index + 1,
		provider: "anthropic",
		submittedAt: `2026-01-0${index + 1}T00:00:00Z`,
		headSha: "h",
		baseSha: "b",
		mergeBase: null,
		triggerAt: null,
		approximate: false,
		commitsSince,
		claims,
	};
}

function fixture(over: Partial<ReplayFixture> = {}): ReplayFixture {
	return {
		schemaVersion: 1,
		owner: "o",
		repo: "r",
		pull: 7,
		provider: "anthropic",
		author: AUTHOR,
		recordedAt: "2026-02-01T00:00:00Z",
		rounds: [round(0, [claim({ id: "r0:c100:0" })])],
		threads: [],
		reactions: [],
		...over,
	};
}

function thread(
	body: string,
	opts: { author?: string; isOutdated?: boolean; commentId?: number } = {},
) {
	return {
		threadId: "t",
		commentId: opts.commentId ?? 100,
		isResolved: false,
		isOutdated: opts.isOutdated ?? false,
		resolvedBy: null,
		replies: [
			{
				id: 1,
				author: opts.author ?? AUTHOR,
				createdAt: "2026-01-02T00:00:00Z",
				editedAt: null,
				body,
			},
		],
	};
}

const first = (f: ReplayFixture) => labelFixture(f).labels[0];

describe("labelFixture", () => {
	it('labels "Intentional" and "No change" replies as rejected, quoting the reply', () => {
		for (const body of [
			"Intentional, keeps the API stable",
			"No change needed",
		]) {
			const l = first(fixture({ threads: [thread(body)] }));
			expect(l.label).toBe("rejected");
			expect(l.confirmed).toBe(false);
			expect(l.evidence[0]).toBe(`2026-01-02T00:00:00Z|${body}`);
		}
	});

	it('labels "By design" and "Agreed there\'s no defect" as rejected', () => {
		for (const body of ["By design.", "Agreed there's no defect here"]) {
			expect(first(fixture({ threads: [thread(body)] })).label).toBe(
				"rejected",
			);
		}
	});

	it('labels an outdated thread plus a "Fixed in <sha>" reply as fixed with high confidence', () => {
		const l = first(
			fixture({ threads: [thread("Fixed in abc1234", { isOutdated: true })] }),
		);
		expect(l.label).toBe("fixed");
		expect(l.confidence).toBe("high");
	});

	it("labels a changed hunk with no reply or outdated flag as fixed with low confidence", () => {
		const commit: CommitMeta = {
			sha: "deadbeef",
			committedAt: "2026-01-01T12:00:00Z",
			files: [{ path: "src/a.ts", ranges: [[8, 12]] }],
		};
		const f = fixture({
			rounds: [round(0, [claim({ id: "r0:c100:0" })]), round(1, [], [commit])],
		});
		const l = first(f);
		expect(l.label).toBe("fixed");
		expect(l.confidence).toBe("low");
		expect(l.evidence[0]).toContain("2026-01-01T12:00:00Z|");
	});

	it('labels "follow-up" and "out of scope" replies as deferred, not rejected', () => {
		for (const body of ["Will do in a follow-up", "Out of scope for this PR"]) {
			expect(first(fixture({ threads: [thread(body)] })).label).toBe(
				"deferred",
			);
		}
	});

	it("treats a confused or thumbs-down reaction from the PR author as a rejection signal and one from another user as none", () => {
		const react = (user: string, content: string) =>
			fixture({
				reactions: [
					{ commentId: 100, user, content, createdAt: "2026-01-03T00:00:00Z" },
				],
			});
		expect(first(react(AUTHOR, "-1")).label).toBe("rejected");
		expect(first(react(AUTHOR, "confused")).label).toBe("rejected");
		expect(first(react("someone", "-1")).label).toBe("unadjudicated");
	});

	it("ignores replies by non-author accounts", () => {
		const l = first(
			fixture({ threads: [thread("Intentional", { author: "bot" })] }),
		);
		expect(l.label).toBe("unadjudicated");
	});

	it("labels a claim with no evidence unadjudicated", () => {
		const l = first(fixture());
		expect(l.label).toBe("unadjudicated");
		expect(l.evidence).toEqual([]);
	});

	it("proposes a repeat pair for same-path, nearby-line, shared-identifier claims in later rounds, including claims moved to another file when titles match", () => {
		const f = fixture({
			rounds: [
				round(0, [
					claim({ id: "r0:c100:0" }),
					claim({
						id: "r0:c101:0",
						commentId: 101,
						path: "src/x.ts",
						line: 5,
						title: "Missing timeout on fetchRemote call",
					}),
				]),
				round(1, [
					claim({ id: "r1:c200:0", roundIndex: 1, commentId: 200, line: 14 }),
					claim({
						id: "r1:c201:0",
						roundIndex: 1,
						commentId: 201,
						path: "src/y.ts",
						line: 90,
						title: "Missing timeout on fetchRemote call",
					}),
				]),
			],
		});
		const pairs = labelFixture(f).repeatPairs;
		expect(pairs).toContainEqual({
			later: "r1:c200:0",
			earlier: "r0:c100:0",
			confirmed: false,
		});
		expect(pairs).toContainEqual({
			later: "r1:c201:0",
			earlier: "r0:c101:0",
			confirmed: false,
		});
		expect(pairs).toHaveLength(2);
	});

	it("every non-unadjudicated label carries at least one evidence entry formatted <ISO timestamp>|<text> or unknown|<text>", () => {
		const f = fixture({ threads: [thread("By design")] });
		const file = labelFixture(f);
		expect(file.provisional).toBe(true);
		for (const l of file.labels.filter((x) => x.label !== "unadjudicated")) {
			expect(l.evidence.length).toBeGreaterThan(0);
			for (const e of l.evidence) {
				expect(e).toMatch(/^(\d{4}-\d{2}-\d{2}T[^|]+|unknown)\|.+/);
			}
		}
	});
});

describe("labelFixture fixtureId", () => {
	it("uses the canonical fixtureId from claims.ts", () => {
		const f = fixture({
			owner: "joeblackwaslike",
			repo: "stealth-browser",
			pull: 1,
		});
		expect(labelFixture(f).fixtureId).toBe(fixtureId(f));
		expect(labelFixture(f).fixtureId).toBe(
			"joeblackwaslike__stealth-browser__1__anthropic",
		);
	});
});

describe("mergeConfirmations", () => {
	const base = (): LabelFile => ({
		fixtureId: "x",
		provisional: true,
		labels: [
			{
				claimId: "a",
				label: "fixed",
				confidence: "low",
				evidence: ["unknown|x"],
				confirmed: false,
			},
			{
				claimId: "b",
				label: "rejected",
				confidence: "high",
				evidence: ["unknown|y"],
				confirmed: false,
			},
		],
		repeatPairs: [{ later: "b", earlier: "a", confirmed: false }],
		negativePairs: [],
		allowedSuppression: ["b"],
	});

	it("replaces proposals with confirmed edits and clears provisional only when all fixed and allowed-suppression labels are confirmed", () => {
		const edited = base();
		edited.labels[0] = { ...edited.labels[0], confirmed: true };
		edited.repeatPairs[0].confirmed = true;
		let merged = mergeConfirmations(base(), edited);
		expect(merged.labels[0].confirmed).toBe(true);
		expect(merged.repeatPairs[0].confirmed).toBe(true);
		expect(merged.provisional).toBe(true);

		edited.labels[1] = { ...edited.labels[1], confirmed: true };
		merged = mergeConfirmations(base(), edited);
		expect(merged.provisional).toBe(false);
	});

	it("keeps the proposal when the edit is not confirmed", () => {
		const edited = base();
		edited.labels[0] = { ...edited.labels[0], label: "rejected" };
		expect(mergeConfirmations(base(), edited).labels[0].label).toBe("fixed");
	});
});
