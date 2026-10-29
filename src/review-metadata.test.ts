import { describe, expect, it } from "vitest";
import { readMetadataBlock, readMetadataValue } from "./review-metadata.js";

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
