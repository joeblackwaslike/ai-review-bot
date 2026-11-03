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

	it.each([
		[
			"🟡 **Medium**\n\ne.g. the retry delay is dropped on restart. More text",
			"e.g. the retry delay is dropped on restart.",
		],
		[
			"🟡 **Medium**\n\ni.e. the retry delay is dropped on restart. More text",
			"i.e. the retry delay is dropped on restart.",
		],
		[
			"🟡 **Medium**\n\nvs. the retry delay is dropped on restart. More text",
			"vs. the retry delay is dropped on restart.",
		],
		[
			"🟡 **Medium**\n\nThe loop vs. the timer is wrong. More",
			"The loop vs. the timer is wrong.",
		],
	])("does not treat an abbreviation period as a sentence end: %#", (text, title) => {
		expect(claimTitle(text)).toBe(title);
	});
});

describe("claimTitle over the committed fixtures", () => {
	const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
	const fixtureFiles = readdirSync(dir).filter((n) => FIXTURE_FILE.test(n));
	const inlineClaims = fixtureFiles.flatMap((n) =>
		(
			JSON.parse(readFileSync(join(dir, n), "utf8")) as ReplayFixture
		).rounds.flatMap((r) =>
			r.claims
				.filter((c) => c.source === "inline")
				.map((c) => ({ ...c, fixture: n.replace(/\.json$/, "") })),
		),
	);

	it("covers recorded inline claims", () => {
		expect(inlineClaims.length).toBeGreaterThan(50);
	});

	// These eight fixtures were recorded before title recovery existed, so their
	// stored titles come from the OLD extraction (badge-or-first-line) and serve
	// as an independent regression oracle for claimTitle.
	const PRE_TITLE_RECOVERY_FIXTURES = new Set([
		"joeblackwaslike__agent-skills__10__anthropic",
		"joeblackwaslike__agent-skills__10__openai",
		"joeblackwaslike__ai-listings__74__anthropic",
		"joeblackwaslike__ai-listings__74__openai",
		"joeblackwaslike__ai-review-bot__92__anthropic",
		"joeblackwaslike__ai-review-bot__92__openai",
		"joeblackwaslike__stealth-browser__1__anthropic",
		"joeblackwaslike__stealth-browser__1__openai",
	]);

	it("keeps every pre-title-recovery title that was not a severity word", () => {
		const changed = inlineClaims
			.filter((c) => PRE_TITLE_RECOVERY_FIXTURES.has(c.fixture))
			.filter((c) => !SEVERITY_WORD.test(c.title))
			.filter((c) => claimTitle(c.text) !== c.title)
			.map((c) => c.id);
		expect(changed).toEqual([]);
	});

	it("recovers the expected title from real claim bodies recorded after title recovery", () => {
		const cases: Array<[string, string]> = [
			[
				"🔴 **High**\n\n**NaN map key from non-numeric LLM response keys**\n\nWhen the LLM returns an object with non-numeric keys (e.g. `\"foo\"`, `\"-1a\"`), `Number(idx)` produces `NaN`. `Map` accepts `NaN` as a key, and any consumer that iterates by numeric index will silently miss those entries or behave unexpectedly. The prior review already flagged this and provided a fix — it has not been applied.\n\n*Suggested fix:*\n\n```suggestion\n  for (const [idx, entry] of Object.entries(parsed)) {\n    const numericIdx = Number(idx)\n    if (!Number.isInteger(numericIdx) || numericIdx < 0) continue\n    const score = entry?.score\n    if (typeof score !== 'number' || !Number.isFinite(score)) continue\n    const color = typeof entry?.color === 'string' ? entry.color : null\n    entries.set(numericIdx, { score, color })\n  }\n```",
				"NaN map key from non-numeric LLM response keys",
			],
			[
				"🟡 **Medium**\n\n**Malformed LLM responses are silently discarded**\n\nThis `catch` turns any parse failure into an empty result with no signal that scoring data was lost. Because callers then persist `null` relevance/color values as if the model simply found nothing, debugging bad prompts, truncated responses, or upstream model regressions becomes much harder. This catch block could hide malformed JSON, unexpectedly wrapped responses, or other parsing bugs while producing apparently successful pricing output. At minimum, emit structured context or rethrow so the failure is observable.",
				"Malformed LLM responses are silently discarded",
			],
			[
				"🟢 **Low**\n\n**lastError typed as unknown thrown without context**\n\nlastError is typed unknown and thrown as-is when all attempts fail. This is correct behavior (propagates the real error), but there's no logging of intermediate attempt failures before the final throw, so debugging why earlier attempts failed (vs. just the last one) has no trace. Not blocking, but consider logging each attempt's failure with attempt number for observability.",
				"lastError typed as unknown thrown without context",
			],
			[
				"🟡 **Medium**\n\n**Preserve the existing retry-delay schedule**\n\n**Required:** This also changes the delay schedule, beyond skipping the final delay. Previously, after the first failure (`attempt === 0`), the retry proceeded after `sleep(0)`; now it waits `baseDelayMs` before the second invocation. For example, with `maxAttempts: 2` and `baseDelayMs: 100`, this adds a 100 ms delay that was not present before. Keep the original multiplier while retaining the `isLastAttempt` guard so this fix does not introduce a timing regression.\n\n*Suggested fix:*\n\n```suggestion\n        await sleep(options.baseDelayMs * attempt);\n```",
				"Preserve the existing retry-delay schedule",
			],
			[
				"🔴 **High**\n\n**z.array(z.string()).length(0) is not a valid Zod API**\n\nZod arrays do not have a `.length()` method. The correct constraint is `z.array(z.string()).max(0)` or `z.tuple([])`. As written this will throw a runtime TypeError when `openFindings` is empty, which is exactly the path the second new test exercises.\n\n*Suggested fix:*\n\n```suggestion\n\t\t\t: z.tuple([]),\n```",
				"z.array(z.string()).length(0) is not a valid Zod API",
			],
			[
				"🟢 **Low**\n\n**PR-specific root-cause narrative is likely to rot**\n\nThis doc comment bakes in a lot of incident-specific history (`PR #69`, exact prompt formatting, downstream consumers, and a one-off live reproduction) that is much more detailed than the implementation itself. That makes it easy for the comment to become partially false the next time the prompt or triage pipeline changes, while future readers still treat it as authoritative. I'd keep the durable invariant here—`resolved` must be restricted to currently open finding IDs so echoed `id — title` strings cannot parse—and move the forensic history to a design note or post-mortem.",
				"PR-specific root-cause narrative is likely to rot",
			],
		];
		for (const [text, title] of cases) {
			expect(claimTitle(text)).toBe(title);
		}
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
