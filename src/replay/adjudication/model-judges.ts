import { generateObject } from "ai";
import { z } from "zod";
import type { ResolvedAuth } from "../../auth.js";
import { createAIModel } from "../../models.js";
import { outputBudget, reasoningProviderOptions } from "../../router.js";
import {
	AUDIT_PROMPT,
	type AuditFinding,
	type AuditInput,
	type AuditJudge,
} from "./audit.js";
import { type JudgeSpec, modelJudge, routeJudges } from "./judge.js";
import type { AdjudicationJudges } from "./run.js";

const AuditSchema = z.object({
	findings: z.array(
		z.object({
			path: z.string().nullable(),
			line: z.number().int().nullable(),
			title: z.string(),
			body: z.string(),
		}),
	),
});

export const MAX_AUDIT_DIFF_CHARS = 60000;

export function modelAuditJudge(
	spec: JudgeSpec,
	auth: ResolvedAuth,
): AuditJudge {
	return {
		family: spec.provider,
		model: spec.model,
		run: async (input: AuditInput): Promise<AuditFinding[]> => {
			if (input.diff.length > MAX_AUDIT_DIFF_CHARS)
				throw new Error(
					`audit diff is ${input.diff.length} characters, over the ${MAX_AUDIT_DIFF_CHARS} limit; the audit was not run so no defect is missed silently`,
				);
			const claims = input.claims
				.map((c) => `- ${c.path ?? "(none)"}:${c.line ?? "?"} ${c.title}`)
				.join("\n");
			const { object } = await generateObject({
				model: createAIModel(spec, auth),
				schema: AuditSchema,
				maxOutputTokens: outputBudget(spec, 2048),
				maxRetries: 0,
				providerOptions: reasoningProviderOptions(spec),
				prompt: `${AUDIT_PROMPT}\n\nClaims already raised:\n${claims || "(none)"}\n\nDiff:\n${input.diff}`,
			});
			return object.findings;
		},
	};
}

/**
 * Resolves credentials lazily and only for the families a run will use, so a run with the OpenAI
 * cap at 0 never authenticates to OpenAI.
 */
export const modelAdjudicationJudges: AdjudicationJudges = {
	async verdictJudges(producer, producerModel, wantSecond) {
		const { resolveAuth } = await import("../../auth.js");
		const route = routeJudges(producer, producerModel);
		const build = async (spec: JudgeSpec) => ({
			family: spec.provider,
			model: spec.model,
			run: modelJudge(spec, await resolveAuth(spec.provider)),
		});
		return {
			first: await build(route.first),
			second: wantSecond && route.second ? await build(route.second) : null,
		};
	},
	async auditJudges(producer, producerModel, wantSecond) {
		const { resolveAuth } = await import("../../auth.js");
		const route = routeJudges(producer, producerModel);
		const build = async (spec: JudgeSpec) =>
			modelAuditJudge(spec, await resolveAuth(spec.provider));
		return {
			judge: await build(route.first),
			second: wantSecond && route.second ? await build(route.second) : null,
		};
	},
};
