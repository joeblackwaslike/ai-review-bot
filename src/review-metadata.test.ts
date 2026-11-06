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
	const own = { commentPrefix: "ai-review", reviewer: "claude" };
	const review = (markers: string[] = []) =>
		[
			"<!-- ai-review:post-attempt:1a31033b -->",
			"### ai-review",
			"",
			"Summary.",
			"",
			block,
			...markers.map((m) => `<!-- ai-review:${m} -->`),
			"",
			footer,
		].join("\n");

	it("counts a legacy provider-only review for the mapped reviewer only", () => {
		const body = review(["provider=anthropic"]);
		expect(isOwnReview(body, own)).toBe(true);
		expect(isOwnReview(body, { ...own, reviewer: "codex" })).toBe(false);
		expect(isOwnReview(body, { ...own, reviewer: "gemini" })).toBe(false);
	});

	it("counts a reviewer marker for that reviewer only", () => {
		const body = review(["reviewer=gemini", "provider=gemini"]);
		expect(isOwnReview(body, { ...own, reviewer: "gemini" })).toBe(true);
		expect(isOwnReview(body, own)).toBe(false);
		expect(isOwnReview(body, { ...own, reviewer: "codex" })).toBe(false);
	});

	it("lets the reviewer marker win over a stale provider marker", () => {
		const body = review(["reviewer=claude", "provider=openai"]);
		expect(isOwnReview(body, own)).toBe(true);
		expect(isOwnReview(body, { ...own, reviewer: "codex" })).toBe(false);
	});

	it("counts a review with no marker as ours for any reviewer", () => {
		for (const reviewer of ["claude", "codex", "gemini"])
			expect(isOwnReview(review(), { ...own, reviewer })).toBe(true);
	});

	it("does not count a body without our heading", () => {
		expect(
			isOwnReview(
				review(["provider=anthropic"]).replace("### ai-review", ""),
				own,
			),
		).toBe(false);
		expect(isOwnReview(null, own)).toBe(false);
		expect(isOwnReview(undefined, own)).toBe(false);
	});

	it("does not count a heading that only starts with our prefix", () => {
		expect(
			isOwnReview(
				review(["provider=anthropic"]).replace(
					"### ai-review",
					"### ai-review-qc",
				),
				own,
			),
		).toBe(false);
	});

	it("does not count a human review that quotes our review", () => {
		const quoted = review(["provider=anthropic"])
			.split("\n")
			.map((l) => `> ${l}`)
			.join("\n");
		expect(isOwnReview(`I disagree with this:\n\n${quoted}`, own)).toBe(false);
	});

	it("reads markers from the block, not from a quoted marker in the summary", () => {
		const body = review(["provider=anthropic"]).replace(
			"Summary.",
			"Summary.\n> <!-- ai-review:reviewer=codex -->\n> <!-- ai-review:provider=openai -->",
		);
		expect(isOwnReview(body, own)).toBe(true);
		expect(isOwnReview(body, { ...own, reviewer: "codex" })).toBe(false);
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
