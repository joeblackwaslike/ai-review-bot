import { describe, expect, it } from "vitest";
import { findingNaturalKey, parseFindingComment } from "./findings.js";

describe("parseFindingComment", () => {
	it("splits a badged comment into severity, title and body", () => {
		const parsed = parseFindingComment(
			"🟡 **P2**\n\n**directory fsync may fail silently**\n\nOn some platforms `fsyncSync` throws EINVAL.",
		);
		expect(parsed).toEqual({
			severity: "P2",
			title: "directory fsync may fail silently",
			body: "On some platforms `fsyncSync` throws EINVAL.",
		});
	});

	it("recognizes every severity badge the renderer emits", () => {
		const cases: [string, string][] = [
			["🔴 **P0**", "P0"],
			["🟡 **P2**", "P2"],
			["🟢 **P3**", "P3"],
			["⚪ **Unknown**", "Unknown"],
		];
		for (const [badge, severity] of cases) {
			expect(parseFindingComment(`${badge}\n\n**t**\n\nb`)?.severity).toBe(
				severity,
			);
		}
	});

	it("parseFindingComment recovers severity P1 from 🟠 badge", () => {
		const body = "🟠 **P1**\n\n**Unsafe eval**\n\nDetails here.";
		const result = parseFindingComment(body);
		expect(result).not.toBeNull();
		expect(result?.severity).toBe("P1");
	});

	it("parseFindingComment recovers severity P0 from 🔴 badge", () => {
		const body = "🔴 **P0**\n\n**RCE**\n\nDetails.";
		const result = parseFindingComment(body);
		expect(result).not.toBeNull();
		expect(result?.severity).toBe("P0");
	});

	it("parses a comment posted before badges existed, leaving severity null", () => {
		const parsed = parseFindingComment("**older finding**\n\nsome body");
		expect(parsed).toEqual({
			severity: null,
			title: "older finding",
			body: "some body",
		});
	});

	it("keeps the suggestion block as part of the body", () => {
		const parsed = parseFindingComment(
			"🟢 **P3**\n\n**t**\n\nreason\n\n*Suggested fix:*\n\n```suggestion\nx\n```",
		);
		expect(parsed?.body).toContain("```suggestion");
	});

	it("returns null for a comment that is not in the bot's format", () => {
		expect(parseFindingComment("just a plain reply, no title")).toBeNull();
	});

	it("returns null for a badge with no title, rather than inventing one", () => {
		expect(parseFindingComment("🔴 **P0**\n\nbody with no bold title")).toBe(
			null,
		);
	});
});

describe("findingNaturalKey", () => {
	const base = {
		provider: "anthropic",
		owner: "o",
		repo: "r",
		pr: 55,
		commentId: 3687330487,
		path: "src/x.ts",
		title: "a finding",
	};

	it("is stable for identical input", () => {
		expect(findingNaturalKey(base)).toBe(findingNaturalKey(base));
	});

	// GitHub re-anchors a comment to a new line as later commits move the code
	// around it; the identity must not move with it. Asserted one field at a
	// time so a failure names which field leaked into the key.
	it("is unchanged when the comment is re-anchored to a different path", () => {
		expect(findingNaturalKey(base)).toBe(
			findingNaturalKey({ ...base, path: "src/moved.ts" }),
		);
	});

	it("is unchanged when the comment text is edited", () => {
		expect(findingNaturalKey(base)).toBe(
			findingNaturalKey({ ...base, title: "reworded" }),
		);
	});

	it("separates two comments in one file that happen to share a title", () => {
		expect(findingNaturalKey(base)).not.toBe(
			findingNaturalKey({ ...base, commentId: 3687330488 }),
		);
	});

	it("falls back to path and title for a general finding with no comment", () => {
		const general = { ...base, commentId: null };
		expect(findingNaturalKey(general)).not.toBe(
			findingNaturalKey({ ...general, title: "another finding" }),
		);
	});

	it("differs across providers so both bots' findings coexist", () => {
		expect(findingNaturalKey(base)).not.toBe(
			findingNaturalKey({ ...base, provider: "openai" }),
		);
	});

	it("encodes a file-level finding with neither comment nor path", () => {
		expect(
			findingNaturalKey({ ...base, commentId: null, path: null }),
		).toContain("#55::");
	});

	it("still separates a general finding by file", () => {
		const general = { ...base, commentId: null };
		expect(findingNaturalKey(general)).not.toBe(
			findingNaturalKey({ ...general, path: "src/y.ts" }),
		);
	});
});
