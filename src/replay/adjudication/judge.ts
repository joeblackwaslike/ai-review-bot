import { createHash } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import type { ResolvedAuth } from "../../auth.js";
import { createAIModel } from "../../models.js";
import {
	type ModelSelection,
	outputBudget,
	reasoningProviderOptions,
} from "../../router.js";
import type { Scope, Verdict } from "./types.js";

const EVIDENCE_CHARS = 8000;

export interface JudgeClaim {
	path: string | null;
	line: number | null;
	title: string;
	body?: string;
}

export interface JudgeInput {
	claim: JudgeClaim;
	diffEvidence: string;
}

export interface JudgeOutput {
	verdict: Verdict;
	scope: Scope;
	reason: string;
}

export type Judge = (input: JudgeInput) => Promise<JudgeOutput>;
export type JudgeSpec = ModelSelection;

export const JudgementSchema = z
	.object({
		verdict: z.enum(["real", "not-real", "unclear"]),
		scope: z.enum(["change", "moved"]).nullable(),
		reason: z.string(),
	})
	.refine((j) => (j.verdict === "real") === (j.scope !== null), {
		message: "scope is required for a real verdict and null otherwise",
	});

export const PROMPT_TEMPLATE = [
	"You are judging one code review finding against the diff of a pull request.",
	"Decide whether the finding describes a defect or risk that is worth raising in review.",
	"Answer real, not-real or unclear. Use unclear only when the diff cannot settle it.",
	"For a real finding also give the scope: change when the problem comes from code the pull request adds or edits, moved when the code was only moved, renamed or reformatted and the problem was already there.",
	"Give a one-line reason. Judge the finding on its own merits.",
].join("\n");

export const hashPromptTemplate = (template: string): string =>
	createHash("sha256").update(template).digest("hex");

export const PROMPT_HASH = hashPromptTemplate(PROMPT_TEMPLATE);

export function buildJudgePrompt(input: JudgeInput): string {
	const { claim, diffEvidence } = input;
	return [
		PROMPT_TEMPLATE,
		`Finding: ${claim.title}`,
		`Location: ${claim.path ?? "(none)"}:${claim.line ?? "?"}`,
		`Finding text:\n${claim.body ?? "(none)"}`,
		`Diff evidence:\n${diffEvidence.slice(0, EVIDENCE_CHARS) || "(none available)"}`,
	].join("\n\n");
}

export function modelJudge(spec: JudgeSpec, auth: ResolvedAuth): Judge {
	return async (input) => {
		const { object } = await generateObject({
			model: createAIModel(spec, auth),
			schema: JudgementSchema,
			maxOutputTokens: outputBudget(spec, 512),
			maxRetries: 0,
			providerOptions: reasoningProviderOptions(spec),
			prompt: buildJudgePrompt(input),
		});
		return object;
	};
}

/**
 * Model IDs come from the CLAUDE_TIER_MAP and OPENAI_TIER_MAP in src/router.ts and the price
 * table in src/models.ts. Opus is the strongest Anthropic model there; it also serves as the
 * judge for Sonnet-produced candidates, so "a different model" holds for the Sonnet runs.
 */
export const JUDGE_MODELS: Record<"anthropic" | "openai", JudgeSpec> = {
	anthropic: {
		provider: "anthropic",
		model: "claude-opus-5-5",
		effort: "medium",
	},
	openai: { provider: "openai", model: "gpt-6.1-sol", effort: "medium" },
};

export function routeJudges(producer: "anthropic" | "openai"): {
	first: JudgeSpec;
	second: JudgeSpec | null;
} {
	return producer === "anthropic"
		? { first: JUDGE_MODELS.anthropic, second: JUDGE_MODELS.openai }
		: { first: JUDGE_MODELS.anthropic, second: null };
}
