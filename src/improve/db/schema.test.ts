import { describe, expect, it } from "vitest";
import {
	DISCARD_REASONS,
	DISPOSITIONS,
	OFF_DIFF_CODES,
} from "../../discards.js";
import {
	classifiedFeedback,
	discardCode,
	discardDisposition,
	discardReason,
	feedbackIntent,
	findingCatalog,
	findingDiscards,
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

	it("defines finding_discards with a reason enum matching DISCARD_REASONS", () => {
		expect(findingDiscards).toBeDefined();
		expect(discardReason.enumValues).toEqual([...DISCARD_REASONS]);
	});

	it("declares discardCode and discardDisposition enums matching their constants", () => {
		expect(discardCode.enumValues).toEqual([...OFF_DIFF_CODES]);
		expect(discardDisposition.enumValues).toEqual([...DISPOSITIONS]);
	});
});

describe("reviewer identity", () => {
	it("gives the four provider tables a nullable reviewer and a text provider", () => {
		for (const t of [findingCatalog, rawFeedback, qcScores, findingDiscards]) {
			expect(t.reviewer.notNull).toBe(false);
			expect(t.reviewer.dataType).toBe("string");
			expect(t.provider.notNull).toBe(true);
			expect(t.provider.dataType).toBe("string");
			expect(t.provider.getSQLType()).toBe("text");
		}
	});
});
