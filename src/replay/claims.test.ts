import { describe, expect, it } from "vitest";
import { fixtureId, splitInlineClaims } from "./claims.js";

const claim = (title: string) =>
	`🟠 **P1**\n\n**${title}**\n\nBody about ${title}.`;

describe("splitInlineClaims", () => {
	it("splits a comment joined by the merge separator into three claims", () => {
		const body = [claim("First"), claim("Second"), claim("Third")].join(
			"\n\n---\n\n",
		);
		const claims = splitInlineClaims(body);
		expect(claims).toHaveLength(3);
		expect(claims[0].title).toBe("First");
		expect(claims[2].title).toBe("Third");
	});

	it("returns one claim for a body with no separator", () => {
		expect(splitInlineClaims(claim("Only"))).toHaveLength(1);
	});

	it("falls back to the first line when there is no bold span", () => {
		expect(splitInlineClaims("plain title\nmore")[0].title).toBe("plain title");
	});
});

describe("fixtureId", () => {
	it("joins with double underscores", () => {
		expect(
			fixtureId({ owner: "o", repo: "r", pull: 7, provider: "anthropic" }),
		).toBe("o__r__7__anthropic");
	});
});
