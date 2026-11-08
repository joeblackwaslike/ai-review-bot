import { describe, expect, it } from "vitest";
import {
	buildVerifierPrompt,
	computeVerifierPromptHash,
	VerifierSchema,
} from "./prompt.js";

const input = {
	title: "Token cache never expires",
	path: "src/cache.ts",
	line: 12,
	text: "The cache keeps tokens forever.",
	fileText: "line one\nline two\nline three",
};

describe("VerifierSchema", () => {
	it("accepts a refutation that names its reason", () => {
		expect(
			VerifierSchema.safeParse({
				refuted: true,
				reason: "impossible_path",
				rationale: "the branch is unreachable: line 3 returns first",
			}).success,
		).toBe(true);
	});

	it("accepts a verified finding with no reason", () => {
		expect(
			VerifierSchema.safeParse({
				refuted: false,
				reason: null,
				rationale: "the cache has no expiry",
			}).success,
		).toBe(true);
	});

	it("rejects a refutation without a reason and a verified finding with one", () => {
		expect(
			VerifierSchema.safeParse({
				refuted: true,
				reason: null,
				rationale: "x",
			}).success,
		).toBe(false);
		expect(
			VerifierSchema.safeParse({
				refuted: false,
				reason: "pure_style",
				rationale: "x",
			}).success,
		).toBe(false);
	});

	it("puts the verdict before the reason and rationale in the schema", () => {
		expect(Object.keys(VerifierSchema.shape)).toEqual([
			"refuted",
			"reason",
			"rationale",
		]);
	});
});

describe("buildVerifierPrompt", () => {
	it("shows the finding, its location and the numbered head file", () => {
		const prompt = buildVerifierPrompt(input);
		expect(prompt).toContain("Token cache never expires");
		expect(prompt).toContain("src/cache.ts:12");
		expect(prompt).toContain("The cache keeps tokens forever.");
		expect(prompt).toContain("   1 | line one");
		expect(prompt).toContain("   3 | line three");
	});

	it("tells the model to refute only with counter-evidence from the file", () => {
		expect(buildVerifierPrompt(input)).toMatch(/counter-evidence/i);
	});

	it("cuts an oversized file and says how much it kept", () => {
		const prompt = buildVerifierPrompt(
			{ ...input, fileText: "x".repeat(500) },
			{ maxFileChars: 100 },
		);
		expect(prompt).toContain("[file truncated: 100 of 500 characters shown]");
	});
});

describe("computeVerifierPromptHash", () => {
	it("is a stable hex digest", () => {
		expect(computeVerifierPromptHash()).toMatch(/^[0-9a-f]{64}$/);
		expect(computeVerifierPromptHash()).toBe(computeVerifierPromptHash());
	});

	it("changes when the template changes", () => {
		expect(computeVerifierPromptHash({ template: "other" })).not.toBe(
			computeVerifierPromptHash(),
		);
	});
});
