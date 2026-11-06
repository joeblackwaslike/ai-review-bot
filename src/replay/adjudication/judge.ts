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

export const EVIDENCE_CHARS = 8000;

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

function renderEvidence(diffEvidence: string, evidenceChars: number): string {
	if (diffEvidence.length === 0) return "(none available)";
	if (diffEvidence.length <= evidenceChars) return diffEvidence;
	return `${diffEvidence.slice(0, evidenceChars)}\n[patch truncated: ${evidenceChars} of ${diffEvidence.length} chars shown]`;
}

function renderJudgePrompt(
	input: JudgeInput,
	template: string,
	evidenceChars: number,
): string {
	const { claim, diffEvidence } = input;
	return [
		template,
		`Finding: ${claim.title}`,
		`Location: ${claim.path ?? "(none)"}:${claim.line ?? "?"}`,
		`Finding text:\n${claim.body ?? "(none)"}`,
		`Diff evidence:\n${renderEvidence(diffEvidence, evidenceChars)}`,
	].join("\n\n");
}

export function buildJudgePrompt(input: JudgeInput): string {
	return renderJudgePrompt(input, PROMPT_TEMPLATE, EVIDENCE_CHARS);
}

const HASH_SAMPLE: JudgeInput = {
	claim: {
		path: "sample.ts",
		line: 1,
		title: "sample title",
		body: "sample body",
	},
	diffEvidence: "x".repeat(20000),
};

/**
 * Hash of everything that shapes a verdict: the rendered prompt of a fixed sample (template and
 * framing), the evidence limit and the response schema. A change to any of them makes cached
 * verdicts stale. The schema's refinement is code, not data, and is not part of the hash.
 */
export function computePromptHash(
	inputs: {
		template?: string;
		evidenceChars?: number;
		schema?: z.ZodType;
	} = {},
): string {
	const evidenceChars = inputs.evidenceChars ?? EVIDENCE_CHARS;
	return createHash("sha256")
		.update(
			JSON.stringify({
				prompt: renderJudgePrompt(
					HASH_SAMPLE,
					inputs.template ?? PROMPT_TEMPLATE,
					evidenceChars,
				),
				evidenceChars,
				schema: z.toJSONSchema(inputs.schema ?? JudgementSchema),
			}),
		)
		.digest("hex");
}

export const PROMPT_HASH = computePromptHash();

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

const SONNET_JUDGE: JudgeSpec = {
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	effort: "medium",
};

/** Every first-judge model `routeJudges` can pick for a producer family, whatever the producer model. */
export function possibleFirstModels(
	producer: "anthropic" | "openai",
): string[] {
	return producer === "anthropic"
		? [JUDGE_MODELS.anthropic.model, SONNET_JUDGE.model]
		: [JUDGE_MODELS.anthropic.model];
}

/**
 * `producerModel` is the run's routed model id. It only picks the judge and never reaches the
 * prompt. An Anthropic-produced candidate needs a different Anthropic model as first judge, so
 * an Opus producer falls back to Sonnet.
 */
export function routeJudges(
	producer: "anthropic" | "openai",
	producerModel?: string,
): {
	first: JudgeSpec;
	second: JudgeSpec | null;
} {
	if (producer === "openai") {
		return { first: JUDGE_MODELS.anthropic, second: null };
	}
	const first =
		producerModel === JUDGE_MODELS.anthropic.model
			? SONNET_JUDGE
			: JUDGE_MODELS.anthropic;
	return { first, second: JUDGE_MODELS.openai };
}
