import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateObject, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { getConfigTree } from "../../config/load.js";
import { isProgrammingError } from "../../improve/qc.js";
import { computeCost, createAIModel } from "../../models.js";
import { stripFrontmatter } from "../../prompt.js";
import { resolveJudgeRole } from "../../roles.js";
import type { ModelSelection } from "../../router.js";
import {
	legacyTierMap,
	outputBudget,
	reasoningProviderOptions,
} from "../../router.js";
import { requireCost } from "../cost.js";
import {
	TRIAGE_CALL_PREFIX,
	TRIAGE_USAGE_KEY,
} from "../experiment/spend-matched-names.js";
import { resolveSelectionAuth } from "../live-wiring.js";
import type { ReviewStrategy, StrategyInput } from "../strategy.js";
import type { Provider, RoundUsage } from "../types.js";
import { A0_IMPLEMENTATION_REVISION } from "./a0.js";
import {
	entriesHash,
	entryHeadings,
	loadEntries,
	MAX_SELECTED,
	selectEntries,
} from "./f1-runbooks.js";
import { estimateSpendMatched, runSpendMatched } from "./spend-matched.js";

const F1_SKILL = "f1-runbook-reviewer.md";
const TRIAGE_SKILL = "f1-triage.md";
const TRIAGE_OUTPUT_TOKENS = 512;
const TRIAGE_MAX_RETRIES = 4;

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
	classifier: ModelSelection = resolveJudgeRole(getConfigTree(), "classifier"),
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
				[classifier.provider, classifier.model, classifier.effort ?? null],
			]),
		)
		.digest("hex")
		.slice(0, 12);
}

export interface TriageResult {
	provider: Provider | undefined;
	ids: string[];
	costUsd: number;
	wallMs: number;
	usage: RoundUsage[string] | undefined;
	failed: boolean;
}

/** Asks the cheap judge model which operations the diff performs; a failed call yields no ids and is flagged. */
export async function triage(
	input: StrategyInput,
	entries: Map<string, string>,
	readSkill: (name: string) => string = readSkillFile,
): Promise<TriageResult> {
	const started = Date.now();
	const selection = resolveJudgeRole(getConfigTree(), "classifier");
	const priced = (u: {
		inputTokens?: number;
		outputTokens?: number;
		inputTokenDetails?: { cacheReadTokens?: number };
	}) => {
		const tokens = {
			promptTokens: u.inputTokens ?? 0,
			completionTokens: u.outputTokens ?? 0,
			cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
		};
		const costUsd = requireCost(
			computeCost(tokens, selection.model),
			selection.model,
		);
		return { tokens, costUsd };
	};
	const skillText = stripFrontmatter(readSkill(TRIAGE_SKILL));
	const operations = entryHeadings(entries)
		.map((h) => `${h.id}: ${h.name}`)
		.join("\n");
	const auth = await resolveSelectionAuth(selection.provider);
	const provider = billedProvider(selection.provider);
	const fixtureId = `${input.fixture.owner}/${input.fixture.repo}`;
	let call: Awaited<ReturnType<typeof generateObject<typeof TriageSchema>>>;
	try {
		call = await generateObject({
			model: createAIModel(selection, auth),
			schema: TriageSchema,
			maxOutputTokens: outputBudget(selection, TRIAGE_OUTPUT_TOKENS),
			maxRetries: TRIAGE_MAX_RETRIES,
			providerOptions: reasoningProviderOptions(selection),
			abortSignal: input.signal,
			prompt: `${skillText}\n${operations}\n\nDiff:\n${input.diff}`,
		});
	} catch (err) {
		if (isProgrammingError(err) || input.signal.aborted) throw err;
		console.error("f1: triage call failed", {
			fixture: fixtureId,
			err,
		});
		const spent =
			NoObjectGeneratedError.isInstance(err) && err.usage
				? priced(err.usage)
				: undefined;
		return {
			ids: [],
			costUsd: spent?.costUsd ?? 0,
			wallMs: Date.now() - started,
			usage: spent?.tokens,
			failed: true,
			provider,
		};
	}
	const returned = [
		...new Set(call.object.operations.flatMap((o) => o.split(/[\s,]+/))),
	].filter(Boolean);
	const unknown = returned.filter((id) => !entries.has(id));
	if (unknown.length)
		console.warn("f1: triage returned unknown ids", {
			fixture: fixtureId,
			unknown,
		});
	const ids = returned.filter((id) => entries.has(id)).slice(0, MAX_SELECTED);
	const { tokens, costUsd } = priced(call.usage);
	return {
		ids,
		costUsd,
		wallMs: Date.now() - started,
		usage: tokens,
		failed: false,
		provider,
	};
}

const billedProvider = (p: string): Provider | undefined =>
	p === "anthropic" || p === "openai" ? p : undefined;

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
			? { [TRIAGE_USAGE_KEY]: picked.usage }
			: {};
		const label = picked.failed
			? "failed"
			: picked.ids.length
				? picked.ids.join(",")
				: "none";
		const result = await runSpendMatched(
			{
				...input,
				budget: {
					...input.budget,
					maxWallMs: Math.max(0, input.budget.maxWallMs - picked.wallMs),
				},
			},
			{
				skill: F1_SKILL,
				label: "f1",
				ref: "replay-f1",
				customPrompt: selectEntries(entries, picked.ids),
				extraUsage: usage,
				extraToolCalls: [
					{
						name: `${TRIAGE_CALL_PREFIX}${label}`,
						...(picked.provider ? { provider: picked.provider } : {}),
						wallMs: picked.wallMs,
						costUsd: picked.costUsd,
					},
				],
			},
		);
		return { ...result, wallMs: result.wallMs + picked.wallMs };
	},
};
