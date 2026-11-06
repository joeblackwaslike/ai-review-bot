import { describe, expect, it } from "vitest";
import { ledgerEntryFinding } from "../baseline.js";
import type { Ledger } from "../ledger/types.js";
import { shortFindingId } from "../relation.js";
import { REVIEWER_TUNING } from "../reviewer-tuning.js";
import {
	buildInlineComment,
	buildModelReview,
	buildPullFile,
	SIMPLE_PATCH,
	TWO_HUNK_PATCH,
} from "../testing.js";
import { ledgerFromView } from "./pipeline.js";
import { ledgerForRound, postFilterTrace } from "./trace.js";
import type { LabelFile, PostedClaim, ReplayFixture, Round } from "./types.js";

const files = [buildPullFile("src/a.ts", SIMPLE_PATCH)];
const tuning = { ...REVIEWER_TUNING, dropRetractions: false };
const noLedger: Ledger = [];

const general = (title: string, body: string, severity = "P2" as const) => ({
	title,
	body,
	severity,
	category: "bug" as const,
	confidence: 0.9,
	evidence: "See diff.",
	suppressible: true,
});

const inline = (
	title: string,
	over: Parameters<typeof buildInlineComment>[0] = {},
) =>
	buildInlineComment({
		title,
		body: `${title} body.`,
		path: "src/a.ts",
		line: 2,
		...over,
	});

const priorClaim = (
	id: string,
	roundIndex: number,
	title: string,
	text: string,
): PostedClaim => ({
	id,
	roundIndex,
	reviewId: roundIndex + 1,
	source: "inline",
	commentId: 1,
	path: "src/a.ts",
	line: 2,
	severity: "P1",
	title,
	text,
});

const titles = (records: { title: string }[]) => records.map((r) => r.title);

describe("postFilterTrace", () => {
	it("returns nothing for no agent reviews", () => {
		expect(
			postFilterTrace({ agentReviews: [], ledger: noLedger, files, tuning }),
		).toEqual({ posted: [], dropped: [] });
	});

	it("drops a repeat of a settled ledger entry", () => {
		const title = "Token cache never expires";
		const text = "Entries in `tokenCache` are never evicted.";
		const ledger = ledgerFromView({
			priorClaims: [priorClaim("r0:c1:0", 0, title, text)],
			labels: new Map([
				[
					"r0:c1:0",
					{
						claimId: "r0:c1:0",
						label: "rejected",
						confidence: "high",
						evidence: ["2026-10-02T00:00:00Z|Intentional, short-lived."],
						confirmed: true,
					},
				],
			]),
		});
		const fresh = inline("Retry loop never gives up", { line: 3 });

		const trace = postFilterTrace({
			agentReviews: [
				{
					skill: "code-reviewer",
					review: buildModelReview({
						inline_comments: [inline(title, { body: text }), fresh],
					}),
				},
			],
			ledger,
			files,
			tuning,
		});

		expect(trace.posted).toEqual([
			{
				skill: "code-reviewer.md",
				title: fresh.title,
				path: "src/a.ts",
				line: 3,
				severity: "P2",
			},
		]);
		expect(trace.dropped).toEqual([
			{
				skill: "code-reviewer.md",
				title,
				path: "src/a.ts",
				line: 2,
				severity: "P2",
			},
		]);
	});

	it("drops retraction filler only when dropRetractions is on", () => {
		const filler = general(
			"Stale comment",
			"The comment mentions the old name. No issues found.",
		);
		const agentReviews = [
			{
				skill: "code-reviewer",
				review: buildModelReview({
					general_findings: [{ ...filler, severity: "P3" }],
				}),
			},
		];

		const on = postFilterTrace({
			agentReviews,
			ledger: noLedger,
			files,
			tuning: { ...tuning, dropRetractions: true },
		});
		const off = postFilterTrace({
			agentReviews,
			ledger: noLedger,
			files,
			tuning,
		});

		expect(titles(on.posted)).toEqual([]);
		expect(titles(on.dropped)).toEqual(["Stale comment"]);
		expect(titles(off.posted)).toEqual(["Stale comment"]);
		expect(off.dropped).toEqual([]);
	});

	it("collapses a restatement pair from two agents into one posted item", () => {
		const claim = inline("Retry loop never gives up");

		const trace = postFilterTrace({
			agentReviews: [
				{
					skill: "code-reviewer",
					review: buildModelReview({ inline_comments: [claim] }),
				},
				{
					skill: "silent-failure-hunter",
					review: buildModelReview({ inline_comments: [{ ...claim }] }),
				},
			],
			ledger: noLedger,
			files,
			tuning,
		});

		expect(trace.posted).toEqual([
			{
				skill: "code-reviewer.md",
				title: claim.title,
				path: "src/a.ts",
				line: 2,
				severity: "P2",
			},
		]);
		expect(trace.dropped).toEqual([
			{
				skill: "silent-failure-hunter.md",
				title: claim.title,
				path: "src/a.ts",
				line: 2,
				severity: "P2",
			},
		]);
	});

	it("drops an off-diff P2 and posts an off-diff P0 as a general finding", () => {
		const offP2 = inline("Unchecked index", { line: 9, severity: "P2" });
		const offP0 = inline("SQL built from input", {
			path: "src/other.ts",
			line: 3,
			severity: "P0",
		});

		const trace = postFilterTrace({
			agentReviews: [
				{
					skill: "security-sast",
					review: buildModelReview({ inline_comments: [offP2, offP0] }),
				},
			],
			ledger: noLedger,
			files,
			tuning,
		});

		expect(trace.posted).toEqual([
			{
				skill: "security-sast.md",
				title: "SQL built from input (`src/other.ts:3`)",
				path: null,
				line: null,
				severity: "P0",
			},
		]);
		expect(trace.dropped).toEqual([
			{
				skill: "security-sast.md",
				title: "Unchecked index",
				path: "src/a.ts",
				line: 9,
				severity: "P2",
			},
		]);
	});

	it("posts at most 50 inline comments, dropping the least severe", () => {
		const comments = Array.from({ length: 52 }, (_, i) =>
			inline(`Nit ${i}`, {
				body: `Variable v${i} should be named for what it holds.`,
				line: (i % 3) + 1,
				severity: i < 2 ? "P3" : "P2",
			}),
		);

		const trace = postFilterTrace({
			agentReviews: [
				{
					skill: "code-reviewer",
					review: buildModelReview({ inline_comments: comments }),
				},
			],
			ledger: noLedger,
			files,
			tuning: { ...tuning, dedupeNearDuplicateClaims: false },
		});

		expect(trace.posted).toHaveLength(50);
		expect(titles(trace.dropped)).toEqual(["Nit 0", "Nit 1"]);
	});
});

describe("postFilterTrace anchors and relations", () => {
	it("posts a comment on a numbered line in the diff and drops a P2 on a line outside it", () => {
		const onDiff = inline("Added branch skips validation", {
			path: "src/b.ts",
			line: 10,
		});
		const offDiff = inline("Loop bound is off by one", {
			path: "src/b.ts",
			line: 6,
			severity: "P2",
		});

		const trace = postFilterTrace({
			agentReviews: [
				{
					skill: "code-reviewer",
					review: buildModelReview({ inline_comments: [onDiff, offDiff] }),
				},
			],
			ledger: noLedger,
			files: [buildPullFile("src/b.ts", TWO_HUNK_PATCH)],
			tuning,
		});

		expect(trace.posted).toEqual([
			{
				skill: "code-reviewer.md",
				title: onDiff.title,
				path: "src/b.ts",
				line: 10,
				severity: "P2",
			},
		]);
		expect(trace.dropped).toEqual([
			{
				skill: "code-reviewer.md",
				title: offDiff.title,
				path: "src/b.ts",
				line: 6,
				severity: "P2",
			},
		]);
	});

	it("does not honour a declared relation, since replay shows the agents no ids", () => {
		const ledger = ledgerFromView({
			priorClaims: [
				{
					...priorClaim(
						"r0:c1:0",
						0,
						"Token cache never expires",
						"Entries in `tokenCache` are never evicted.",
					),
					line: 40,
				},
			],
			labels: new Map([
				[
					"r0:c1:0",
					{
						claimId: "r0:c1:0",
						label: "rejected",
						confidence: "high",
						evidence: ["2026-10-02T00:00:00Z|Intentional."],
						confirmed: true,
					},
				],
			]),
		});
		const [entry] = ledger;
		const plain = inline("Token cache never expires after logout", {
			body: "Logout leaves the session alive in the store.",
			severity: "P1",
		});
		const declared = {
			...plain,
			relation: {
				kind: "repeats" as const,
				entry_id: shortFindingId(
					ledgerEntryFinding(entry as Ledger[number]).id,
				),
			},
		};
		const run = (c: typeof plain) =>
			postFilterTrace({
				agentReviews: [
					{
						skill: "code-reviewer",
						review: buildModelReview({ inline_comments: [c] }),
					},
				],
				ledger,
				files,
				tuning,
			});

		expect(titles(run(plain).posted)).toEqual([plain.title]);
		expect(run(declared)).toEqual(run(plain));
	});
});

describe("ledgerForRound", () => {
	const round = (index: number, claims: PostedClaim[]): Round => ({
		index,
		reviewId: index + 1,
		provider: "anthropic",
		submittedAt: `2026-10-0${index + 1}T12:00:00Z`,
		headSha: `h${index}`,
		baseSha: "b",
		mergeBase: null,
		triggerAt: `2026-10-0${index + 1}T11:00:00Z`,
		approximate: false,
		commitsSince: [],
		claims,
	});

	it("builds the ledger from earlier rounds with labels visible before the round", () => {
		const fixture = {
			rounds: [
				round(0, [priorClaim("r0:c1:0", 0, "Cache never expires", "a")]),
				round(1, [priorClaim("r1:c2:0", 1, "Retry loop never stops", "b")]),
				round(2, [priorClaim("r2:c3:0", 2, "Later claim", "c")]),
			],
		} as unknown as ReplayFixture;
		const labels = {
			labels: [
				{
					claimId: "r0:c1:0",
					label: "rejected",
					confidence: "high",
					evidence: ["2026-10-01T18:00:00Z|Intentional."],
					confirmed: true,
				},
				{
					claimId: "r1:c2:0",
					label: "fixed",
					confidence: "high",
					evidence: ["2026-10-05T00:00:00Z|Fixed later."],
					confirmed: true,
				},
			],
		} as unknown as LabelFile;

		const ledger = ledgerForRound(fixture, labels, fixture.rounds[2] as Round);

		expect(ledger.map((e) => [e.id, e.status])).toEqual([
			["r0:c1:0", "rejected"],
			["r1:c2:0", "open"],
		]);
	});
});
