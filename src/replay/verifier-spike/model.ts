import { generateObject } from "ai";
import type { ResolvedAuth } from "../../auth.js";
import { computeCost, createAIModel } from "../../models.js";
import {
	type ModelSelection,
	outputBudget,
	reasoningProviderOptions,
} from "../../router.js";
import type { Provider } from "../types.js";
import { buildVerifierPrompt, VerifierSchema } from "./prompt.js";
import type { CallResult } from "./run.js";
import type { SpikeItem, SpikeJudge, Tier } from "./types.js";

const judge = (
	vendor: Provider,
	tier: Tier,
	model: string,
	effort: string,
): SpikeJudge => ({ id: `${vendor}-${tier}`, tier, vendor, model, effort });

/** Cheap and mid tiers per vendor, as the reviewer tiers in .ai-review.yaml define them. */
export const SPIKE_JUDGES: Record<Provider, Record<Tier, SpikeJudge>> = {
	anthropic: {
		cheap: judge("anthropic", "cheap", "claude-haiku-5-5", "low"),
		mid: judge("anthropic", "mid", "claude-sonnet-5-5", "medium"),
	},
	openai: {
		cheap: judge("openai", "cheap", "gpt-6-luna", "none"),
		mid: judge("openai", "mid", "gpt-6.1-sol", "low"),
	},
};

/** The judges for one finding: always the other vendor, one per requested tier. */
export function judgesFor(item: SpikeItem, tiers: Tier[]): SpikeJudge[] {
	const vendor: Provider =
		item.producer === "anthropic" ? "openai" : "anthropic";
	return tiers.map((t) => SPIKE_JUDGES[vendor][t]);
}

export interface ModelCallDeps {
	generate: typeof generateObject;
	resolveAuth: (provider: Provider) => Promise<ResolvedAuth>;
	createModel: typeof createAIModel;
	costOf: typeof computeCost;
}

const defaultDeps = (): ModelCallDeps => ({
	generate: generateObject,
	resolveAuth: async (provider) =>
		(await import("../../auth.js")).resolveAuth(provider),
	createModel: createAIModel,
	costOf: computeCost,
});

/** One verifier call, authenticating each vendor on first use only. */
export function modelCall(
	deps: ModelCallDeps = defaultDeps(),
): (a: {
	judge: SpikeJudge;
	item: SpikeItem;
	fileText: string;
}) => Promise<CallResult> {
	const auths = new Map<Provider, Promise<ResolvedAuth>>();
	return async ({ judge, item, fileText }) => {
		let auth = auths.get(judge.vendor);
		if (!auth) {
			auth = deps.resolveAuth(judge.vendor);
			auths.set(judge.vendor, auth);
		}
		const spec = {
			provider: judge.vendor,
			model: judge.model,
			effort: judge.effort,
		} as ModelSelection;
		const { object, usage } = await deps.generate({
			model: deps.createModel(spec, await auth),
			schema: VerifierSchema,
			maxOutputTokens: outputBudget(spec, 512),
			maxRetries: 1,
			providerOptions: reasoningProviderOptions(spec),
			prompt: buildVerifierPrompt({
				title: item.title,
				path: item.path,
				line: item.line,
				text: item.text,
				fileText,
			}),
		});
		const costUsd =
			deps.costOf(
				{
					promptTokens: usage.inputTokens ?? 0,
					completionTokens: usage.outputTokens ?? 0,
					cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
				},
				judge.model,
			) ?? 0;
		return {
			refuted: object.refuted,
			reason: object.reason,
			rationale: object.rationale,
			costUsd,
		};
	};
}
