import { generateObject } from "ai";
import { z } from "zod";
import type { ResolvedAuth } from "../auth.js";
import { createAIModel } from "../models.js";
import type { ModelSelection } from "../router.js";

export const FEEDBACK_INTENTS = [
	"downvote",
	"upvote",
	"bug_report",
	"noise",
] as const;
export type FeedbackIntent = (typeof FEEDBACK_INTENTS)[number];

export const ClassifySchema = z.object({
	items: z.array(
		z.object({
			id: z.number().int(),
			intent: z.enum(FEEDBACK_INTENTS),
			isBotRelated: z.boolean(),
			confidence: z.number().min(0).max(1),
		}),
	),
});

export type ClassifyOutput = z.infer<typeof ClassifySchema>;

/** One finding plus everything a reviewer said about it. A reaction is
 * classified together with its reply, never alone: 😕 marks that a finding did
 * not land, and only the reply says whether it was factually wrong, correct but
 * badly explained, or simply not worth acting on. */
export interface FeedbackBundle {
	rawFeedbackId: number;
	findingTitle: string;
	verdict: string | null;
	replyBody: string | null;
}

export interface ClassifiedFeedback {
	rawFeedbackId: number;
	intent: FeedbackIntent;
	isBotRelated: boolean;
	confidence: number;
	model: string;
}

/** Longest reply text sent to the classifier. Replies here are a few hundred
 * characters; the cap exists so one pathological reply cannot crowd a whole
 * batch out of the context window. Truncation is reported, not silent — see
 * ClassifyRun.truncated. */
export const REPLY_CHAR_LIMIT = 1200;

// Replies in this corpus open with an explicit verdict phrase, which is a more
// reliable signal than anything a model infers from the prose that follows.
// Matching it costs nothing and removes the bulk of the work from the LLM.
const DETERMINISTIC_OPENERS: [RegExp, FeedbackIntent][] = [
	[/^\W*\*\*fixed\b/i, "upvote"],
	[/^\W*\*\*(?:correct|verified|agreed|fair)\b/i, "upvote"],
	[/^\W*\*\*(?:stale|already (?:fixed|resolved))\b/i, "bug_report"],
	[/^\W*\*\*(?:false positive|incorrect|wrong)\b/i, "bug_report"],
	[/^\W*\*\*(?:no change|acknowledged|working as intended)\b/i, "downvote"],
	[/^\W*\*\*(?:minor|out of scope|leaving as-is)\b/i, "downvote"],
];

/** Pure: intent from the reply's leading verdict phrase, or null when the reply
 * does not open with one and the model has to read it. */
export function classifyByOpener(
	replyBody: string | null,
): FeedbackIntent | null {
	if (!replyBody) return null;
	const trimmed = replyBody.trimStart();
	for (const [pattern, intent] of DETERMINISTIC_OPENERS) {
		if (pattern.test(trimmed)) return intent;
	}
	return null;
}

/** Pure: intent for a reaction carrying no reply at all. Operates on the stored
 * verdict strings, not the emoji: `"up"`/`"down"` are unambiguous on their own,
 * `"confused"` is not — it is left for the model rather than guessed, since the
 * whole point of that verdict is that the reason lives in the reply. */
export function classifyByVerdict(
	verdict: string | null,
	hasReply: boolean,
): FeedbackIntent | null {
	if (hasReply) return null;
	if (verdict === "up") return "upvote";
	if (verdict === "down") return "downvote";
	return null;
}

/** Pure: fold a model response back onto the bundles it was asked about,
 * dropping items the model invented and marking not-bot-related as noise. */
export function mapClassifierOutput(
	bundles: FeedbackBundle[],
	output: ClassifyOutput,
	model: string,
): ClassifiedFeedback[] {
	const known = new Map(bundles.map((b) => [b.rawFeedbackId, b]));
	const seen = new Set<number>();
	const results: ClassifiedFeedback[] = [];
	for (const item of output.items) {
		if (!known.has(item.id) || seen.has(item.id)) continue;
		seen.add(item.id);
		results.push({
			rawFeedbackId: item.id,
			// Feedback about something other than the bot's finding carries no
			// signal about review quality, whatever the model called it.
			intent: item.isBotRelated ? item.intent : "noise",
			isBotRelated: item.isBotRelated,
			confidence: item.confidence,
			model,
		});
	}
	return results;
}

function buildPrompt(bundles: FeedbackBundle[]): string {
	return [
		"You are classifying a maintainer's feedback on findings raised by an AI code reviewer.",
		"",
		"For each item decide:",
		"- intent: `upvote` the finding was correct and worth raising; `downvote` it was not worth raising (technically true but trivial, out of scope, or deliberate behaviour); `bug_report` the reviewer was factually WRONG (misread the code, reviewed a stale commit, claimed something impossible); `noise` the comment is not about the finding at all.",
		"- isBotRelated: false when the comment discusses something other than the reviewer's finding.",
		"- confidence: 0..1.",
		"",
		"A 😕 (confused) reaction means the finding did not land. The reply says why — read the reply, not the reaction.",
		"Distinguish `downvote` from `bug_report` carefully: downvote means the reviewer was RIGHT but the finding was not useful; bug_report means the reviewer was WRONG.",
		"",
		"Items:",
		...bundles.map((b) =>
			[
				`id: ${b.rawFeedbackId}`,
				`finding: ${b.findingTitle}`,
				`reaction: ${b.verdict ?? "(none)"}`,
				`reply: ${b.replyBody ? b.replyBody.slice(0, REPLY_CHAR_LIMIT) : "(none)"}`,
				"---",
			].join("\n"),
		),
	].join("\n");
}

export const CLASSIFY_BATCH_SIZE = 20;

export interface ClassifyRun {
	classified: ClassifiedFeedback[];
	/** Batches whose model call failed. Their items stay unclassified for the
	 * next run; a non-zero count here means fewer results, not clean results. */
	failedBatches: number;
	/** Bundles whose reply was longer than REPLY_CHAR_LIMIT and was cut. */
	truncated: number;
}

/** Classify a batch of bundles. Deterministic openers and bare 👍/👎 are resolved
 * without a model call; only what remains is sent. Returns classifications for
 * every bundle it could decide — a batch whose model call fails yields the
 * deterministic subset rather than nothing, and the rest stay unclassified for
 * the next run instead of being written with a fabricated intent. */
export async function classifyBundles(
	bundles: FeedbackBundle[],
	selection: ModelSelection,
	auth?: ResolvedAuth,
): Promise<ClassifyRun> {
	const resolved: ClassifiedFeedback[] = [];
	const needsModel: FeedbackBundle[] = [];
	let failedBatches = 0;
	let truncated = 0;

	for (const bundle of bundles) {
		const deterministic =
			classifyByOpener(bundle.replyBody) ??
			classifyByVerdict(bundle.verdict, bundle.replyBody !== null);
		if (deterministic) {
			resolved.push({
				rawFeedbackId: bundle.rawFeedbackId,
				intent: deterministic,
				isBotRelated: true,
				confidence: 1,
				model: "deterministic",
			});
		} else {
			needsModel.push(bundle);
		}
	}

	// Counted over what is actually sent, not over every candidate: a bundle
	// resolved by its opener never reaches the model, so its long reply is never
	// cut and reporting it as truncated would overstate lost context.
	truncated = needsModel.filter(
		(b) => (b.replyBody?.length ?? 0) > REPLY_CHAR_LIMIT,
	).length;

	for (let i = 0; i < needsModel.length; i += CLASSIFY_BATCH_SIZE) {
		const batch = needsModel.slice(i, i + CLASSIFY_BATCH_SIZE);
		try {
			const { object } = await generateObject({
				model: createAIModel(selection, auth),
				schema: ClassifySchema,
				prompt: buildPrompt(batch),
				maxOutputTokens: 4000,
			});
			resolved.push(...mapClassifierOutput(batch, object, selection.model));
		} catch (err) {
			// Deliberately broad: any throw here — provider error, schema mismatch,
			// or a genuine bug in this file — must not abandon the remaining
			// batches. It is counted rather than only logged so a run that
			// classified nothing because every batch threw cannot be mistaken for
			// a run that found nothing to do.
			failedBatches++;
			console.error("classify: batch failed; leaving it unclassified", {
				batchStart: i,
				size: batch.length,
				error:
					err instanceof Error ? `${err.name}: ${err.message}` : String(err),
			});
		}
	}

	return { classified: resolved, failedBatches, truncated };
}
