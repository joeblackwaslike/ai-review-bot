import { describe, expect, it } from "vitest";
import {
	isOwnReview,
	readMetadataBlock,
	readMetadataValue,
} from "./review-metadata.js";

const block = [
	"<!-- ai-review:sha=abc1234 -->",
	"<!-- ai-review:review=2 -->",
	"<!-- ai-review:cost=0.010000 -->",
].join("\n");
const footer =
	"---\n*Model: m · 5 agents · $0.01 · [ai-review-bot](https://x)*";

describe("readMetadataBlock", () => {
	it("reads the block above the footer", () => {
		const body = `### Review\n\nSummary.\n\n${block}\n\n${footer}`;
		const m = readMetadataBlock(body);
		expect(m?.get("sha")).toBe("abc1234");
		expect(m?.get("review")).toBe("2");
		expect(m?.get("cost")).toBe("0.010000");
	});

	it("ignores a quoted marker", () => {
		const body = `> <!-- ai-review:sha=old0000 -->\n\n${block}\n\n${footer}`;
		expect(readMetadataBlock(body)?.get("sha")).toBe("abc1234");
	});

	it("ignores a marker in the middle of summary text", () => {
		const body = `### R\n<!-- ai-review:sha=old0000 -->\nmore text\n\n${block}\n\n${footer}`;
		expect(readMetadataBlock(body)?.get("sha")).toBe("abc1234");
	});

	it("rejects a duplicated key without throwing", () => {
		const dup = `${block}\n<!-- ai-review:sha=other99 -->`;
		const m = readMetadataBlock(`text\n\n${dup}\n\n${footer}`);
		expect(m?.has("sha")).toBe(false);
		expect(m?.get("review")).toBe("2");
	});

	it("returns null for a legacy body with no block", () => {
		expect(
			readMetadataBlock("Reviewed commit: `abc1234`\n\n---\n*Model: m*"),
		).toBeNull();
		expect(readMetadataBlock("> <!-- ai-review:sha=abc1234 -->")).toBeNull();
	});
});

describe("isOwnReview", () => {
	const own = { commentPrefix: "ai-review", provider: "anthropic" };
	const review = (provider?: string) =>
		[
			"<!-- ai-review:post-attempt:1a31033b -->",
			"### ai-review",
			"",
			"Summary.",
			"",
			block,
			...(provider ? [`<!-- ai-review:provider=${provider} -->`] : []),
			"",
			footer,
		].join("\n");

	it("counts a review under our heading from our provider", () => {
		expect(isOwnReview(review("anthropic"), own)).toBe(true);
	});

	it("does not count the other provider's review under the same heading", () => {
		expect(isOwnReview(review("openai"), own)).toBe(false);
	});

	it("counts a review with no provider marker as ours", () => {
		expect(isOwnReview(review(), own)).toBe(true);
	});

	it("does not count a body without our heading", () => {
		expect(
			isOwnReview(review("anthropic").replace("### ai-review", ""), own),
		).toBe(false);
		expect(isOwnReview(null, own)).toBe(false);
		expect(isOwnReview(undefined, own)).toBe(false);
	});

	it("does not count a heading that only starts with our prefix", () => {
		expect(
			isOwnReview(
				review("anthropic").replace("### ai-review", "### ai-review-qc"),
				own,
			),
		).toBe(false);
	});

	it("does not count a human review that quotes our review", () => {
		const quoted = review("anthropic")
			.split("\n")
			.map((l) => `> ${l}`)
			.join("\n");
		expect(isOwnReview(`I disagree with this:\n\n${quoted}`, own)).toBe(false);
	});

	it("reads the provider from the block, not from a quoted marker in the summary", () => {
		const body = review("anthropic").replace(
			"Summary.",
			"Summary.\n> <!-- ai-review:provider=openai -->",
		);
		expect(isOwnReview(body, own)).toBe(true);
		expect(isOwnReview(body, { ...own, provider: "openai" })).toBe(false);
	});
});

describe("readMetadataValue", () => {
	it("falls back to whole-body search only when there is no block", () => {
		expect(readMetadataValue("x <!-- ai-review:sha=abc1234 --> y", "sha")).toBe(
			"abc1234",
		);
		expect(
			readMetadataValue(`> <!-- ai-review:review=9 -->\n\n${block}`, "review"),
		).toBe("2");
	});
});
