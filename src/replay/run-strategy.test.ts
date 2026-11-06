import { describe, expect, it } from "vitest";
import type { Ledger } from "../ledger/types.js";
import { REVIEWER_TUNING } from "../reviewer-tuning.js";
import {
	buildInlineComment,
	buildModelReview,
	buildPullFile,
	SIMPLE_PATCH,
} from "../testing.js";
import { runStrategy } from "./run-strategy.js";
import type { ReviewStrategy, StrategyInput } from "./strategy.js";
import { postFilterTrace } from "./trace.js";
import type { CandidateRecord } from "./types.js";

const files = [buildPullFile("src/a.ts", SIMPLE_PATCH)];
const agentReviews = [
	{
		skill: "s1",
		review: buildModelReview({
			inline_comments: [
				buildInlineComment({ title: "Off by one", path: "src/a.ts", line: 2 }),
			],
		}),
	},
];
const bogus: CandidateRecord = {
	skill: "x",
	title: "bogus",
	path: null,
	line: null,
	severity: "P0",
};

const inputWith = (ledger: StrategyInput["history"]["ledger"]): StrategyInput =>
	({
		files,
		history: { ledger },
	}) as StrategyInput;

const emptyLedger: Ledger = [];

const stub = (reviews: typeof agentReviews): ReviewStrategy => ({
	name: "stub",
	version: "1",
	needsCheckout: false,
	estimateCost: () => 0,
	run: async () => ({
		findings: [],
		candidates: [bogus],
		posted: [bogus],
		agentReviews: reviews,
		usage: {},
		toolCalls: [],
		wallMs: 1,
	}),
});

describe("runStrategy", () => {
	it("overrides a strategy's own posted and candidates with the filtered ones", async () => {
		const input = inputWith(emptyLedger);
		const out = await runStrategy(stub(agentReviews), input);
		const expected = postFilterTrace({
			agentReviews,
			ledger: emptyLedger,
			files,
			tuning: REVIEWER_TUNING,
		}).posted;
		expect(expected.length).toBe(1);
		expect(out.posted).toEqual(expected);
		expect(out.candidates).toEqual([
			{
				skill: "s1.md",
				title: "Off by one",
				path: "src/a.ts",
				line: 2,
				severity: expect.anything(),
			},
		]);
	});

	it("posts nothing when agentReviews is empty", async () => {
		const out = await runStrategy(stub([]), inputWith(emptyLedger));
		expect(out.posted).toEqual([]);
		expect(out.candidates).toEqual([]);
	});

	it("applies ledger suppression to a stub strategy", async () => {
		const first = await runStrategy(stub(agentReviews), inputWith(emptyLedger));
		const claim = first.posted[0] as CandidateRecord;
		const ledger: Ledger = [
			{
				id: "e1",
				round: 0,
				path: claim.path,
				line: claim.line,
				title: claim.title,
				body: "Test body.",
				severity: claim.severity ?? "P2",
				status: "rejected",
				decidedBy: "author",
				reason: null,
				evidence: [],
			},
		];
		const out = await runStrategy(stub(agentReviews), inputWith(ledger));
		expect(out.posted).toEqual([]);
		expect(out.candidates).toHaveLength(1);
	});
});
