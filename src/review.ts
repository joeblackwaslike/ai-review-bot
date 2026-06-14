import { APICallError } from "@ai-sdk/provider";
import { generateObject } from "ai";
import { z } from "zod";
import { mapWithConcurrency } from "./concurrency.js";
import type { KvClient } from "./feedback/kv.js";
import { computeCost, createAIModel } from "./models.js";
import { buildAgentSystemPrompt, buildUserMessage } from "./prompt.js";
import type { PersistedFinding, ReviewState } from "./review-state.js";
import { findingId, loadReviewState, saveReviewState } from "./review-state.js";
import type { ModelSelection } from "./router.js";
import { routeModel } from "./router.js";
import { detectTier2Skills } from "./tier2.js";
import { fetchDeltaMeta, triageReReview } from "./triage.js";

type OctokitLike = {
	request: <T>(
		route: string,
		params: Record<string, string | number>,
	) => Promise<{ data: T }>;
	paginate: <T>(
		route: string,
		params: Record<string, string | number>,
	) => Promise<T[]>;
};

interface PullFile {
	filename: string;
	status: string;
	patch?: string;
}

interface ReviewContext {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	title: string;
	body: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
	labels: string[];
	commentPrefix: string;
	extraInstructions: string;
	force: boolean;
	provider: "anthropic" | "openai";
	feedbackEnabled: boolean;
	agentConcurrency: number;
	tier2Enabled: boolean;
	/** Upstash KV client for review-state persistence + the triage gate. Reuses
	 * the client maybeSubmitReview already built for the idempotency claim; absent
	 * (null/undefined) when KV is not configured or on a forced re-review, in
	 * which case the gate is skipped and a full review runs (legacy behavior). */
	kv?: KvClient | null;
}

export interface ReviewMetadata {
	model: string;
	tier1Count: number;
	tier2Skills: string[];
	generalFindings: number;
	inlineComments: number;
	cost: number;
}

export interface ReviewDecision {
	event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE" | "RATE_LIMITED";
	body: string;
	comments: ReviewComment[];
	metadata: ReviewMetadata;
	validLinesByPath: Map<string, Set<number>>;
	/** path:line → skills that flagged it + the displayed title. Present only when feedbackEnabled. */
	commentProvenance?: Map<string, { skills: string[]; title: string }>;
	rateLimitResetAt?: string;
	rateLimitRetryAfterSeconds?: number;
}

interface ReviewComment {
	path: string;
	body: string;
	line: number;
	side: "RIGHT";
	start_line?: number;
	start_side?: "RIGHT";
}

interface PullRequestReview {
	body?: string | null;
}

interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
}

export interface RateLimitInfo {
	inputTokensRemaining?: number;
	inputTokensResetAt?: string;
	retryAfterSeconds?: number;
}

export type AgentOutcome =
	| {
			status: "ok";
			review: ModelReview;
			usage: TokenUsage;
			rateLimit?: RateLimitInfo;
	  }
	| { status: "rate_limited"; rateLimit: RateLimitInfo }
	| { status: "error" };

function numOrUndef(v: string | undefined): number | undefined {
	if (v === undefined || v.trim() === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function readRateLimitHeaders(
	headers: Record<string, string> | undefined,
): RateLimitInfo {
	const h = headers ?? {};
	const remaining =
		h["anthropic-ratelimit-input-tokens-remaining"] ??
		h["x-ratelimit-remaining-tokens"];
	const reset =
		h["anthropic-ratelimit-input-tokens-reset"] ??
		h["x-ratelimit-reset-tokens"];
	const retryAfter = h["retry-after"];
	return {
		inputTokensRemaining: numOrUndef(remaining),
		inputTokensResetAt: reset,
		retryAfterSeconds: numOrUndef(retryAfter),
	};
}

/** Walk a thrown error (possibly a RetryError wrapping APICallError) for a 429. */
function extractRateLimit(err: unknown): RateLimitInfo | null {
	const candidates: unknown[] = [
		err,
		(err as { lastError?: unknown })?.lastError,
		...((err as { errors?: unknown[] })?.errors ?? []),
	];
	for (const c of candidates) {
		const status = (c as { statusCode?: number })?.statusCode;
		if (
			status === 429 ||
			(APICallError.isInstance?.(c) && (c as APICallError).statusCode === 429)
		) {
			return readRateLimitHeaders(
				(c as { responseHeaders?: Record<string, string> })?.responseHeaders,
			);
		}
	}
	return null;
}

const ModelReviewSchema = z.object({
	event: z.enum(["COMMENT", "REQUEST_CHANGES"]),
	general_findings: z.array(
		z.object({
			title: z.string(),
			body: z.string(),
			severity: z.enum(["high", "medium", "low"]),
		}),
	),
	inline_comments: z.array(
		z.object({
			title: z.string(),
			body: z.string(),
			path: z.string(),
			line: z.number().int(),
			start_line: z.number().int().nullable(),
			suggestion: z.string().nullable(),
			severity: z.enum(["high", "medium", "low"]),
		}),
	),
});

const SummarySchema = z.object({
	summary: z.string(),
});

export type ModelReview = z.infer<typeof ModelReviewSchema>;

type ModelFinding = ModelReview["general_findings"][number];
type ModelInlineComment = ModelReview["inline_comments"][number];

const SEVERITY_EMOJI: Record<"high" | "medium" | "low", string> = {
	high: "🔴",
	medium: "🟡",
	low: "🟢",
};

const SEVERITY_LABEL: Record<"high" | "medium" | "low", string> = {
	high: "High",
	medium: "Medium",
	low: "Low",
};

// Tier 1: always runs on every PR.
export const TIER1_SKILLS: readonly string[] = [
	"code-reviewer.md",
	"silent-failure-hunter.md",
	"pr-test-analyzer.md",
	"security-sast.md",
	"code-review-and-quality.md",
];

const PACE_TOKEN_FLOOR = 5000; // below this many remaining input tokens, wait for reset
const PACE_MAX_WAIT_MS = 60_000; // never sleep longer than this between agents

export function computePaceDelayMs(
	rl: RateLimitInfo | undefined,
	nowMs: number,
): number {
	if (!rl) return 0;
	if (rl.retryAfterSeconds && rl.retryAfterSeconds > 0) {
		return Math.min(rl.retryAfterSeconds * 1000, PACE_MAX_WAIT_MS);
	}
	if (
		rl.inputTokensRemaining !== undefined &&
		rl.inputTokensRemaining < PACE_TOKEN_FLOOR
	) {
		const parsed = rl.inputTokensResetAt
			? Date.parse(rl.inputTokensResetAt)
			: Number.NaN;
		const resetMs = Number.isFinite(parsed) ? parsed : nowMs + 1000;
		return Math.min(Math.max(0, resetMs - nowMs), PACE_MAX_WAIT_MS);
	}
	return 0;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Maps the tier's effort onto the active provider's reasoning knob:
 *  OpenAI reads `reasoningEffort`, Anthropic reads `effort`. Returns undefined
 *  when no effort is set (e.g. Haiku) so the provider default applies. `"none"`
 *  is a valid OpenAI `reasoningEffort` value (gpt-5.1's explicit non-reasoning
 *  mode) and is forwarded as-is; the Anthropic tiers never emit it. */
function reasoningProviderOptions(
	selection: ModelSelection,
): Record<string, Record<string, string>> | undefined {
	if (!selection.effort) return undefined;
	return selection.provider === "openai"
		? { openai: { reasoningEffort: selection.effort } }
		: { anthropic: { effort: selection.effort } };
}

/** Output-token budget for a generateObject call. Reasoning/thinking tokens are
 * billed against this budget, so once a reasoning level is engaged the cap must
 * cover reasoning + the structured object — too small and the model returns no
 * object at all (AI_NoObjectGeneratedError). The base cap stands when reasoning
 * is off: either no effort at all (e.g. Haiku) or an explicit `"none"` (gpt-5.1's
 * non-reasoning mode), where no reasoning tokens are billed (you pay for actual
 * tokens, not the cap). `"none"` is a truthy string, so it is excluded here
 * explicitly rather than via a plain truthiness check. */
function outputBudget(selection: ModelSelection, base: number): number {
	const reasoning =
		selection.effort !== undefined && selection.effort !== "none";
	return reasoning ? Math.max(base * 8, 16000) : base;
}

export async function runAgent(
	skillPath: string,
	sharedContext: string,
	selection: ModelSelection,
	customPrompt: string,
): Promise<AgentOutcome> {
	const skillBlock = buildAgentSystemPrompt(skillPath, customPrompt);

	try {
		const { object, usage, providerMetadata, response } = await generateObject({
			model: createAIModel(selection),
			schema: ModelReviewSchema,
			maxOutputTokens: outputBudget(selection, 4096),
			maxRetries: 4,
			providerOptions: reasoningProviderOptions(selection),
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: sharedContext,
							providerOptions: {
								anthropic: { cacheControl: { type: "ephemeral" } },
							},
						},
						{ type: "text", text: skillBlock },
					],
				},
			],
		});

		const anthro = (providerMetadata?.anthropic ?? {}) as {
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
		};
		console.log("agent ok", {
			skillPath,
			cacheRead: anthro.cacheReadInputTokens ?? 0,
			cacheCreation: anthro.cacheCreationInputTokens ?? 0,
		});

		return {
			status: "ok",
			review: object,
			usage: {
				promptTokens: usage.inputTokens ?? 0,
				completionTokens: usage.outputTokens ?? 0,
			},
			rateLimit: readRateLimitHeaders(
				response?.headers as Record<string, string> | undefined,
			),
		};
	} catch (err) {
		const rl = extractRateLimit(err);
		if (rl) {
			console.warn("agent rate-limited", { skillPath, ...rl });
			return { status: "rate_limited", rateLimit: rl };
		}
		console.error("Agent threw during generateObject", { skillPath, err });
		return { status: "error" };
	}
}

export function mergeReviews(
	agentResults: ModelReview[],
	resolved: Set<string> = new Set(),
): ModelReview {
	const isResolvedGeneral = (title: string) =>
		resolved.has(`general:${title.toLowerCase().trim()}`);
	const isResolvedInline = (path: string, line: number) =>
		resolved.has(`inline:${path}:${line}`);

	const seenTitles = new Set<string>();
	const general_findings = agentResults
		.flatMap((r) => r.general_findings)
		.filter((f) => {
			if (isResolvedGeneral(f.title)) return false;
			const key = f.title.toLowerCase().trim();
			if (seenTitles.has(key)) return false;
			seenTitles.add(key);
			return true;
		});

	const commentMap = new Map<
		string,
		{ comment: ModelInlineComment; priority: number }
	>();
	for (const review of agentResults) {
		const priority = review.event === "REQUEST_CHANGES" ? 1 : 0;
		for (const comment of review.inline_comments) {
			if (isResolvedInline(comment.path, comment.line)) continue;
			const key = `${comment.path}:${comment.line}`;
			const existing = commentMap.get(key);
			if (!existing || priority > existing.priority) {
				commentMap.set(key, { comment, priority });
			}
		}
	}

	const inline_comments = Array.from(commentMap.values()).map((v) => v.comment);

	// Event is REQUEST_CHANGES only if an UNRESOLVED finding survived the filters
	// above — a lone re-raise of an already-addressed finding no longer blocks.
	const event: "COMMENT" | "REQUEST_CHANGES" =
		general_findings.length > 0 || inline_comments.length > 0
			? agentResults.some((r) => r.event === "REQUEST_CHANGES")
				? "REQUEST_CHANGES"
				: "COMMENT"
			: "COMMENT";

	return { event, general_findings, inline_comments };
}

export async function generateSummary(
	merged: ModelReview,
	selection: ModelSelection,
	context: {
		title: string;
		body: string | null;
		additions: number;
		deletions: number;
		changedFiles: number;
	},
	priorOwnReview: string | null,
): Promise<{ summary: string; usage: TokenUsage }> {
	const findingsList = merged.general_findings
		.map((f) => `- [${f.severity}] ${f.title}: ${f.body}`)
		.join("\n");
	const inlineList = merged.inline_comments
		.map((c) => `- ${c.path}:${c.line} — ${c.title}`)
		.join("\n");

	const priorSection = priorOwnReview
		? [
				"",
				"This is a re-review after new commits were pushed. Here is the previous review summary:",
				priorOwnReview,
				"",
				"Focus your summary on what changed since the last review. Be brief — do not restate the full PR description.",
			].join("\n")
		: "";

	const prompt = [
		`PR: ${context.title}`,
		`Description: ${context.body ?? "[none]"}`,
		`Stats: +${context.additions} -${context.deletions}, ${context.changedFiles} files`,
		"",
		`General findings (${merged.general_findings.length}):`,
		findingsList || "(none)",
		"",
		`Inline comments (${merged.inline_comments.length}):`,
		inlineList || "(none)",
		priorSection,
	].join("\n");

	const system = [
		"You are a senior code reviewer writing a concise review summary for a GitHub pull request.",
		"Synthesize the findings into 1–3 sentences. Highlight the most important issues.",
		"Do not list every finding — the findings table and inline comments already do that.",
		"If there are no findings, say so briefly.",
		priorOwnReview
			? "This is a follow-up review. Summarize only what is new or changed since the last review. Be brief."
			: "",
	]
		.filter(Boolean)
		.join("\n");

	const { object, usage } = await generateObject({
		model: createAIModel(selection),
		schema: SummarySchema,
		maxOutputTokens: outputBudget(selection, 256),
		providerOptions: reasoningProviderOptions(selection),
		system,
		messages: [{ role: "user", content: prompt }],
	});

	return {
		summary: object.summary,
		usage: {
			promptTokens: usage.inputTokens ?? 0,
			completionTokens: usage.outputTokens ?? 0,
		},
	};
}

function formatFindings(findings: ModelFinding[]): string {
	if (findings.length === 0) {
		return "";
	}

	const rows = findings
		.map((f) => `| ${SEVERITY_EMOJI[f.severity]} | **${f.title}** |`)
		.join("\n");

	return `| Sev | Finding |\n|---|---|\n${rows}`;
}

export function collectRightSideLines(patch: string): Set<number> {
	const lines = new Set<number>();
	const patchLines = patch.split("\n");
	let nextRightLine = 0;

	for (const line of patchLines) {
		if (line.startsWith("@@")) {
			const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (!match) {
				continue;
			}
			nextRightLine = Number(match[1]);
			continue;
		}

		if (line.startsWith("+")) {
			lines.add(nextRightLine);
			nextRightLine += 1;
			continue;
		}

		if (line.startsWith(" ")) {
			lines.add(nextRightLine);
			nextRightLine += 1;
		}
	}

	return lines;
}

function buildCommentBody(comment: ModelInlineComment): string {
	const badge = `${SEVERITY_EMOJI[comment.severity]} **${SEVERITY_LABEL[comment.severity]}**`;
	const base = `${badge}\n\n**${comment.title}**\n\n${comment.body}`;
	if (comment.suggestion) {
		return `${base}\n\n*Suggested fix:*\n\n\`\`\`suggestion\n${comment.suggestion}\n\`\`\``;
	}
	return base;
}

export function buildValidLinesByPath(
	files: PullFile[],
): Map<string, Set<number>> {
	const map = new Map<string, Set<number>>();
	for (const file of files) {
		if (!file.patch) continue;
		map.set(file.filename, collectRightSideLines(file.patch));
	}
	return map;
}

export function buildReviewComments(
	files: PullFile[],
	inlineComments: ModelInlineComment[],
): ReviewComment[] {
	const validLinesByPath = buildValidLinesByPath(files);

	return inlineComments.flatMap((comment) => {
		const validLines = validLinesByPath.get(comment.path);
		if (!validLines) {
			console.log("inline comment dropped: path not in diff", {
				path: comment.path,
				line: comment.line,
				knownPaths: Array.from(validLinesByPath.keys()),
			});
			return [];
		}

		if (!validLines.has(comment.line)) {
			console.log(
				"inline comment dropped: line not in valid right-side lines",
				{
					path: comment.path,
					line: comment.line,
					validLines: Array.from(validLines).sort((a, b) => a - b),
				},
			);
			return [];
		}

		if (comment.start_line !== null && comment.start_line >= comment.line) {
			console.log(
				"inline comment dropped: start_line >= line (backwards range)",
				{
					path: comment.path,
					line: comment.line,
					start_line: comment.start_line,
				},
			);
			return [];
		}

		const startLine =
			comment.start_line !== null ? comment.start_line : undefined;
		if (startLine !== undefined && !validLines.has(startLine)) {
			console.log(
				"inline comment dropped: start_line not in valid right-side lines",
				{
					path: comment.path,
					line: comment.line,
					start_line: startLine,
				},
			);
			return [];
		}

		return [
			{
				path: comment.path,
				body: buildCommentBody(comment),
				line: comment.line,
				side: "RIGHT" as const,
				...(startLine !== undefined
					? { start_line: startLine, start_side: "RIGHT" as const }
					: {}),
			},
		];
	});
}

interface CheckRun {
	name: string;
	status: string;
	conclusion: string | null;
}

async function fetchOutstandingChecks(
	octokit: OctokitLike,
	owner: string,
	repo: string,
	headSha: string,
	ownPrefix: string,
): Promise<string[]> {
	try {
		const checkRuns = await octokit.request<{ check_runs: CheckRun[] }>(
			"GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
			{ owner, repo, ref: headSha },
		);
		return checkRuns.data.check_runs
			.filter(
				(run) =>
					!run.name.toLowerCase().includes(ownPrefix.toLowerCase()) &&
					(run.status !== "completed" || run.conclusion === "failure"),
			)
			.map((run) =>
				run.status !== "completed"
					? `${run.name} (${run.status})`
					: `${run.name} (failed)`,
			);
	} catch {
		return [];
	}
}

function buildApprovalMessage(
	isReReview: boolean,
	outstandingChecks: string[],
): string {
	const resolution = isReReview
		? "All issues from the previous review have been resolved."
		: "No issues found.";

	const checksQualifier =
		outstandingChecks.length > 0
			? ` Note: ${outstandingChecks.length} CI check(s) still outstanding: ${outstandingChecks.join(", ")}.`
			: "";

	return `✅ ${resolution} PR approved for merge.${checksQualifier}`;
}

/** Re-stamp the bot's check-run onto the current head SHA carrying the prior
 * verdict, for the SKIP path where no review is posted. createCheckRun (in
 * check-run.ts) only stamps when there are inline annotations, so it can't serve
 * a finding-less SKIP — this posts a minimal completed check-run directly so the
 * PR's status surface still reflects the verdict on the new commit. Best-effort:
 * a failure here must not turn a clean SKIP into an error. */
async function restampCheckRun(
	context: ReviewContext,
	event: ReviewState["event"],
): Promise<void> {
	const conclusion =
		event === "REQUEST_CHANGES"
			? "action_required"
			: event === "APPROVE"
				? "success"
				: "neutral";
	try {
		await context.octokit.request("POST /repos/{owner}/{repo}/check-runs", {
			owner: context.owner,
			repo: context.repo,
			name: context.commentPrefix,
			head_sha: context.headSha,
			status: "completed",
			conclusion,
			output: {
				title: "No re-review needed",
				summary: `${context.commentPrefix}: the new commit doesn't change the review outcome; carrying forward the previous verdict.`,
			},
		} as unknown as Record<string, string | number>);
	} catch (err) {
		console.error("failed to re-stamp check-run on SKIP", { err });
	}
}

export async function buildReview(
	context: ReviewContext,
): Promise<ReviewDecision | null> {
	const reviewMarker = `Reviewed commit: \`${context.headSha.slice(0, 12)}\``;

	// Always fetch existing reviews — used for both idempotency check and
	// cross-bot dedup (collecting what the other bot already reported).
	const existingReviews = (
		await context.octokit.request<PullRequestReview[]>(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{
				owner: context.owner,
				repo: context.repo,
				pull_number: context.pullNumber,
			},
		)
	).data;

	if (!context.force) {
		const alreadyReviewed = existingReviews.some((review) => {
			const body = review.body ?? "";
			return (
				body.includes(reviewMarker) &&
				body.includes(`### ${context.commentPrefix}`)
			);
		});

		if (alreadyReviewed) {
			return null;
		}
	}

	// Collect prior reviews for dedup injection into the prompt.
	// Sister bot (has our "Reviewed commit:" marker): include only if same SHA.
	// External bots (Code Rabbit, etc.): always include — the review delay ensures
	// they've completed before we run.
	const priorBotReviews = existingReviews
		.filter((review) => {
			const body = review.body ?? "";
			if (!body) return false;
			if (body.includes(`### ${context.commentPrefix}`)) return false;
			if (body.includes("Reviewed commit: `")) {
				return body.includes(reviewMarker);
			}
			return true;
		})
		.map((review) => review.body as string);

	const priorOwnReview =
		existingReviews
			.filter((review) => {
				const body = review.body ?? "";
				return (
					body.includes(`### ${context.commentPrefix}`) &&
					body.includes("Reviewed commit: `") &&
					!body.includes(reviewMarker)
				);
			})
			.map((review) => review.body as string)
			.at(-1) ?? null;

	const files = await context.octokit.paginate<PullFile>(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
		{
			owner: context.owner,
			repo: context.repo,
			pull_number: context.pullNumber,
		},
	);

	const customPrompt =
		process.env.CUSTOM_REVIEW_PROMPT ??
		"Focus on correctness, security, regressions, and missing tests.";

	const filePaths = files.map((f) => f.filename);
	const selection = routeModel(
		{
			additions: context.additions,
			deletions: context.deletions,
			filePaths,
			labels: context.labels,
		},
		context.provider,
	);

	// --- Triage gate (re-review only) ---------------------------------------
	// On a re-review (a prior review of this PR exists at an OLDER head SHA), a
	// cheap triage call decides whether to SKIP (post nothing, just re-stamp the
	// check-run), review only the delta (INCREMENTAL), or fall through to a FULL
	// review. resolvedKeys feed mergeReviews so already-fixed findings stop
	// blocking; scopedFiles is the surface the agents actually review.
	// When KV is absent (not configured, or a forced re-review) the gate is
	// skipped entirely and behavior is identical to before this feature.
	const resolvedKeys = new Set<string>();
	let scopedFiles = files; // FULL default
	// Findings to carry into the next persisted state when this run reviews only
	// the delta (INCREMENTAL): prior findings still open after triage (so a clean
	// delta on an unrelated file can't false-APPROVE away a blocking finding the
	// agents never saw) plus resolved tombstones (so future rounds can tell
	// "resolved" from "never existed"). Both stay empty on the FULL/cold path.
	let survivingPrior: PersistedFinding[] = [];
	let resolvedTombstones: PersistedFinding[] = [];
	const state =
		context.kv && !context.force
			? await loadReviewState(
					context.kv,
					context.provider,
					context.owner,
					context.repo,
					context.pullNumber,
					priorOwnReview,
				)
			: null;

	if (
		context.kv &&
		!context.force &&
		state?.lastReviewedSha &&
		state.lastReviewedSha !== context.headSha
	) {
		const openFindings = state.findings.filter((f) => f.status === "open");
		// Single compare-API call: diff string + delta files + truncation flag.
		// The GitHub compare endpoint caps .files at 300 with no pagination and no
		// explicit truncation indicator. When truncated, SKIP/INCREMENTAL would
		// reason over partial data, so we force FULL in that case.
		const deltaMeta = await fetchDeltaMeta(
			context.octokit,
			context.owner,
			context.repo,
			state.lastReviewedSha,
			context.headSha,
		);
		const triage = await triageReReview(
			selection,
			deltaMeta.diff,
			openFindings,
		);

		for (const f of state.findings) {
			if (triage.resolved.includes(f.id)) {
				f.status = "resolved";
				if (f.path && f.line != null) {
					resolvedKeys.add(`inline:${f.path}:${f.line}`);
				}
				resolvedKeys.add(`general:${f.title.toLowerCase().trim()}`);
			}
		}

		if (triage.recommendation === "SKIP" && !deltaMeta.truncated) {
			const stillOpen = state.findings.some((f) => f.status === "open");
			state.event = stillOpen ? state.event : "APPROVE";
			state.lastReviewedSha = context.headSha;
			state.reviewedAt = new Date().toISOString();
			await saveReviewState(
				context.kv,
				context.provider,
				context.owner,
				context.repo,
				context.pullNumber,
				state,
			);
			await restampCheckRun(context, state.event);
			return null; // nothing to post — the check-run carries the verdict
		}

		if (triage.recommendation === "INCREMENTAL" && !deltaMeta.truncated) {
			scopedFiles = deltaMeta.files;
			// The agents only review the delta, so prior findings on files outside
			// it are never re-surfaced. Carry the still-open ones forward as
			// blocking, and resolved ones as tombstones, into the persisted state.
			survivingPrior = state.findings.filter((f) => f.status === "open");
			resolvedTombstones = state.findings.filter(
				(f) => f.status === "resolved",
			);
		}
		// FULL falls through with scopedFiles = files.
		// Truncated compare (>= 300 files): SKIP/INCREMENTAL are bypassed above,
		// so execution always reaches here and reviews the full paginated file set.
		if (deltaMeta.truncated) {
			console.warn(
				"triage gate: compare API truncated (>=300 files); forcing FULL review",
				{
					owner: context.owner,
					repo: context.repo,
					pullNumber: context.pullNumber,
				},
			);
		}
	}

	const scopedFilePaths = scopedFiles.map((f) => f.filename);

	const userMessage = buildUserMessage({
		owner: context.owner,
		repo: context.repo,
		pullNumber: context.pullNumber,
		headSha: context.headSha,
		title: context.title,
		body: context.body,
		additions: context.additions,
		deletions: context.deletions,
		changedFiles: context.changedFiles,
		labels: context.labels,
		extraInstructions: context.extraInstructions,
		files: scopedFiles,
		priorBotReviews,
		priorOwnReview,
	});

	// Detect Tier 2 skills relevant to this PR and run all agents together.
	// Keyed off scopedFiles so an INCREMENTAL pass only activates Tier 2 skills
	// for the surface actually under review.
	const tier2Matches = context.tier2Enabled
		? detectTier2Skills({
				filePaths: scopedFilePaths,
				additions: context.additions,
				deletions: context.deletions,
				title: context.title,
				body: context.body,
				labels: context.labels,
				patchContent: scopedFiles.map((f) => f.patch ?? "").join("\n"),
			})
		: [];

	const allSkills = [
		...TIER1_SKILLS.map((skillPath) => ({ skillPath, tier: 1, reason: "" })),
		...tier2Matches.map(({ skillPath, reason }) => ({
			skillPath,
			tier: 2,
			reason,
		})),
	];

	let lastRateLimit: RateLimitInfo | undefined;
	const outcomes = await mapWithConcurrency(
		allSkills,
		context.agentConcurrency,
		async ({ skillPath }, i) => {
			const t0 = Date.now();
			const outcome = await runAgent(
				skillPath,
				userMessage,
				selection,
				customPrompt,
			);
			// Sequential handoff at the default concurrency 1; at AGENT_CONCURRENCY>1 this is a
			// benign best-effort race (pacing only needs an approximate recent signal).
			if (outcome.status !== "error") lastRateLimit = outcome.rateLimit;
			console.log("agent done", {
				idx: i + 1,
				total: allSkills.length,
				skillPath,
				status: outcome.status,
				ms: Date.now() - t0,
			});
			return outcome;
		},
		{
			onBeforeEach: async (i) => {
				if (i === 0) return; // nothing learned yet
				const delay = computePaceDelayMs(lastRateLimit, Date.now());
				if (delay > 0) {
					console.log("pacing before next agent", {
						idx: i + 1,
						delayMs: delay,
					});
					await sleep(delay);
				}
			},
		},
	);

	const agentResults: ModelReview[] = [];
	const rateLimited: RateLimitInfo[] = [];
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;

	for (const o of outcomes) {
		if (o.status === "ok") {
			agentResults.push(o.review);
			totalPromptTokens += o.usage.promptTokens;
			totalCompletionTokens += o.usage.completionTokens;
		} else if (o.status === "rate_limited") {
			rateLimited.push(o.rateLimit);
		}
	}

	if (agentResults.length === 0 && rateLimited.length > 0) {
		// Pick the agent with the longest retry-after as "worst"; at concurrency 1
		// against a single provider all rate-limited agents carry the same headers,
		// so this is representative.
		const worst = rateLimited.reduce((a, b) =>
			(b.retryAfterSeconds ?? 0) > (a.retryAfterSeconds ?? 0) ? b : a,
		);
		return {
			event: "RATE_LIMITED",
			body: "",
			comments: [],
			metadata: {
				model: selection.model,
				tier1Count: TIER1_SKILLS.length,
				tier2Skills: [],
				generalFindings: 0,
				inlineComments: 0,
				cost: 0,
			},
			validLinesByPath: new Map(),
			rateLimitResetAt: worst.inputTokensResetAt,
			rateLimitRetryAfterSeconds: worst.retryAfterSeconds,
		};
	}

	if (agentResults.length === 0) {
		throw new Error("All review agents failed — no results to merge");
	}

	console.log("agent results collected", {
		total: allSkills.length,
		tier1: TIER1_SKILLS.length,
		tier2: tier2Matches.length,
		succeeded: agentResults.length,
		rateLimited: rateLimited.length,
		notOk: allSkills.length - agentResults.length,
	});

	const modelReview = mergeReviews(agentResults, resolvedKeys);

	console.log("merged review", {
		event: modelReview.event,
		generalFindings: modelReview.general_findings.length,
		inlineComments: modelReview.inline_comments.length,
		inlineCommentPaths: modelReview.inline_comments.map(
			(c) => `${c.path}:${c.line}`,
		),
	});

	const validLines = buildValidLinesByPath(scopedFiles);
	const reviewComments = buildReviewComments(
		scopedFiles,
		modelReview.inline_comments,
	);

	console.log("inline comments after validation", {
		submitted: reviewComments.length,
		dropped: modelReview.inline_comments.length - reviewComments.length,
	});

	let commentProvenance:
		| Map<string, { skills: string[]; title: string }>
		| undefined;
	if (context.feedbackEnabled) {
		const skillsByKey = new Map<string, Set<string>>();
		outcomes.forEach((outcome, i) => {
			if (outcome.status !== "ok") return;
			const skillPath = allSkills[i]?.skillPath;
			if (!skillPath) return;
			for (const c of outcome.review.inline_comments) {
				const key = `${c.path}:${c.line}`;
				const set = skillsByKey.get(key) ?? new Set<string>();
				set.add(skillPath);
				skillsByKey.set(key, set);
			}
		});
		const titleByKey = new Map<string, string>();
		for (const c of modelReview.inline_comments) {
			titleByKey.set(`${c.path}:${c.line}`, c.title);
		}
		commentProvenance = new Map();
		for (const rc of reviewComments) {
			const key = `${rc.path}:${rc.line}`;
			commentProvenance.set(key, {
				skills: [...(skillsByKey.get(key) ?? [])],
				title: titleByKey.get(key) ?? "",
			});
		}
	}

	// Upgrade to APPROVE only when ALL agents succeeded AND none found anything to flag.
	// If any agent was rate-limited or errored, the review is partial — keep COMMENT.
	const allAgentsSucceeded = agentResults.length === allSkills.length;
	const cleanDelta =
		allAgentsSucceeded &&
		modelReview.event === "COMMENT" &&
		modelReview.general_findings.length === 0 &&
		reviewComments.length === 0;
	// An INCREMENTAL pass that left prior findings unresolved still blocks even if
	// the delta itself was clean — those findings live on files the agents never
	// reviewed this round. Force REQUEST_CHANGES so a clean delta can't APPROVE
	// away a still-open blocking finding (C1).
	const finalEvent: ReviewDecision["event"] =
		survivingPrior.length > 0
			? "REQUEST_CHANGES"
			: cleanDelta
				? "APPROVE"
				: modelReview.event;

	let summary = "";
	if (finalEvent !== "APPROVE") {
		const summaryResult = await generateSummary(
			modelReview,
			selection,
			{
				title: context.title,
				body: context.body,
				additions: context.additions,
				deletions: context.deletions,
				changedFiles: context.changedFiles,
			},
			priorOwnReview,
		);
		summary = summaryResult.summary.trim();
		if (summary.length === 0) {
			summary =
				finalEvent === "REQUEST_CHANGES"
					? "Requesting changes — see the findings and inline comments below."
					: "Review complete — see the findings and inline comments below.";
		}
		totalPromptTokens += summaryResult.usage.promptTokens;
		totalCompletionTokens += summaryResult.usage.completionTokens;
	}

	const cost = computeCost(
		{
			promptTokens: totalPromptTokens,
			completionTokens: totalCompletionTokens,
		},
		selection.model,
	);

	let approvalMessage = "";
	if (finalEvent === "APPROVE") {
		const outstandingChecks = await fetchOutstandingChecks(
			context.octokit,
			context.owner,
			context.repo,
			context.headSha,
			context.commentPrefix,
		);
		approvalMessage = buildApprovalMessage(
			priorOwnReview !== null,
			outstandingChecks,
		);
	}

	const findingsBlock = formatFindings(modelReview.general_findings);
	const inlineSummary =
		reviewComments.length > 0
			? `Inline comments: ${reviewComments.length}`
			: "Inline comments: none";

	const feedbackInvite =
		context.feedbackEnabled && reviewComments.length > 0
			? "💬 React 👍 / 👎 on any inline comment to tell us if it helped — it trains our reviewers."
			: "";

	const tier2Notice =
		tier2Matches.length > 0
			? [
					`\n#### Additional skills activated\n\n${tier2Matches
						.map(
							({ skillPath, reason }) =>
								`- \`${skillPath.replace(".md", "")}\` — ${reason}`,
						)
						.join("\n")}`,
				]
			: [];

	const costFooter = `---\n*Model: ${selection.model} · ${allSkills.length} agents · $${cost.toFixed(6)} · [ai-review-bot](https://github.com/joeblackwaslike/ai-review-bot)*`;

	const body = [
		`### ${context.commentPrefix}`,
		"",
		finalEvent === "APPROVE" ? approvalMessage : summary,
		...tier2Notice,
		"",
		...(finalEvent === "APPROVE" ? [] : [inlineSummary]),
		feedbackInvite,
		findingsBlock ? `\n${findingsBlock}\n` : "",
		reviewMarker,
		"",
		costFooter,
	]
		.filter((part) => part.length > 0)
		.join("\n");

	// Persist the new review state so the NEXT push can triage against it. One
	// PersistedFinding per general finding and per posted inline comment, all
	// status "open". The keys written here must be re-derivable by the resolve
	// logic in the triage gate above: general findings key off title
	// (general:<lowercased title>), inline comments off path:line — so findingId
	// for each is computed from the same title/path/line the gate would match.
	if (context.kv) {
		// Findings raised this round (on whatever surface was reviewed). On an
		// INCREMENTAL pass this is the delta only; the still-open and resolved
		// prior findings are unioned in below so nothing is silently dropped.
		const freshFindings: PersistedFinding[] = [
			...modelReview.general_findings.map(
				(f): PersistedFinding => ({
					id: findingId(null, null, f.title),
					path: null,
					line: null,
					title: f.title,
					severity: f.severity,
					status: "open",
				}),
			),
			...modelReview.inline_comments.map(
				(c): PersistedFinding => ({
					id: findingId(c.path, c.line, c.title),
					path: c.path,
					line: c.line,
					title: c.title,
					severity: "medium",
					status: "open",
				}),
			),
		];
		// Union fresh ∪ surviving-open-prior ∪ resolved-tombstones, deduped by id.
		// freshFindings win on collision (an agent re-raised a prior finding on the
		// delta), so its current status/severity is authoritative. survivingPrior
		// and resolvedTombstones are empty except on the INCREMENTAL path.
		const byId = new Map<string, PersistedFinding>();
		for (const f of [
			...freshFindings,
			...survivingPrior,
			...resolvedTombstones,
		]) {
			if (!byId.has(f.id)) byId.set(f.id, f);
		}
		const persistedFindings = [...byId.values()];
		// finalEvent is one of COMMENT/REQUEST_CHANGES/APPROVE here — the
		// RATE_LIMITED path returned early above, before any state is built.
		const persistedEvent: ReviewState["event"] =
			finalEvent === "COMMENT" ||
			finalEvent === "REQUEST_CHANGES" ||
			finalEvent === "APPROVE"
				? finalEvent
				: "COMMENT";
		const newState: ReviewState = {
			lastReviewedSha: context.headSha,
			event: persistedEvent,
			findings: persistedFindings,
			reviewedAt: new Date().toISOString(),
		};
		await saveReviewState(
			context.kv,
			context.provider,
			context.owner,
			context.repo,
			context.pullNumber,
			newState,
		);
	}

	return {
		event: finalEvent,
		body,
		comments: reviewComments,
		metadata: {
			model: selection.model,
			tier1Count: TIER1_SKILLS.length,
			tier2Skills: tier2Matches.map(({ skillPath }) =>
				skillPath.replace(".md", ""),
			),
			generalFindings: modelReview.general_findings.length,
			inlineComments: reviewComments.length,
			cost,
		},
		validLinesByPath: validLines,
		commentProvenance,
	};
}
