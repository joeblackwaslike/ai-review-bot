import { describe, expect, it } from "vitest";
import {
	buildJudgePrompt,
	hashPromptTemplate,
	JUDGE_MODELS,
	JudgementSchema,
	PROMPT_HASH,
	PROMPT_TEMPLATE,
	routeJudges,
} from "./judge.js";

const input = (title: string) => ({
	claim: { path: "a.ts", line: 3, title },
	diffEvidence: "+const x = 1;",
});

describe("buildJudgePrompt", () => {
	it("differs between inputs only where the claim differs", () => {
		const a = buildJudgePrompt(input("zzz-a"));
		const b = buildJudgePrompt(input("zzz-b"));
		expect(a.replace("zzz-a", "")).toBe(b.replace("zzz-b", ""));
	});

	it("names no producer, strategy or model family in the template", () => {
		expect(PROMPT_TEMPLATE).not.toMatch(
			/anthropic|openai|claude|gpt|codex|strategy|provider/i,
		);
	});
});

describe("PROMPT_HASH", () => {
	it("hashes the template and changes with it", () => {
		expect(PROMPT_HASH).toBe(hashPromptTemplate(PROMPT_TEMPLATE));
		expect(hashPromptTemplate(`${PROMPT_TEMPLATE} more`)).not.toBe(PROMPT_HASH);
	});
});

describe("JudgementSchema", () => {
	it("rejects a real verdict without scope", () => {
		expect(
			JudgementSchema.safeParse({ verdict: "real", scope: null, reason: "r" })
				.success,
		).toBe(false);
	});

	it("accepts real with scope and not-real without", () => {
		expect(
			JudgementSchema.safeParse({
				verdict: "real",
				scope: "change",
				reason: "r",
			}).success,
		).toBe(true);
		expect(
			JudgementSchema.safeParse({
				verdict: "not-real",
				scope: null,
				reason: "r",
			}).success,
		).toBe(true);
	});

	it("rejects a scope on a verdict that is not real", () => {
		expect(
			JudgementSchema.safeParse({
				verdict: "unclear",
				scope: "moved",
				reason: "r",
			}).success,
		).toBe(false);
	});
});

describe("routeJudges", () => {
	it("judges an anthropic candidate by Anthropic first and OpenAI second", () => {
		const { first, second } = routeJudges("anthropic");
		expect(first).toEqual(JUDGE_MODELS.anthropic);
		expect(second).toEqual(JUDGE_MODELS.openai);
	});

	it("judges an openai candidate by Anthropic only", () => {
		const { first, second } = routeJudges("openai");
		expect(first.provider).toBe("anthropic");
		expect(second).toBeNull();
	});

	it("uses a different Anthropic model when the producer was Opus", () => {
		const { first, second } = routeJudges("anthropic", "claude-opus-5-5");
		expect(first.model).toBe("claude-sonnet-5-5");
		expect(second).toEqual(JUDGE_MODELS.openai);
	});

	it("keeps the strongest model when the producer was Sonnet", () => {
		expect(routeJudges("anthropic", "claude-sonnet-5-5").first).toEqual(
			JUDGE_MODELS.anthropic,
		);
	});
});
