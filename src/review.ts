import { APICallError } from "@ai-sdk/provider";
import { generateObject } from "ai";
import { z } from "zod";
import type { ResolvedAuth } from "./auth.js";
import { dedupeClaims, isSameClaim } from "./claim-dedupe.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { KvClient } from "./feedback/kv.js";
import { computeCost, createAIModel } from "./models.js";
import {
	type AgentPromptOptions,
	buildAgentSystemPrompt,
	buildUserMessage,
} from "./prompt.js";
import type { PersistedFinding, ReviewState } from "./review-state.js";
import { findingId, loadReviewState, saveReviewState } from "./review-state.js";
import { REVIEWER_TUNING, type ReviewerTuning } from "./reviewer-tuning.js";
import type { ModelSelection } from "./router.js";
import { routeModel } from "./router.js";
import { detectTier2Skills } from "./tier2.js";
import { fetchDeltaMeta, triageReReview } from "./triage.js";

type OctokitLike = {
	// params widened to Record<string, unknown> to allow passing nested `headers`
	// objects (e.g. Accept: application/vnd.github.diff for raw-diff fetches).
	request: <T>(
		route: string,
		params: Record<string, unknown>,
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
	/** Wall-clock allowance for launching agents. Past it the remaining agents are
	 * skipped and the review is submitted with what completed — the platform's own
	 * timeout would otherwise kill the run with nothing posted at all. */
	agentBudgetMs: number;
	tier2Enabled: boolean;
	/** Upstash KV client for review-state persistence + the triage gate. Reuses
	 * the client maybeSubmitReview already built for the idempotency claim; absent
	 * (null/undefined) when KV is not configured or on a forced re-review, in
	 * which case the gate is skipped and a full review runs (legacy behavior). */
	kv?: KvClient | null;
	/** Local subscription/OAuth or explicit API-key auth for this review's model
	 * calls. Omitted on the hosted webhook path (env-var API keys apply via
	 * createAIModel's own fallback); supplied by `ai-review watch` for local,
	 * subscription-authenticated review of an already-open PR. */
	auth?: ResolvedAuth;
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
	event:
		| "COMMENT"
		| "REQUEST_CHANGES"
		| "APPROVE"
		| "RATE_LIMITED"
		| "QUOTA_EXHAUSTED";
	body: string;
	/** The generated prose alone, without the findings table, notices or footer
	 * the posted `body` wraps it in. The feedback carrier repeats this beneath
	 * the review, where a second copy of the whole review reads as a duplicate. */
	summary: string;
	comments: ReviewComment[];
	metadata: ReviewMetadata;
	validLinesByPath: Map<string, Set<number>>;
	/** path:line → skills that flagged it + the displayed title. Present only when feedbackEnabled. */
	commentProvenance?: Map<
		string,
		{ skills: string[]; title: string; severity: string | null }
	>;
	rateLimitResetAt?: string;
	rateLimitRetryAfterSeconds?: number;
	/** Provider whose balance is spent, for the QUOTA_EXHAUSTED event. Narrowed
	 * to the known providers so a caller cannot be handed a value the billing
	 * lookup has no link for. */
	quotaProvider?: ModelSelection["provider"];
}

export interface ReviewComment {
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
	| { status: "quota_exhausted"; provider: ModelSelection["provider"] }
	| { status: "error" }
	/** Never started: the run was out of wall-clock before its turn came up. */
	| { status: "skipped"; skillPath: string };

/** Why a provider refused the call. Both conditions arrive as HTTP 429, but they
 * need opposite responses from a human: a rate limit clears on its own, an
 * exhausted balance never does. Conflating them means telling someone to wait
 * for something that will not happen. */
export type ProviderRefusal = "rate_limit" | "quota_exhausted";

// Substrings both providers use for a spent balance. Matched on the message
// because neither exposes a machine-readable field the AI SDK preserves
// consistently through its RetryError wrapper.
const QUOTA_MARKERS = [
	"insufficient_quota",
	"no credits remaining",
	"exceeded your current quota",
	"credit balance is too low",
	"billing_hard_limit_reached",
];

function messageOf(candidate: unknown): string {
	const c = candidate as { message?: unknown; responseBody?: unknown };
	return `${typeof c?.message === "string" ? c.message : ""} ${
		typeof c?.responseBody === "string" ? c.responseBody : ""
	}`.toLowerCase();
}

/** Pure: classify a 429 as a transient rate limit or a spent balance. Returns
 * null when the error is neither. */
export function classifyRefusal(err: unknown): ProviderRefusal | null {
	const candidates: unknown[] = [
		err,
		(err as { lastError?: unknown })?.lastError,
		...((err as { errors?: unknown[] })?.errors ?? []),
	];
	// Quota wins over rate limit: a spent balance also surfaces as 429, and
	// reporting it as a rate limit is the failure this distinction exists to fix.
	for (const c of candidates) {
		const text = messageOf(c);
		if (QUOTA_MARKERS.some((marker) => text.includes(marker))) {
			return "quota_exhausted";
		}
	}
	for (const c of candidates) {
		const status = (c as { statusCode?: number })?.statusCode;
		if (
			status === 429 ||
			(APICallError.isInstance?.(c) && (c as APICallError).statusCode === 429)
		) {
			return "rate_limit";
		}
	}
	return null;
}

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

// Single source of truth for the severity scale — the Zod schema, the emoji
// map, the rendered label, and the test fixtures all derive from this tuple.
export const SEVERITY_LEVELS = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

const CATEGORY_VALUES = [
	"bug",
	"security",
	"performance",
	"test-gap",
	"architecture",
	"style",
	"nitpick",
] as const;
export type Category = (typeof CATEGORY_VALUES)[number];

const findingBase = z
	.object({
		title: z.string(),
		body: z.string(),
		severity: z.enum(SEVERITY_LEVELS),
		category: z.enum(CATEGORY_VALUES),
		confidence: z.number().min(0).max(1),
		evidence: z.string().trim().min(1),
		suppressible: z.boolean(),
	})
	.refine((f) => !(f.severity === "P0" && f.suppressible), {
		message: "P0 findings must not be marked suppressible",
		path: ["suppressible"],
	});

export const ModelReviewSchema = z.object({
	event: z.enum(["COMMENT", "REQUEST_CHANGES"]),
	general_findings: z.array(findingBase),
	inline_comments: z.array(
		findingBase.extend({
			path: z.string(),
			line: z.number().int(),
			start_line: z.number().int().nullable(),
			suggestion: z.string().nullable(),
		}),
	),
});

const SummarySchema = z.object({
	summary: z.string(),
});

export type ModelReview = z.infer<typeof ModelReviewSchema>;

export type ModelFinding = ModelReview["general_findings"][number];
export type ModelInlineComment = ModelReview["inline_comments"][number];

const SEVERITY_EMOJI: Record<Severity, string> = {
	P0: "🔴",
	P1: "🟠",
	P2: "🟡",
	P3: "🟢",
};

// Fallback badge for a severity that isn't a recognized level — only reachable
// if Zod validation is ever bypassed, but renders something sane instead of
// "undefined **undefined**".
const UNKNOWN_SEVERITY_BADGE = "⚪ **Unknown**";

export function severityBadge(severity: string): string {
	const emoji = SEVERITY_EMOJI[severity as Severity];
	if (!emoji) return UNKNOWN_SEVERITY_BADGE;
	return `${emoji} **${severity}**`;
}

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
 *  is a valid OpenAI `reasoningEffort` value (GPT-5.6's explicit non-reasoning
 *  mode) and is forwarded as-is; the Anthropic tiers never emit it. */
export function reasoningProviderOptions(
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
 * is off: either no effort at all (e.g. Haiku) or an explicit `"none"` (GPT-5.6's
 * non-reasoning mode), where no reasoning tokens are billed (you pay for actual
 * tokens, not the cap). `"none"` is a truthy string, so it is excluded here
 * explicitly rather than via a plain truthiness check. */
export function outputBudget(selection: ModelSelection, base: number): number {
	const reasoning =
		selection.effort !== undefined && selection.effort !== "none";
	return reasoning ? Math.max(base * 8, 16000) : base;
}

export interface RunAgentOptions {
	auth?: ResolvedAuth;
	prompt?: AgentPromptOptions;
}

export async function runAgent(
	skillPath: string,
	sharedContext: string,
	selection: ModelSelection,
	customPrompt: string,
	options: RunAgentOptions = {},
): Promise<AgentOutcome> {
	const { auth, prompt: promptOptions = {} } = options;
	const skillBlock = buildAgentSystemPrompt(
		skillPath,
		customPrompt,
		promptOptions,
	);

	try {
		const { object, usage, providerMetadata, response } = await generateObject({
			model: createAIModel(selection, auth),
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
		const refusal = classifyRefusal(err);
		if (refusal === "quota_exhausted") {
			console.error("agent refused: provider balance exhausted", {
				skillPath,
				provider: selection.provider,
			});
			return { status: "quota_exhausted", provider: selection.provider };
		}
		if (refusal === "rate_limit") {
			const rl = extractRateLimit(err) ?? {};
			console.warn("agent rate-limited", { skillPath, ...rl });
			return { status: "rate_limited", rateLimit: rl };
		}
		console.error("Agent threw during generateObject", { skillPath, err });
		return { status: "error" };
	}
}

export interface MergeOptions {
	/** Collapse restatements of one claim across agents. Off preserves the
	 * exact-key-only behaviour every reviewer had before this shipped. */
	dedupeNearDuplicateClaims?: boolean;
}

export interface MergeOutcome {
	review: ModelReview;
	/** `path:line` of each collapsed inline comment → the key of the survivor
	 * now standing for it, so provenance recorded against the original anchor
	 * can follow the finding it belongs to. */
	inlineAliases: Map<string, string>;
	/** How many findings were folded into another as the same claim, so the
	 * caller can log it instead of silently shrinking the review. */
	collapsed: number;
}

export function mergeReviews(
	agentResults: ModelReview[],
	resolved: Set<string> = new Set(),
	options: MergeOptions = {},
): ModelReview {
	return mergeReviewsDetailed(agentResults, resolved, options).review;
}

export function mergeReviewsDetailed(
	agentResults: ModelReview[],
	resolved: Set<string> = new Set(),
	options: MergeOptions = {},
): MergeOutcome {
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

	// Collect all findings per path:line so distinct bodies at the same anchor
	// are preserved rather than silently dropped. Near-duplicates are filtered
	// with isSameClaim — the only case where we do drop is when two agents said
	// the same thing in different words at the exact same location.
	const commentGroups = new Map<string, ModelInlineComment[]>();
	for (const review of agentResults) {
		for (const comment of review.inline_comments) {
			if (isResolvedInline(comment.path, comment.line)) continue;
			const key = `${comment.path}:${comment.line}`;
			const group = commentGroups.get(key);
			if (!group) {
				commentGroups.set(key, [comment]);
			} else if (!group.some((c) => isSameClaim(c, comment))) {
				group.push(comment);
			}
		}
	}

	// Merge multiple distinct findings at the same location into one comment.
	// The most severe finding leads; additional distinct bodies are appended
	// with a separator so no information is silently dropped.
	const INLINE_SEVERITY_RANK: Record<string, number> = {
		P0: 4,
		P1: 3,
		P2: 2,
		P3: 1,
	};
	const anchored = Array.from(commentGroups.values()).map((comments) => {
		if (comments.length === 1) return comments[0];
		const sorted = [...comments].sort(
			(a, b) =>
				(INLINE_SEVERITY_RANK[b.severity] ?? 0) -
				(INLINE_SEVERITY_RANK[a.severity] ?? 0),
		);
		const best = sorted[0];
		const extra = sorted.slice(1).map((c) => c.body);
		return { ...best, body: [best.body, ...extra].join("\n\n---\n\n") };
	});

	// The exact-key pass above only catches agents that anchored to the identical
	// line, which they seldom do — one claim arrives on six adjacent lines of the
	// same expression instead. Collapsing those is the difference between a
	// review with six findings and a review with one.
	let collapsed = 0;
	let inline_comments = anchored;
	let merged_general = general_findings;
	const inlineAliases = new Map<string, string>();
	if (options.dedupeNearDuplicateClaims) {
		const inlineResult = dedupeClaims(anchored);
		for (const { from, into } of inlineResult.merges) {
			inlineAliases.set(
				`${from.path}:${from.line}`,
				`${into.path}:${into.line}`,
			);
		}
		// General findings carry no anchor, so they go in as-is — ClaimLike treats
		// a missing path/line as unanchored and applies the stricter title bar.
		const generalResult = dedupeClaims(general_findings);
		inline_comments = inlineResult.kept;
		merged_general = generalResult.kept;
		collapsed = inlineResult.collapsed + generalResult.collapsed;

		// Drop general findings that duplicate a surviving inline comment — the
		// inline version is more actionable, and both in the same review force the
		// author to resolve the same finding twice.
		const beforeCross = merged_general.length;
		merged_general = merged_general.filter(
			// Strip path from both sides: general findings have no path, so the
			// path check in isSameClaim would always short-circuit. Compare on
			// title/body similarity alone — that's the whole-PR signal here.
			(gf) =>
				!inline_comments.some((ic) =>
					isSameClaim({ ...gf, path: null }, { ...ic, path: null }),
				),
		);
		collapsed += beforeCross - merged_general.length;
	}

	// Event is REQUEST_CHANGES only if an UNRESOLVED finding survived the filters
	// above — a lone re-raise of an already-addressed finding no longer blocks.
	const event: "COMMENT" | "REQUEST_CHANGES" =
		merged_general.length > 0 || inline_comments.length > 0
			? agentResults.some((r) => r.event === "REQUEST_CHANGES")
				? "REQUEST_CHANGES"
				: "COMMENT"
			: "COMMENT";

	return {
		review: { event, general_findings: merged_general, inline_comments },
		collapsed,
		inlineAliases,
	};
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
	survivingPrior: PersistedFinding[] = [],
	/** Findings resolved by the current triage pass specifically — not every
	 * historical tombstone in persisted state. A finding resolved in an earlier
	 * round but since reintroduced and re-flagged by this round's agents must
	 * not appear here, or the summary would call a live blocker fixed. */
	resolvedThisRound: PersistedFinding[] = [],
	auth?: ResolvedAuth,
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

	// Ground truth for what's actually resolved vs still open, computed by the
	// triage gate against the delta diff — not this model's own read of
	// priorOwnReview's free text. Without this, generateSummary independently
	// guesses resolution status and can contradict the "Still open from the
	// previous review" table rendered from survivingPrior right below it in
	// the same posted review (observed live: cc-recall PR #57 round 2, where
	// the summary declared a blocker "addressed" while the table still listed
	// it as open).
	const stillOpenSection =
		survivingPrior.length > 0
			? [
					"",
					"CONFIRMED still open — do not claim these are fixed, no matter what the diff appears to show:",
					...survivingPrior.map((f) => `- [${f.severity}] ${f.title}`),
				].join("\n")
			: "";
	const resolvedSection =
		resolvedThisRound.length > 0
			? [
					"",
					"CONFIRMED resolved this round:",
					...resolvedThisRound.map((f) => `- [${f.severity}] ${f.title}`),
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
		stillOpenSection,
		resolvedSection,
	]
		.filter(Boolean)
		.join("\n");

	const system = [
		"You are a senior code reviewer writing a concise review summary for a GitHub pull request.",
		"Synthesize the findings into 1–3 sentences. Highlight the most important issues.",
		"Do not list every finding — the findings table and inline comments already do that.",
		"If there are no findings, say so briefly.",
		priorOwnReview
			? "This is a follow-up review. Summarize only what is new or changed since the last review. Be brief."
			: "",
		survivingPrior.length > 0 || resolvedThisRound.length > 0
			? "The CONFIRMED still-open and CONFIRMED resolved lists above are ground truth. Never state or imply that a CONFIRMED still-open finding was fixed, and never describe a finding as unresolved if it appears in CONFIRMED resolved."
			: "",
	]
		.filter(Boolean)
		.join("\n");

	const { object, usage } = await generateObject({
		model: createAIModel(selection, auth),
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

export function formatFindings(findings: ModelFinding[]): string {
	if (findings.length === 0) {
		return "";
	}

	const rows = findings
		.map(
			(f) =>
				`| ${SEVERITY_EMOJI[f.severity] ?? "⚪"} | ${f.category} | **${f.title}** |`,
		)
		.join("\n");

	return `| Sev | Category | Finding |\n|---|---|---|\n${rows}`;
}

export interface ReadinessScoreOptions {
	event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
	hasP0: boolean;
	survivingPrior: string[];
	partial: boolean;
}

export function computeReadinessScore(opts: ReadinessScoreOptions): number {
	if (opts.event === "APPROVE") return 5;
	if (opts.hasP0) return 1;
	if (opts.survivingPrior.length > 0) return 2;
	if (opts.event === "REQUEST_CHANGES") return 3;
	return opts.partial ? 3 : 4;
}

export function renderReadinessBar(score: number): string {
	return `${"🟩".repeat(score)}${"⬜".repeat(5 - score)} **${score}/5**`;
}

export interface ReviewMetaParsed {
	sha: string;
	review: number;
	readiness: number;
	provider: string;
	model: string;
	findings: number;
	cost: number;
}

export function parseReviewMetadata(body: string): ReviewMetaParsed | null {
	const extract = (key: string): string | undefined => {
		const m = body.match(
			new RegExp(`<!--\\s*ai-review:${key}=([^\\s>]+)\\s*-->`),
		);
		return m?.[1];
	};
	const sha = extract("sha");
	const reviewStr = extract("review");
	const readinessStr = extract("readiness");
	const provider = extract("provider");
	const model = extract("model");
	const findingsStr = extract("findings");
	const costStr = extract("cost");
	if (
		sha == null ||
		reviewStr == null ||
		readinessStr == null ||
		provider == null ||
		model == null ||
		findingsStr == null ||
		costStr == null
	) {
		return null;
	}
	return {
		sha,
		review: Number(reviewStr),
		readiness: Number(readinessStr),
		provider,
		model,
		findings: Number(findingsStr),
		cost: Number(costStr),
	};
}

export interface FormatReviewBodyOptions {
	commentPrefix: string;
	finalEvent: ReviewDecision["event"];
	summary: string;
	approvalMessage: string;
	readiness: number;
	tier2Matches: { skillPath: string; reason: string }[];
	skipped: string[];
	errored: string[];
	allSkillsCount: number;
	generalFindings: ModelFinding[];
	reviewComments: ReviewComment[];
	dropped: ModelInlineComment[];
	overflowCount: number;
	maxInlineComments: number;
	feedbackEnabled: boolean;
	survivingPrior: PersistedFinding[];
	incrementalPass: boolean;
	priorSha: string;
	headSha: string;
	reviewCount: number;
	model: string;
	cost: number;
}

export function formatReviewBody(opts: FormatReviewBodyOptions): string {
	const {
		commentPrefix,
		finalEvent,
		summary,
		approvalMessage,
		readiness,
		tier2Matches,
		skipped,
		errored,
		allSkillsCount,
		generalFindings,
		reviewComments,
		dropped,
		overflowCount,
		maxInlineComments,
		feedbackEnabled,
		survivingPrior,
		incrementalPass,
		priorSha,
		headSha,
		reviewCount,
		model,
		cost,
	} = opts;

	const readinessBar = renderReadinessBar(readiness);

	const tier2Notice =
		tier2Matches.length > 0
			? `#### Additional skills activated\n\n${tier2Matches
					.map(
						({ skillPath, reason }) =>
							`- \`${skillPath.replace(/\.md$/, "")}\` — ${reason}`,
					)
					.join("\n")}`
			: "";

	const budgetNotices: string[] = [];
	if (skipped.length > 0) {
		budgetNotices.push(
			`> ⏱ **Partial review.** ${skipped.length} of ${allSkillsCount} agents did not run — this pass hit its time budget before reaching ${skipped
				.map((s) => `\`${s.replace(/\.md$/, "")}\``)
				.join(", ")}. Re-run the review command for full coverage.`,
		);
	}
	if (errored.length > 0) {
		budgetNotices.push(
			`> ⚠️ **Partial review.** ${errored.length} of ${allSkillsCount} agent(s) failed to complete: ${errored
				.map((s) => `\`${s.replace(/\.md$/, "")}\``)
				.join(", ")}. Re-run the review command for full coverage.`,
		);
	}

	const findingsBlock = formatFindings(generalFindings);

	const inlineSummary =
		reviewComments.length > 0
			? `Inline comments: ${reviewComments.length}`
			: "Inline comments: none";

	const priorBlockExplanation = incrementalPass
		? `This pass reviewed only what changed since \`${priorSha.slice(0, 12)}\`, so these were not re-checked.`
		: "These were flagged in a previous review; the agents were instructed not to restate them, so they are carried forward as still open.";
	const priorBlock =
		survivingPrior.length > 0
			? `#### Still open from the previous review\n\n${priorBlockExplanation}\n\n| Sev | Finding |\n|---|---|\n${survivingPrior
					.map((f) => {
						const where =
							f.path && f.line != null ? ` (\`${f.path}:${f.line}\`)` : "";
						return `| ${SEVERITY_EMOJI[f.severity as Severity] ?? UNKNOWN_SEVERITY_BADGE} | **${f.title}**${where} |`;
					})
					.join("\n")}`
			: "";

	const droppedNotice =
		dropped.length > 0
			? `> ⚠️ ${dropped.length} inline comment${dropped.length === 1 ? "" : "s"} could not be anchored to the diff and ${dropped.length === 1 ? "was" : "were"} posted here instead:\n${dropped
					.map(
						(c) =>
							`> - ${SEVERITY_EMOJI[c.severity as Severity] ?? UNKNOWN_SEVERITY_BADGE} **${c.title}** (\`${c.path}:${c.line}\`)`,
					)
					.join("\n")}`
			: "";

	const overflowNotice =
		overflowCount > 0
			? `> ℹ️ ${overflowCount} inline comment${overflowCount === 1 ? "" : "s"} not posted (${maxInlineComments}-comment cap; lowest-severity findings dropped first). Re-run with \`/ai-review\` on a smaller diff for complete coverage.`
			: "";

	const feedbackInvite =
		feedbackEnabled && reviewComments.length > 0
			? "💬 React on any inline comment to train our reviewers: 👍 it helped, 👎 it was wrong, 😕 it didn't land. For 😕, please also reply saying why — the reply is what we learn from."
			: "";

	const commandHints =
		"> Re-run: `/ai-review` · Full diff: `/ai-review --full` · Skip: `/ai-review --skip`";

	const metadataBlock = [
		`<!-- ai-review:sha=${headSha} -->`,
		`<!-- ai-review:review=${reviewCount} -->`,
		`<!-- ai-review:readiness=${readiness} -->`,
		`<!-- ai-review:provider=${model.includes("gpt") || model.includes("o4") ? "openai" : "anthropic"} -->`,
		`<!-- ai-review:model=${model} -->`,
		`<!-- ai-review:findings=${generalFindings.length} -->`,
		`<!-- ai-review:cost=${cost.toFixed(6)} -->`,
	].join("\n");

	const costFooter = `---\n*Model: ${model} · ${allSkillsCount} agents · $${cost.toFixed(6)} · [ai-review-bot](https://github.com/joeblackwaslike/ai-review-bot)*`;

	const parts = [
		`### ${commentPrefix}`,
		readinessBar,
		finalEvent === "APPROVE" ? approvalMessage : summary,
		tier2Notice,
		...budgetNotices,
		...(finalEvent === "APPROVE" ? [] : [inlineSummary]),
		droppedNotice,
		overflowNotice,
		feedbackInvite,
		findingsBlock,
		priorBlock,
		commandHints,
		metadataBlock,
		costFooter,
	];

	return parts.filter((part) => part.length > 0).join("\n\n");
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
	const badge = severityBadge(comment.severity);
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

/** Parse a GitHub raw unified-diff response into a per-file patch map.
 *
 * Used to recover patches omitted from the /pulls/{n}/files API response for
 * files larger than GitHub's inline-diff threshold. The patch starts at the
 * first @@ hunk header and runs to the next `diff --git` block (or EOF). */
export function parseRawDiff(rawDiff: string): Map<string, string> {
	const result = new Map<string, string>();
	const blocks = rawDiff.split(/^diff --git /m).slice(1);
	for (const block of blocks) {
		const bSide = block.match(/^\+\+\+ b\/(.+)$/m);
		if (!bSide) continue;
		const filename = bSide[1].trimEnd();
		const patchStart = block.indexOf("\n@@");
		if (patchStart === -1) continue;
		result.set(filename, block.slice(patchStart + 1));
	}
	return result;
}

/** Find the nearest valid right-side line within ±window of target, checking
 * alternately above and below. Returns null when nothing is in range. */
function nearestValidLine(
	target: number,
	validLines: Set<number>,
	window: number,
): number | null {
	for (let delta = 1; delta <= window; delta++) {
		if (validLines.has(target + delta)) return target + delta;
		if (validLines.has(target - delta)) return target - delta;
	}
	return null;
}

/** Correct mechanical anchor errors before diff validation.
 *
 * - Condition 2 (line not in valid set): adjust to nearest valid line ±5.
 * - Condition 3 (start_line >= line): clear start_line.
 * - Condition 4 (start_line not in valid set): clear start_line.
 *
 * Condition 1 (path not in diff) is recovered upstream by fetching the raw PR diff. */
export function sanitizeInlineComments(
	comments: ModelInlineComment[],
	validLinesByPath: Map<string, Set<number>>,
): ModelInlineComment[] {
	return comments.map((c) => {
		const validLines = validLinesByPath.get(c.path);
		if (!validLines) return c;

		let { line, start_line } = c;

		if (!validLines.has(line)) {
			const adjusted = nearestValidLine(line, validLines, 5);
			if (adjusted !== null) {
				console.log("inline comment anchor adjusted (fuzzy)", {
					path: c.path,
					original: c.line,
					adjusted,
				});
				line = adjusted;
			}
		}

		if (start_line !== null && start_line >= line) {
			console.log("inline comment start_line cleared (backwards range)", {
				path: c.path,
				line,
				start_line,
			});
			start_line = null;
		}

		if (start_line !== null && !validLines.has(start_line)) {
			console.log("inline comment start_line cleared (invalid)", {
				path: c.path,
				line,
				start_line,
			});
			start_line = null;
		}

		if (line === c.line && start_line === c.start_line) return c;
		return { ...c, line, start_line };
	});
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

/** `checks: []` means "fetched cleanly, nothing outstanding" — distinct from
 * `fetchFailed: true`, which means the fetch itself failed and the approval
 * message must say so rather than implying a clean bill of health it never
 * confirmed. */
interface OutstandingChecksResult {
	checks: string[];
	fetchFailed: boolean;
}

async function fetchOutstandingChecks(
	octokit: OctokitLike,
	owner: string,
	repo: string,
	headSha: string,
	ownPrefix: string,
): Promise<OutstandingChecksResult> {
	try {
		const checkRuns = await octokit.request<{ check_runs: CheckRun[] }>(
			"GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
			{ owner, repo, ref: headSha },
		);
		const checks = checkRuns.data.check_runs
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
		return { checks, fetchFailed: false };
	} catch (err) {
		console.warn("failed to fetch outstanding checks", { headSha, err });
		return { checks: [], fetchFailed: true };
	}
}

function buildApprovalMessage(
	isReReview: boolean,
	outstandingChecks: OutstandingChecksResult,
): string {
	const resolution = isReReview
		? "All issues from the previous review have been resolved."
		: "No issues found.";

	const checksQualifier = outstandingChecks.fetchFailed
		? " Note: could not verify outstanding CI checks — check them manually before merging."
		: outstandingChecks.checks.length > 0
			? ` Note: ${outstandingChecks.checks.length} CI check(s) still outstanding: ${outstandingChecks.checks.join(", ")}.`
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

	// Inject patches for files GitHub omitted from the files-list response
	// (they exceed GitHub's inline-diff threshold). Fetching the full raw PR
	// diff and parsing it recovers these patches so agents can see the code
	// and inline comments anchor correctly.
	const noPatchFiles = files.filter((f) => !f.patch);
	if (noPatchFiles.length > 0) {
		try {
			const { data: rawDiff } = await context.octokit.request<string>(
				"GET /repos/{owner}/{repo}/pulls/{pull_number}",
				{
					owner: context.owner,
					repo: context.repo,
					pull_number: context.pullNumber,
					headers: { accept: "application/vnd.github.diff" },
				},
			);
			const patchMap = parseRawDiff(rawDiff);
			for (const file of noPatchFiles) {
				const patch = patchMap.get(file.filename);
				if (patch) {
					file.patch = patch;
					console.log("injected missing patch from raw diff", {
						path: file.filename,
						patchLength: patch.length,
					});
				} else {
					console.warn("no patch found in raw diff for large file", {
						path: file.filename,
					});
				}
			}
		} catch (err) {
			console.warn(
				"failed to fetch raw PR diff; inline comments for large files may be dropped",
				err,
			);
		}
	}

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
	// Findings to carry into the next persisted state on any re-review pass
	// (INCREMENTAL or FULL): prior findings still open after triage, plus
	// resolved tombstones (so future rounds can tell "resolved" from "never
	// existed"). REVIEWER_TUNING's showPriorOwnFindings tells agents on every
	// pass not to re-file a finding already on record as open, so this must
	// run regardless of pass type — a FULL pass that doesn't re-raise a real,
	// still-broken finding would otherwise silently drop it from tracked
	// state and could false-APPROVE past it. Both stay empty on the cold
	// (no-prior-state) path.
	let survivingPrior: PersistedFinding[] = [];
	/** SHA the surviving findings were last reviewed against. Set together with
	 * survivingPrior, from the same state the re-review guard already proved
	 * has a non-empty lastReviewedSha, so the review can name it without an
	 * optional chain whose undefined branch no test could reach. */
	let priorSha = "";
	let resolvedTombstones: PersistedFinding[] = [];
	/** Subset of resolvedTombstones resolved by THIS triage pass specifically —
	 * not every historical tombstone in persisted state. Fed to generateSummary
	 * as "confirmed resolved this round"; the full resolvedTombstones list also
	 * includes findings resolved in an earlier round, which may have since been
	 * reintroduced and re-flagged by this round's agents — labeling those as
	 * newly resolved would tell the summary to call a live blocker fixed. */
	let resolvedThisRound: PersistedFinding[] = [];
	/** Whether this pass reviewed only the delta (INCREMENTAL) rather than the
	 * whole file set (FULL) — changes how the "still open" carry-forward is
	 * explained, since a FULL pass did see these findings' files and chose not
	 * to restate them, while an INCREMENTAL pass never saw them at all. */
	let incrementalPass = false;
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
			context.auth,
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

		// Carry still-open findings forward as blocking, and resolved ones as
		// tombstones, regardless of INCREMENTAL vs FULL — see the comment on
		// survivingPrior's declaration for why FULL needs this too.
		survivingPrior = state.findings.filter((f) => f.status === "open");
		priorSha = state.lastReviewedSha;
		resolvedTombstones = state.findings.filter((f) => f.status === "resolved");
		resolvedThisRound = state.findings.filter((f) =>
			triage.resolved.includes(f.id),
		);

		if (triage.recommendation === "INCREMENTAL" && !deltaMeta.truncated) {
			scopedFiles = deltaMeta.files;
			incrementalPass = true;
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

	const tuning: ReviewerTuning = REVIEWER_TUNING;
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
		diffScope: incrementalPass
			? `INCREMENTAL — only files changed since ${priorSha.slice(0, 12)}. Continue any threads already open on other files; do not refile findings for files not shown in this diff.`
			: undefined,
		priorBotReviews,
		priorOwnReview,
		priorOwnFindings: tuning.showPriorOwnFindings
			? (state?.findings ?? []).map((f) => ({
					path: f.path,
					line: f.line,
					title: f.title,
					severity: f.severity,
					status: f.status,
				}))
			: undefined,
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

	const tier1Items = TIER1_SKILLS.map((skillPath) => ({
		skillPath,
		tier: 1,
		reason: "",
	}));
	const tier2Items = tier2Matches.map(({ skillPath, reason }) => ({
		skillPath,
		tier: 2,
		reason,
	}));
	// Interleave Tier2 skills into the queue so budget exhaustion cuts proportionally
	// across both tiers rather than always dropping all Tier2 agents.
	const allSkills = tier1Items
		.flatMap((t1, i) => {
			const t2 = tier2Items[i];
			return t2 !== undefined ? [t1, t2] : [t1];
		})
		.concat(tier2Items.slice(tier1Items.length));

	let lastRateLimit: RateLimitInfo | undefined;
	const deadline = Date.now() + context.agentBudgetMs;
	const outcomes = await mapWithConcurrency(
		allSkills,
		context.agentConcurrency,
		async ({ skillPath }, i) => {
			// Checked before dispatch, never mid-call: an agent already reasoning
			// should finish and contribute. What this prevents is *starting* an
			// agent whose run the platform would kill before anything is
			// submitted, losing every finding the earlier agents produced.
			if (Date.now() >= deadline) {
				console.warn("agent skipped: review time budget exhausted", {
					idx: i + 1,
					total: allSkills.length,
					skillPath,
				});
				return { status: "skipped", skillPath } as AgentOutcome;
			}
			const t0 = Date.now();
			const outcome = await runAgent(
				skillPath,
				userMessage,
				selection,
				customPrompt,
				{
					auth: context.auth,
					prompt: { strictEvidenceRules: tuning.strictEvidenceRules },
				},
			);
			// Sequential handoff at the default concurrency 1; at AGENT_CONCURRENCY>1 this is a
			// benign best-effort race (pacing only needs an approximate recent signal).
			if (outcome.status === "ok" || outcome.status === "rate_limited") {
				lastRateLimit = outcome.rateLimit;
			}
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
	const quotaExhausted: ModelSelection["provider"][] = [];
	const skipped: string[] = [];
	const errored: string[] = [];
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;

	outcomes.forEach((o, i) => {
		if (o.status === "ok") {
			agentResults.push(o.review);
			totalPromptTokens += o.usage.promptTokens;
			totalCompletionTokens += o.usage.completionTokens;
		} else if (o.status === "rate_limited") {
			rateLimited.push(o.rateLimit);
		} else if (o.status === "quota_exhausted") {
			quotaExhausted.push(o.provider);
		} else if (o.status === "skipped") {
			skipped.push(o.skillPath);
		} else if (o.status === "error") {
			// runAgent already logged the underlying error; what's missing here is
			// attaching it to *this* skill and to the PR — without it a crashed
			// agent reads identically to one that ran clean and found nothing.
			errored.push(allSkills[i]?.skillPath ?? "unknown");
		}
	});

	if (skipped.length > 0) {
		console.warn("review ran out of time budget", {
			completed: agentResults.length,
			skipped,
		});
	}

	if (errored.length > 0) {
		console.warn("review agents failed and were excluded from this pass", {
			completed: agentResults.length,
			errored,
		});
	}

	// Checked before the rate-limit branch: a spent balance also surfaces as 429,
	// and the two need opposite responses from a human. Reporting "wait for the
	// budget to reset" when the account is empty sends someone to wait for
	// something that will never happen.
	if (agentResults.length === 0 && quotaExhausted.length > 0) {
		return {
			event: "QUOTA_EXHAUSTED",
			body: "",
			summary: "",
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
			quotaProvider: quotaExhausted[0],
		};
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
			summary: "",
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

	const mergeOutcome = mergeReviewsDetailed(agentResults, resolvedKeys, {
		dedupeNearDuplicateClaims: tuning.dedupeNearDuplicateClaims,
	});
	const modelReview = mergeOutcome.review;
	if (mergeOutcome.collapsed > 0) {
		console.log("collapsed restatements of the same claim", {
			collapsed: mergeOutcome.collapsed,
			remaining:
				modelReview.general_findings.length +
				modelReview.inline_comments.length,
		});
	}

	console.log("merged review", {
		event: modelReview.event,
		generalFindings: modelReview.general_findings.length,
		inlineComments: modelReview.inline_comments.length,
		inlineCommentPaths: modelReview.inline_comments.map(
			(c) => `${c.path}:${c.line}`,
		),
	});

	const validLines = buildValidLinesByPath(scopedFiles);

	// Fix mechanical anchor errors before diff validation so fewer comments are
	// silently dropped: fuzzy-anchor ±5 for off-by-one lines, clear backwards
	// or invalid start_line ranges.
	const sanitizedComments = sanitizeInlineComments(
		modelReview.inline_comments,
		validLines,
	);

	// Cap at 50 inline comments, keeping the most severe. GitHub's review API
	// rejects payloads over a certain size, and a wall of 80+ low-severity nits
	// buries the high-severity findings that actually matter.
	const MAX_INLINE_COMMENTS = 50;
	const INLINE_OVERFLOW_RANK: Record<string, number> = {
		P0: 4,
		P1: 3,
		P2: 2,
		P3: 1,
	};
	let effectiveInlineComments = sanitizedComments;
	let overflowComments: ModelInlineComment[] = [];
	if (sanitizedComments.length > MAX_INLINE_COMMENTS) {
		const sorted = [...sanitizedComments].sort(
			(a, b) =>
				(INLINE_OVERFLOW_RANK[b.severity] ?? 0) -
				(INLINE_OVERFLOW_RANK[a.severity] ?? 0),
		);
		effectiveInlineComments = sorted.slice(0, MAX_INLINE_COMMENTS);
		overflowComments = sorted.slice(MAX_INLINE_COMMENTS);
		console.warn("inline comment cap applied", {
			total: sanitizedComments.length,
			kept: MAX_INLINE_COMMENTS,
			overflow: overflowComments.length,
		});
	}

	const reviewComments = buildReviewComments(
		scopedFiles,
		effectiveInlineComments,
	);

	console.log("inline comments after validation", {
		submitted: reviewComments.length,
		dropped: effectiveInlineComments.length - reviewComments.length,
		overflow: overflowComments.length,
	});

	let commentProvenance:
		| Map<string, { skills: string[]; title: string; severity: string | null }>
		| undefined;
	if (context.feedbackEnabled) {
		const skillsByKey = new Map<string, Set<string>>();
		outcomes.forEach((outcome, i) => {
			if (outcome.status !== "ok") return;
			const skillPath = allSkills[i]?.skillPath;
			if (!skillPath) return;
			for (const c of outcome.review.inline_comments) {
				// Record against the survivor's key when this finding was collapsed
				// into another. Keying on the agent's own anchor would strand the
				// attribution: near-duplicate collapsing spans different nearby
				// lines, so nothing later looks the original key up again, and a
				// bug found by five agents would be credited to one skill.
				const own = `${c.path}:${c.line}`;
				const key = mergeOutcome.inlineAliases.get(own) ?? own;
				const set = skillsByKey.get(key) ?? new Set<string>();
				set.add(skillPath);
				skillsByKey.set(key, set);
			}
		});
		const titleByKey = new Map<string, string>();
		const severityByKey = new Map<string, string>();
		for (const c of modelReview.inline_comments) {
			titleByKey.set(`${c.path}:${c.line}`, c.title);
			severityByKey.set(`${c.path}:${c.line}`, c.severity);
		}
		commentProvenance = new Map();
		for (const rc of reviewComments) {
			const key = `${rc.path}:${rc.line}`;
			commentProvenance.set(key, {
				skills: [...(skillsByKey.get(key) ?? [])],
				title: titleByKey.get(key) ?? "",
				severity: severityByKey.get(key) ?? null,
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
		// What the agents found, not what GitHub would accept. Measuring the
		// posted comments meant a review whose only finding failed to anchor
		// approved the PR while printing that finding in its own body.
		modelReview.inline_comments.length === 0;
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
			survivingPrior,
			resolvedThisRound,
			context.auth,
		);
		summary = summaryResult.summary.trim();
		if (summary.length === 0) {
			// The summary model returned empty/whitespace — surface it (likely a
			// model error or refusal) instead of silently papering over it.
			console.warn("summary model returned an empty summary; using fallback", {
				finalEvent,
			});
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
			? "💬 React on any inline comment to train our reviewers: 👍 it helped, 👎 it was wrong, 😕 it didn't land. For 😕, please also reply saying why — the reply is what we learn from."
			: "";

	// Named on the review, not just in the logs. A partial review that reads as
	// complete is worse than a late one: silence from the security agent looks
	// like "nothing found" when that agent never ran or crashed mid-run.
	const budgetNotice: string[] = [];
	if (skipped.length > 0) {
		budgetNotice.push(
			`> ⏱ **Partial review.** ${skipped.length} of ${allSkills.length} agents did not run — this pass hit its time budget before reaching ${skipped
				.map((s) => `\`${s.replace(/\.md$/, "")}\``)
				.join(", ")}. Re-run the review command for full coverage.`,
		);
	}
	if (errored.length > 0) {
		budgetNotice.push(
			`> ⚠️ **Partial review.** ${errored.length} of ${allSkills.length} agent(s) failed to complete: ${errored
				.map((s) => `\`${s.replace(/\.md$/, "")}\``)
				.join(", ")}. Re-run the review command for full coverage.`,
		);
	}

	const tier2Notice =
		tier2Matches.length > 0
			? [
					`#### Additional skills activated\n\n${tier2Matches
						.map(
							({ skillPath, reason }) =>
								`- \`${skillPath.replace(/\.md$/, "")}\` — ${reason}`,
						)
						.join("\n")}`,
				]
			: [];

	// On INCREMENTAL the agents never saw these findings' files this pass, so
	// they cannot re-raise them; on FULL they saw them but were told
	// (priorOwnFindings) not to restate them. Either way they are the whole
	// reason the review blocks, and without this the review reads "nothing
	// new, no inline comments" over a REQUEST_CHANGES verdict — a bot
	// shouting with nothing to point at.
	// Same table shape as formatFindings on purpose: the cold-KV fallback in
	// parsePriorReview recovers findings by that row format.
	const priorBlockExplanation = incrementalPass
		? `This pass reviewed only what changed since \`${priorSha.slice(0, 12)}\`, so these were not re-checked.`
		: "These were flagged in a previous review; the agents were instructed not to restate them, so they are carried forward as still open.";
	const priorBlock =
		survivingPrior.length > 0
			? `#### Still open from the previous review\n\n${priorBlockExplanation}\n\n| Sev | Finding |\n|---|---|\n${survivingPrior
					.map((f) => {
						const where =
							f.path && f.line != null ? ` (\`${f.path}:${f.line}\`)` : "";
						return `| ${SEVERITY_EMOJI[f.severity as Severity] ?? UNKNOWN_SEVERITY_BADGE} | **${f.title}**${where} |`;
					})
					.join("\n")}`
			: "";

	// buildReviewComments drops comments that don't anchor to the diff. Staying
	// quiet about it leaves a blocking review whose findings all vanished looking
	// like a review that found nothing.
	// Named, not counted: one of these can be the finding holding the review at
	// REQUEST_CHANGES, and a bare count tells the author something was lost
	// without telling them what to fix.
	const postedKeys = new Set(reviewComments.map((c) => `${c.path}:${c.line}`));
	const dropped = effectiveInlineComments.filter(
		(c) => !postedKeys.has(`${c.path}:${c.line}`),
	);
	const droppedNotice =
		dropped.length > 0
			? `> ⚠️ ${dropped.length} inline comment${dropped.length === 1 ? "" : "s"} could not be anchored to the diff and ${dropped.length === 1 ? "was" : "were"} posted here instead:\n${dropped
					.map(
						(c) =>
							`> - ${SEVERITY_EMOJI[c.severity as Severity] ?? UNKNOWN_SEVERITY_BADGE} **${c.title}** (\`${c.path}:${c.line}\`)`,
					)
					.join("\n")}`
			: "";
	const overflowNotice =
		overflowComments.length > 0
			? `> ℹ️ ${overflowComments.length} inline comment${overflowComments.length === 1 ? "" : "s"} not posted (${MAX_INLINE_COMMENTS}-comment cap; lowest-severity findings dropped first). Re-run with \`/ai-review\` on a smaller diff for complete coverage.`
			: "";

	const costFooter = `---\n*Model: ${selection.model} · ${allSkills.length} agents · $${cost.toFixed(6)} · [ai-review-bot](https://github.com/joeblackwaslike/ai-review-bot)*`;

	// Joined with a blank line between every section, not a single newline.
	// GitHub reads a paragraph followed by `---` as a setext H2 underline rather
	// than a horizontal rule, and the cost footer opens with `---`, so gluing
	// sections together rendered the whole review — summary, inline count and
	// review marker alike — at heading size.
	const body = [
		`### ${context.commentPrefix}`,
		finalEvent === "APPROVE" ? approvalMessage : summary,
		...tier2Notice,
		...budgetNotice,
		...(finalEvent === "APPROVE" ? [] : [inlineSummary]),
		droppedNotice,
		overflowNotice,
		feedbackInvite,
		findingsBlock,
		priorBlock,
		reviewMarker,
		costFooter,
	]
		.filter((part) => part.length > 0)
		.join("\n\n");

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
			...effectiveInlineComments.map(
				(c): PersistedFinding => ({
					id: findingId(c.path, c.line, c.title),
					path: c.path,
					line: c.line,
					title: c.title,
					severity: c.severity,
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
		summary: finalEvent === "APPROVE" ? approvalMessage : summary,
		comments: reviewComments,
		metadata: {
			model: selection.model,
			tier1Count: TIER1_SKILLS.length,
			tier2Skills: tier2Matches.map(({ skillPath }) =>
				skillPath.replace(/\.md$/, ""),
			),
			generalFindings: modelReview.general_findings.length,
			inlineComments: reviewComments.length,
			cost,
		},
		validLinesByPath: validLines,
		commentProvenance,
	};
}
