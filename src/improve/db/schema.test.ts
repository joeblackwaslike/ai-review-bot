import { describe, expect, it } from "vitest";
import {
	classifiedFeedback,
	feedbackIntent,
	findingCatalog,
	proposals,
	qcRuns,
	qcScores,
	rawFeedback,
	trends,
} from "./schema.js";

describe("corpus schema", () => {
	it("exposes all corpus tables", () => {
		for (const t of [
			rawFeedback,
			classifiedFeedback,
			findingCatalog,
			qcScores,
			qcRuns,
			trends,
			proposals,
		]) {
			expect(t).toBeDefined();
		}
	});

	it("declares the feedback_intent enum values", () => {
		expect(feedbackIntent.enumValues).toEqual([
			"downvote",
			"upvote",
			"bug_report",
			"noise",
		]);
	});
});
