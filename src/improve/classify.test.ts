import { describe, expect, it } from "vitest";
import {
	classifyByOpener,
	classifyByVerdict,
	type FeedbackBundle,
	mapClassifierOutput,
} from "./classify.js";

describe("classifyByOpener", () => {
	// These are verbatim openers from the cc-recall corpus, which is why the
	// deterministic path carries most of the traffic.
	it.each([
		["**Fixed** in `0e0f8f1`, and this was a real bug I introduced.", "upvote"],
		["**Correct, and now materially improved.**", "upvote"],
		["**Verified, no change.** `writeFileSync(fd, content)` …", "upvote"],
		["**Stale — that test no longer exists.**", "bug_report"],
		[
			"**Already fixed in `0e0f8f1`**, which landed before this review ran.",
			"bug_report",
		],
		[
			"**False positive on the stated mechanism** — but there is a real point.",
			"bug_report",
		],
		["**No change — the pre-filter is safe.**", "downvote"],
		[
			"**Acknowledged, out of scope.** Correct about Windows semantics.",
			"downvote",
		],
		["**Minor wording, leaving as-is.**", "downvote"],
	])("reads %j as %s", (body, expected) => {
		expect(classifyByOpener(body)).toBe(expected);
	});

	it("returns null when the reply does not open with a verdict phrase", () => {
		expect(classifyByOpener("I think this might be worth a look?")).toBeNull();
	});

	it("returns null for no reply at all", () => {
		expect(classifyByOpener(null)).toBeNull();
	});

	it("does not confuse 'no change' with a bare mention of change", () => {
		expect(classifyByOpener("**Changed** the guard to cover both paths")).toBe(
			null,
		);
	});
});

describe("classifyByVerdict", () => {
	it("resolves a bare thumbs-up and thumbs-down", () => {
		expect(classifyByVerdict("up", false)).toBe("upvote");
		expect(classifyByVerdict("down", false)).toBe("downvote");
	});

	it("leaves a bare confused reaction to the model rather than guessing", () => {
		expect(classifyByVerdict("confused", false)).toBeNull();
	});

	it("defers entirely when a reply exists, since the reply carries the intent", () => {
		expect(classifyByVerdict("up", true)).toBeNull();
		expect(classifyByVerdict("down", true)).toBeNull();
	});
});

describe("mapClassifierOutput", () => {
	const bundles: FeedbackBundle[] = [
		{
			rawFeedbackId: 1,
			findingTitle: "t1",
			verdict: "confused",
			replyBody: "…",
		},
		{
			rawFeedbackId: 2,
			findingTitle: "t2",
			verdict: "confused",
			replyBody: "…",
		},
	];

	it("maps items back onto their bundles", () => {
		const out = mapClassifierOutput(
			bundles,
			{
				items: [
					{ id: 1, intent: "bug_report", isBotRelated: true, confidence: 0.9 },
				],
			},
			"m",
		);
		expect(out).toEqual([
			{
				rawFeedbackId: 1,
				intent: "bug_report",
				isBotRelated: true,
				confidence: 0.9,
				model: "m",
			},
		]);
	});

	it("forces noise when the model says the comment is not about the finding", () => {
		const out = mapClassifierOutput(
			bundles,
			{
				items: [
					{ id: 1, intent: "upvote", isBotRelated: false, confidence: 0.8 },
				],
			},
			"m",
		);
		expect(out[0].intent).toBe("noise");
	});

	it("drops ids the model invented", () => {
		const out = mapClassifierOutput(
			bundles,
			{
				items: [
					{ id: 999, intent: "upvote", isBotRelated: true, confidence: 1 },
				],
			},
			"m",
		);
		expect(out).toEqual([]);
	});

	it("keeps only the first classification when the model repeats an id", () => {
		const out = mapClassifierOutput(
			bundles,
			{
				items: [
					{ id: 1, intent: "upvote", isBotRelated: true, confidence: 1 },
					{ id: 1, intent: "downvote", isBotRelated: true, confidence: 0.2 },
				],
			},
			"m",
		);
		expect(out).toHaveLength(1);
		expect(out[0].intent).toBe("upvote");
	});
});
