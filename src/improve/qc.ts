import { generateObject } from "ai";
import { z } from "zod";
import { createAIModel } from "../models.js";
import {
	outputBudget,
	reasoningProviderOptions,
	SEVERITY_LEVELS,
} from "../review.js";
import type { ModelSelection } from "../router.js";

export const QcVerdictSchema = z.object({
	isFalsePositive: z
		.boolean()
		.describe("The claim does not hold against the code shown."),
	isUseful: z.boolean().describe("Worth raising, assuming it is correct."),
	severityCorrect: z.boolean(),
	suggestedSeverity: z.enum(SEVERITY_LEVELS).nullable(),
	rationale: z.string(),
});

export type QcVerdict = z.infer<typeof QcVerdictSchema>;

export interface JudgeableFinding {
	id: number;
	provider: "anthropic" | "openai";
	path: string | null;
	line: number | null;
	title: string;
	severity: string | null;
	/** The finding's explanation, read back from the posted comment. Empty when
	 * the comment could not be fetched, or for general findings that have none. */
	body: string;
}

/** Pure: which findings to judge on a sampled run.
 *
 * Takes a caller-supplied rng rather than a seed, so reproducing a run is the
 * caller's job. Ordered by id so the sample does not depend on the order rows
 * came back from the database. A rate of 1 judges everything; 0 judges nothing. */
export function selectQcSample<T extends { id: number }>(
	findings: T[],
	rate: number,
	rng: () => number,
): T[] {
	if (rate >= 1) return [...findings].sort((a, b) => a.id - b.id);
	if (rate <= 0) return [];
	return [...findings].sort((a, b) => a.id - b.id).filter(() => rng() < rate);
}

/** Judging is a cheap per-finding call, so both providers use their small model
 * rather than whichever one the review itself was routed to.
 *
 * /qc (qc-app.ts) is webhook-only — GitHub App auth, no subscription/OAuth
 * concept anywhere in its call chain — so it stays on the API-key backend.
 * gpt-5.6-luna (GPT-5.6's cheapest tier) is confirmed available there. It's
 * also the model router.ts's trivial tier and triage.ts route to, and — since
 * router.ts/triage.ts no longer split on auth mode — that holds for both the
 * API-key and OAuth/subscription backends, not just the API-key one used here. */
export const QC_OPENAI_MODEL = "gpt-5.6-luna";
export const QC_ANTHROPIC_MODEL = "claude-haiku-4-5";

/** Pure: a finding is judged by the same provider that raised it — not
 * necessarily the same model, since judging always uses the small model above.
 *
 * A cross-provider judge measures disagreement between two models, which is a
 * different question from whether the finding holds — and it would let one
 * provider's style systematically mark down the other's. */
export function judgeSelection(
	provider: "anthropic" | "openai",
): ModelSelection {
	return provider === "openai"
		? { provider: "openai", model: QC_OPENAI_MODEL, effort: "low" }
		: { provider: "anthropic", model: QC_ANTHROPIC_MODEL };
}

function buildJudgePrompt(finding: JudgeableFinding, hunk: string): string {
	return [
		"You are auditing a single finding raised by an AI code reviewer. You are NOT reviewing the code.",
		"",
		"Decide only whether THIS finding holds up:",
		"- isFalsePositive: true when the claim does not hold against the code shown. Reviewing a stale commit, misreading control flow, or asserting behaviour that the code contradicts all count.",
		"- isUseful: true when it is worth raising, ASSUMING it is correct. A true but trivial or out-of-scope observation is not useful.",
		"- severityCorrect / suggestedSeverity: whether the assigned severity matches the actual impact.",
		"",
		"If the code shown is insufficient to evaluate the claim, say so in the rationale and treat it as NOT a false positive — absence of evidence is not evidence the reviewer was wrong.",
		"",
		`Location: ${finding.path ?? "(general)"}${finding.line ? `:${finding.line}` : ""}`,
		`Severity assigned: ${finding.severity ?? "(none)"}`,
		`Finding: ${finding.title}`,
		"",
		finding.body,
		"",
		"Code:",
		hunk || "(no diff hunk available)",
	].join("\n");
}

/** Errors that almost always mean a defect here rather than a provider or
 * network failure — a bad property access or a name that does not resolve.
 *
 * Deliberately narrow. `SyntaxError` and `RangeError` are excluded because the
 * AI SDK raises them for malformed provider responses and oversized payloads,
 * which are exactly the transient failures that should be recorded as unjudged.
 * A `TypeError` from the SDK is possible in principle; failing loudly on a
 * whole run is still the better trade, because the alternative renders a real
 * bug as "every provider call was flaky". */
function isProgrammingError(err: unknown): boolean {
	return err instanceof TypeError || err instanceof ReferenceError;
}

/** Judge one finding with the same provider that raised it. Returns null when
 * the call fails — an unjudged finding is recorded as unjudged rather than as a
 * pass, which would quietly inflate the quality score.
 *
 * Programming errors are rethrown instead: a bug in the prompt builder or a
 * misconfigured model name would otherwise render as "the provider was flaky"
 * on every finding, which is indistinguishable from a real outage. */
export async function judgeFinding(
	finding: JudgeableFinding,
	hunk: string,
): Promise<QcVerdict | null> {
	const selection = judgeSelection(finding.provider);
	try {
		const { object } = await generateObject({
			model: createAIModel(selection),
			schema: QcVerdictSchema,
			prompt: buildJudgePrompt(finding, hunk),
			// Reasoning tokens bill against this budget, so a judge running with an
			// effort level needs headroom or it returns no object at all.
			maxOutputTokens: outputBudget(selection, 1500),
			providerOptions: reasoningProviderOptions(selection),
		});
		return object;
	} catch (err) {
		if (isProgrammingError(err)) throw err;
		console.error("qc: judge call failed", {
			findingId: finding.id,
			provider: finding.provider,
			err,
		});
		return null;
	}
}

export interface QcReport {
	judged: number;
	falsePositives: number;
	notUseful: number;
	severityWrong: number;
	unjudged: number;
	items: { finding: JudgeableFinding; verdict: QcVerdict }[];
	/** The findings that could not be judged, so the report can name them rather
	 * than report a bare count nobody can act on. */
	unjudgedItems: JudgeableFinding[];
}

/** Pure: fold verdicts into a report. */
export function summarize(
	results: { finding: JudgeableFinding; verdict: QcVerdict | null }[],
): QcReport {
	const items = results.filter(
		(r): r is { finding: JudgeableFinding; verdict: QcVerdict } =>
			r.verdict !== null,
	);
	const unjudgedItems = results
		.filter((r) => r.verdict === null)
		.map((r) => r.finding);
	return {
		judged: items.length,
		falsePositives: items.filter((i) => i.verdict.isFalsePositive).length,
		notUseful: items.filter((i) => !i.verdict.isUseful).length,
		severityWrong: items.filter((i) => !i.verdict.severityCorrect).length,
		unjudged: unjudgedItems.length,
		items,
		unjudgedItems,
	};
}

function location(finding: JudgeableFinding): string {
	if (!finding.path) return "general";
	return finding.line ? `${finding.path}:${finding.line}` : finding.path;
}

/** Pure: the comment body. Leads with the count that matters and names the
 * specific findings, since a bare percentage is not actionable. */
export function formatQcComment(prefix: string, report: QcReport): string {
	// Gated on the total, not on `judged`: a provider outage makes every verdict
	// null, which leaves judged at 0 with findings very much present. Reporting
	// "nothing was posted" there would be flatly untrue.
	if (report.judged === 0 && report.unjudgedItems.length === 0) {
		return `### ${prefix}\n\nNothing to judge — no findings were posted on this PR.`;
	}

	if (report.judged === 0) {
		return [
			`### ${prefix}`,
			"",
			`None of the **${report.unjudgedItems.length}** finding(s) on this PR could be judged — every judge call failed. This is a QC outage, not a verdict on the findings.`,
			"",
			...report.unjudgedItems
				.slice(0, 10)
				.map((f) => `- \`${location(f)}\` ${f.title}`),
			...(report.unjudgedItems.length > 10
				? [`- _…and ${report.unjudgedItems.length - 10} more_`]
				: []),
		].join("\n");
	}

	const flagged = report.items.filter(
		(i) => i.verdict.isFalsePositive || !i.verdict.isUseful,
	);

	const lines = [
		`### ${prefix}`,
		"",
		`Judged **${report.judged}** finding(s) with the model that raised them.`,
		"",
		"| | |",
		"|---|---|",
		`| Likely false positives | ${report.falsePositives} |`,
		`| Correct but not worth raising | ${report.notUseful} |`,
		`| Severity mis-assigned | ${report.severityWrong} |`,
	];
	if (report.unjudged > 0) {
		lines.push(`| Could not be judged | ${report.unjudged} |`);
	}

	if (flagged.length > 0) {
		lines.push("", "#### Flagged", "");
		for (const { finding, verdict } of flagged.slice(0, 10)) {
			const label = verdict.isFalsePositive
				? "false positive"
				: "not worth raising";
			lines.push(
				`- **${label}** — \`${location(finding)}\` ${finding.title}`,
				`  > ${verdict.rationale.replace(/\n+/g, " ").slice(0, 260)}`,
			);
		}
		if (flagged.length > 10) {
			lines.push(`- _…and ${flagged.length - 10} more_`);
		}
	}

	if (report.unjudgedItems.length > 0) {
		lines.push("", "#### Could not be judged", "");
		for (const finding of report.unjudgedItems.slice(0, 10)) {
			lines.push(`- \`${location(finding)}\` ${finding.title}`);
		}
		if (report.unjudgedItems.length > 10) {
			lines.push(`- _…and ${report.unjudgedItems.length - 10} more_`);
		}
	}

	lines.push(
		"",
		"_This is a second model auditing the first, not a human verdict. Rate the findings themselves to correct it._",
	);
	return lines.join("\n");
}
