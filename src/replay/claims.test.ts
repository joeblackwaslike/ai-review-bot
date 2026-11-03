import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claimTitle, fixtureId, splitInlineClaims } from "./claims.js";
import type { ReplayFixture } from "./types.js";

const FIXTURE_FILE = /^[^.]+\.json$/;
const SEVERITY_WORD = /^(Critical|High|Medium|Low)$/;

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

describe("claimTitle on old-format reviews", () => {
	it.each([
		[
			"🟡 **Medium**\n\n**Preserve the existing retry-delay schedule**\n\n**Required:** This also changes the delay schedule.",
			"Preserve the existing retry-delay schedule",
		],
		[
			"🟢 **Low**\n\n**PR-specific root-cause narrative is likely to rot**\n\nThis doc comment bakes in a lot of incident-specific history.",
			"PR-specific root-cause narrative is likely to rot",
		],
		[
			"🔴 **High**\n\n**z.array(z.string()).length(0) is not a valid Zod API**\n\nZod arrays do not have a `.length()` method.",
			"z.array(z.string()).length(0) is not a valid Zod API",
		],
	])("skips the word severity badge: %#", (text, title) => {
		expect(claimTitle(text)).toBe(title);
	});

	it("falls back to the body's first sentence when only the badge is bold", () => {
		expect(
			claimTitle(
				"🟢 **Low**\n\nThe retry loop never gives up. It spins until the process dies.",
			),
		).toBe("The retry loop never gives up.");
	});

	it("falls back to the first sentence for a P-badged body with no bold title", () => {
		expect(claimTitle("🟠 **P1**\n\nThe loop. More text")).toBe("The loop.");
	});

	it("truncates a long fallback sentence to 100 characters", () => {
		const title = claimTitle(`🟡 **Medium**\n\n${"word ".repeat(60)}end.`);
		expect(title.length).toBeLessThanOrEqual(100);
		expect(title.endsWith("…")).toBe(true);
		expect(title.startsWith("word word")).toBe(true);
	});
});

describe("claimTitle over the committed fixtures", () => {
	const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
	const inlineClaims = readdirSync(dir)
		.filter((n) => FIXTURE_FILE.test(n))
		.flatMap((n) =>
			(
				JSON.parse(readFileSync(join(dir, n), "utf8")) as ReplayFixture
			).rounds.flatMap((r) => r.claims.filter((c) => c.source === "inline")),
		);

	it("covers recorded inline claims", () => {
		expect(inlineClaims.length).toBeGreaterThan(50);
	});

	it("keeps every title that was not a severity word", () => {
		const changed = inlineClaims
			.filter((c) => !SEVERITY_WORD.test(c.title))
			.filter((c) => claimTitle(c.text) !== c.title)
			.map((c) => c.id);
		expect(changed).toEqual([]);
	});

	it("leaves no inline title that is only a severity word", () => {
		const badges = inlineClaims
			.map((c) => claimTitle(c.text))
			.filter((t) => SEVERITY_WORD.test(t));
		expect(badges).toEqual([]);
	});
});

describe("fixtureId", () => {
	it("joins with double underscores", () => {
		expect(
			fixtureId({ owner: "o", repo: "r", pull: 7, provider: "anthropic" }),
		).toBe("o__r__7__anthropic");
	});
});
