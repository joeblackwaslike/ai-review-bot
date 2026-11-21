import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateObject } from "ai";
import { z } from "zod";
import { getConfigTree } from "../../config/load.js";
import { computeCost, createAIModel } from "../../models.js";
import { resolveJudgeRole } from "../../roles.js";
import {
	legacyTierMap,
	outputBudget,
	reasoningProviderOptions,
} from "../../router.js";
import { requireCost } from "../cost.js";
import { resolveSelectionAuth } from "../live-wiring.js";
import type { ReviewStrategy, StrategyInput } from "../strategy.js";
import type { RoundUsage } from "../types.js";
import { A0_IMPLEMENTATION_REVISION } from "./a0.js";
import {
	entriesHash,
	entryHeadings,
	loadEntries,
	selectEntries,
} from "./f1-runbooks.js";
import { estimateSpendMatched, runSpendMatched } from "./spend-matched.js";

const F1_SKILL = "f1-runbook-reviewer.md";
const TRIAGE_SKILL = "f1-triage.md";
const MAX_SELECTED = 4;
const TRIAGE_OUTPUT_TOKENS = 512;

const TriageSchema = z.object({ operations: z.array(z.string()) });

const skillsDir = fileURLToPath(new URL("../../../skills", import.meta.url));
const readSkillFile = (name: string): string =>
	readFileSync(`${skillsDir}/${name}`, "utf8");

/** Bump when run or estimateCost behavior changes, so stored cells go stale. */
export const F1_IMPLEMENTATION_REVISION = 1;

export function strategyF1Version(
	readSkill: (name: string) => string,
	entriesDigest: string,
	revision: number = F1_IMPLEMENTATION_REVISION,
	a0Revision: number = A0_IMPLEMENTATION_REVISION,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				readSkill(F1_SKILL),
				readSkill(TRIAGE_SKILL),
				entriesDigest,
				legacyTierMap("claude"),
				legacyTierMap("codex"),
				revision,
				a0Revision,
			]),
		)
		.digest("hex")
		.slice(0, 12);
}

export interface TriageResult {
	ids: string[];
	costUsd: number;
	wallMs: number;
	usage: RoundUsage[string] | undefined;
}

/** Asks the cheap judge model which operations the diff performs; any failure yields no ids. */
export async function triage(
	input: StrategyInput,
	entries: Map<string, string>,
): Promise<TriageResult> {
	const started = Date.now();
	const none = (): TriageResult => ({
		ids: [],
		costUsd: 0,
		wallMs: Date.now() - started,
		usage: undefined,
	});
	try {
		const selection = resolveJudgeRole(getConfigTree(), "classifier");
		const auth = await resolveSelectionAuth(selection.provider);
		const operations = entryHeadings(entries)
			.map((h) => `${h.id}: ${h.name}`)
			.join("\n");
		const { object, usage } = await generateObject({
			model: createAIModel(selection, auth),
			schema: TriageSchema,
			maxOutputTokens: outputBudget(selection, TRIAGE_OUTPUT_TOKENS),
			maxRetries: 0,
			providerOptions: reasoningProviderOptions(selection),
			abortSignal: input.signal,
			prompt: `${readSkillFile(TRIAGE_SKILL)}\n${operations}\n\nDiff:\n${input.diff}`,
		});
		const ids = [...new Set(object.operations)]
			.filter((id) => entries.has(id))
			.slice(0, MAX_SELECTED);
		const tokens = {
			promptTokens: usage.inputTokens ?? 0,
			completionTokens: usage.outputTokens ?? 0,
			cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
		};
		const costUsd = requireCost(
			computeCost(tokens, selection.model),
			selection.model,
		);
		return { ids, costUsd, wallMs: Date.now() - started, usage: tokens };
	} catch {
		return none();
	}
}

let cachedVersion: string | undefined;

export const strategyF1: ReviewStrategy = {
	name: "f1",
	get version() {
		cachedVersion ??= strategyF1Version(readSkillFile, entriesHash());
		return cachedVersion;
	},
	needsCheckout: false,
	estimateCost: estimateSpendMatched,
	async run(input) {
		const entries = loadEntries();
		const picked = await triage(input, entries);
		const usage: RoundUsage = picked.usage
			? { [TRIAGE_SKILL]: picked.usage }
			: {};
		return runSpendMatched(input, {
			skill: F1_SKILL,
			label: "f1",
			ref: "replay-f1",
			customPrompt: selectEntries(entries, picked.ids),
			extraUsage: usage,
			extraToolCalls: [
				{
					name: `triage:${picked.ids.length ? picked.ids.join(",") : "none"}`,
					wallMs: picked.wallMs,
					costUsd: picked.costUsd,
				},
			],
		});
	},
};
