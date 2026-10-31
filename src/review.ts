import { APICallError } from "@ai-sdk/provider";
import { generateObject } from "ai";
import { z } from "zod";
import {
	type AgentFailure,
	classifyAgentError,
	usageFromError,
} from "./agent-failure.js";
import {
	type AgentRecord,
	formatAgentsMarker,
	logAgentRecords,
	toRecord,
} from "./agent-log.js";
import type { ResolvedAuth } from "./auth.js";
import { deriveBaseline } from "./baseline.js";
import { dedupeClaims, isSameClaim } from "./claim-dedupe.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { KvClient } from "./feedback/kv.js";
import { loadLedger, reconcileSurvivingPrior } from "./ledger/live.js";
import { findSettledMatch } from "./ledger/match.js";
import { retargetCarried } from "./ledger/retarget.js";
import { suppressInReview } from "./ledger/suppress.js";
import { isSettled } from "./ledger/types.js";
import { computeCost, createAIModel } from "./models.js";
import {
	type AgentPromptOptions,
	buildAgentSystemPrompt,
	buildUserMessage,
	wholePrInputComplete,
} from "./prompt.js";
import { readMetadataValue } from "./review-metadata.js";
import type { PersistedFinding, ReviewState } from "./review-state.js";
import { findingId, loadReviewState, saveReviewState } from "./review-state.js";
import { REVIEWER_TUNING, type ReviewerTuning } from "./reviewer-tuning.js";
import type { ModelSelection } from "./router.js";
import {
	outputBudget,
	reasoningProviderOptions,
	routeModel,
} from "./router.js";
import { detectTier2Skills, TIER2_DETECTORS } from "./tier2.js";
import {
	fetchDeltaMeta,
	revalidateFindings,
	triageReReview,
} from "./triage.js";

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
	additions?: number;
	deletions?: number;
	/** Set by GitHub on a renamed file. */
	previous_filename?: string;
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
	id?: number;
	body?: string | null;
	state?: string;
}

const STANDING_REVIEW_STATES = new Set([
	"APPROVED",
	"CHANGES_REQUESTED",
	"DISMISSED",
]);

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
			durationMs: number;
			rateLimit?: RateLimitInfo;
	  }
	| { status: "rate_limited"; rateLimit: RateLimitInfo }
	| { status: "quota_exhausted"; provider: ModelSelection["provider"] }
	| {
			status: "error";
			failure: AgentFailure;
			usage?: TokenUsage;
			durationMs: number;
			/** For the local log file only; never in records or the marker. */
			message?: string;
			/** Stack frames (no message) of an `unknown` failure, for the console
			 * record only. */
			stack?: string;
	  }
	/** Never started: the run was out of wall-clock before its turn came up. */
	| { status: "skipped"; skillPath: string };

/** One run of one agent; `attempt` 2 is the single retry. */
export interface AgentAttempt {
	skill: string;
	attempt: 1 | 2;
	outcome: AgentOutcome;
}

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
		severity: z
			.enum(SEVERITY_LEVELS)
			.describe(
				"Severity: P0 (critical/crash/auth-bypass), P1 (high/correctness bug), P2 (medium/important), P3 (low/nitpick). Use P0–P3 for BOTH general_findings and inline_comments — never 'high'/'medium'/'low'.",
			),
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

const baseName = (path: string) => path.split("/").pop() ?? path;

/** Every skill name an `agents` marker may mention. */
export const KNOWN_SKILLS: ReadonlySet<string> = new Set(
	[...TIER1_SKILLS, ...TIER2_DETECTORS.map((d) => d.skillPath)].map(baseName),
);

const PACE_TOKEN_FLOOR = 5000; // below this many remaining input tokens, wait for reset
const PACE_MAX_WAIT_MS = 60_000; // never sleep longer than this between agents
// A retry starts only with at least this long, or as long as the first attempt
// took if that was longer, left before the agent deadline.
const MIN_RETRY_WINDOW_MS = 30_000;

/** Clamp a pacing sleep to the time left before the run's deadline, so a late
 * rate-limit reply cannot make the queue sleep through the function cap. */
export function capPaceToDeadline(
	delayMs: number,
	nowMs: number,
	deadlineMs: number,
): number {
	return Math.max(0, Math.min(delayMs, deadlineMs - nowMs));
}

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

export interface RunAgentOptions {
	auth?: ResolvedAuth;
	prompt?: AgentPromptOptions;
	/** Cuts the call off at the run's wall-clock deadline; an aborted agent is
	 * reported as skipped, since the platform would otherwise kill the whole
	 * function with nothing posted. */
	abortSignal?: AbortSignal;
}

/** The `at` lines of an error's stack, at most 1500 characters. The header line
 * holds the message, and with it possibly diff text, so it is left out. */
function stackFrames(err: unknown): string | undefined {
	if (!(err instanceof Error) || !err.stack) return undefined;
	const frames = err.stack
		.split("\n")
		.filter((l) => /^\s+at /.test(l))
		.join("\n");
	return frames ? frames.slice(0, 1500) : undefined;
}

export async function runAgent(
	skillPath: string,
	sharedContext: string,
	selection: ModelSelection,
	customPrompt: string,
	options: RunAgentOptions = {},
): Promise<AgentOutcome> {
	const { auth, prompt: promptOptions = {}, abortSignal } = options;
	const skillBlock = buildAgentSystemPrompt(
		skillPath,
		customPrompt,
		promptOptions,
	);

	const startedAt = Date.now();
	try {
		const { object, usage, providerMetadata, response } = await generateObject({
			model: createAIModel(selection, auth),
			schema: ModelReviewSchema,
			maxOutputTokens: outputBudget(selection, 4096),
			maxRetries: 4,
			abortSignal,
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
			durationMs: Date.now() - startedAt,
			rateLimit: readRateLimitHeaders(
				response?.headers as Record<string, string> | undefined,
			),
		};
	} catch (err) {
		if (abortSignal?.aborted) {
			console.warn("agent aborted: review time budget exhausted", {
				skillPath,
			});
			return { status: "skipped", skillPath };
		}
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
		const usage = usageFromError(err);
		const failure = classifyAgentError(err);
		const stack = failure.class === "unknown" ? stackFrames(err) : undefined;
		return {
			status: "error",
			failure,
			...(usage && { usage }),
			...(stack && { stack }),
			durationMs: Date.now() - startedAt,
			message: err instanceof Error ? err.message : String(err),
		};
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
	const extract = (key: string) => readMetadataValue(body, key);
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
	/** Final attempt per skill, plus the first attempt when it was retried. */
	agentRecords: AgentRecord[];
	/** Skills that owe the PR a whole-PR review: those that did not end ok this
	 * round, plus earlier pending skills this round did not clear. */
	pending: string[];
	/** Skills whose retry never started or was aborted for lack of time. */
	retrySkipped: string[];
	/** Pending skills that ended this round without a failure but still owe a
	 * whole-PR review (their input was incomplete, or they did not run). */
	owedCoverage?: string[];
	allSkillsCount: number;
	generalFindings: ModelFinding[];
	reviewComments: ReviewComment[];
	dropped: ModelInlineComment[];
	overflowCount: number;
	maxInlineComments: number;
	feedbackEnabled: boolean;
	survivingPrior: PersistedFinding[];
	/** Carried findings whose file is no longer in the PR; listed, never blocking. */
	retiredPrior?: PersistedFinding[];
	incrementalPass: boolean;
	priorSha: string;
	headSha: string;
	reviewCount: number;
	provider: string;
	model: string;
	cost: number;
	ledgerNote?: string;
	scopeNote?: ScopeNote;
}

type ScopeReason =
	| "first review"
	| "forced"
	| "triage"
	| "compare failed"
	| "compare truncated"
	| "baseline incomplete"
	| "same head";

/** Footer note saying whether a review was scoped to a delta or ran in full,
 * and why. */
export type ScopeNote =
	| `scope: delta from ${string} (${"kv" | "github"})`
	| `scope: full (${ScopeReason})`;

const skillLabel = (skill: string) => `\`${skill.replace(/\.md$/, "")}\``;

/**
 * Groups failed agents for the review body. Each skill lands in exactly one
 * group: retrySkipped wins over the error groups because a skipped retry leaves
 * the skill in both lists by design.
 */
function formatAgentNotices(opts: {
	skipped: string[];
	agentRecords: AgentRecord[];
	owedCoverage?: string[];
	retrySkipped: string[];
	allSkillsCount: number;
}): string[] {
	const { skipped, agentRecords, retrySkipped, allSkillsCount } = opts;
	const first = new Map<string, AgentRecord>();
	const last = new Map<string, AgentRecord>();
	for (const r of agentRecords) {
		if (r.attempt === 1) first.set(r.skill, r);
		last.set(r.skill, r);
	}
	const recovered: string[] = [];
	const afterRetry: string[] = [];
	const notRetried: string[] = [];
	const retryOutOfTime: string[] = [];
	const rateLimited: string[] = [];
	const quota: string[] = [];
	const withClass = (r: AgentRecord) =>
		`${skillLabel(r.skill)} (${r.class ?? "unknown"})`;
	const skippedSet = new Set(skipped.map(baseName));
	for (const [skill, r] of last) {
		if (skippedSet.has(skill)) continue;
		if (r.status === "ok") {
			const f = first.get(skill);
			if (r.attempt === 2 && f) recovered.push(withClass(f));
		} else if (r.status === "rate_limited") rateLimited.push(skillLabel(skill));
		else if (r.status === "quota_exhausted") quota.push(skillLabel(skill));
		else if (r.status === "error") {
			if (retrySkipped.map(baseName).includes(skill))
				retryOutOfTime.push(withClass(r));
			else if (r.attempt === 2) afterRetry.push(withClass(r));
			else notRetried.push(withClass(r));
		}
	}
	const rerun = "Re-run the review command for full coverage.";
	const count = (n: number) => `${n} of ${allSkillsCount} agent(s)`;
	const notices: string[] = [];
	if (skipped.length > 0) {
		notices.push(
			`> ⏱ **Partial review.** ${skipped.length} of ${allSkillsCount} agents did not run — this pass hit its time budget before reaching ${skipped
				.map(skillLabel)
				.join(", ")}. ${rerun}`,
		);
	}
	const warn = (icon: string, list: string[], what: string) => {
		if (list.length > 0) {
			notices.push(
				`> ${icon} **Partial review.** ${count(list.length)} ${what}: ${list.join(", ")}. ${rerun}`,
			);
		}
	};
	warn("⚠️", afterRetry, "failed after retry");
	warn("⚠️", notRetried, "failed, not retried");
	warn("⏱", retryOutOfTime, "retry skipped, out of time");
	warn("⚠️", rateLimited, "rate limited");
	warn("⚠️", quota, "out of quota");
	const owed = (opts.owedCoverage ?? []).map(skillLabel);
	if (owed.length > 0) {
		notices.push(
			`> ⚠️ **Partial review.** ${owed.join(", ")} still ${owed.length === 1 ? "owes" : "owe"} a review of the whole PR; ${owed.length === 1 ? "its" : "their"} input this round was incomplete or ${owed.length === 1 ? "it" : "they"} did not run.`,
		);
	}
	if (recovered.length > 0) {
		notices.push(
			`> ${count(recovered.length)} failed, then recovered on retry: ${recovered.join(", ")}.`,
		);
	}
	return notices;
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
		agentRecords,
		pending,
		retrySkipped,
		allSkillsCount,
		generalFindings,
		reviewComments,
		dropped,
		overflowCount,
		maxInlineComments,
		feedbackEnabled,
		survivingPrior,
		retiredPrior = [],
		incrementalPass,
		priorSha,
		headSha,
		reviewCount,
		provider,
		model,
		cost,
		ledgerNote,
		scopeNote,
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

	const budgetNotices = formatAgentNotices({
		skipped,
		agentRecords,
		owedCoverage: opts.owedCoverage,
		retrySkipped,
		allSkillsCount,
	});

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
	// A bullet list, not a badge table: the next round's baseline reads badge
	// rows back as open findings.
	const retiredBlock =
		retiredPrior.length > 0
			? `#### Retired, file no longer in this PR\n\nThese were carried from an earlier review, but their file is no longer part of this PR, so they no longer block. Their threads are unchanged.\n\n${retiredPrior
					.map(
						(f) =>
							`- ${f.severity} **${f.title}** (\`${f.path}${f.line != null ? `:${f.line}` : ""}\`)`,
					)
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
		`<!-- ai-review:provider=${provider} -->`,
		`<!-- ai-review:model=${model} -->`,
		`<!-- ai-review:findings=${generalFindings.length} -->`,
		`<!-- ai-review:cost=${cost.toFixed(6)} -->`,
		formatAgentsMarker(agentRecords, pending, KNOWN_SKILLS),
	].join("\n");

	const costFooter = `---\n*Model: ${model} · ${allSkillsCount} agents · $${cost.toFixed(6)}${ledgerNote ? ` · ${ledgerNote}` : ""}${scopeNote ? ` · ${scopeNote}` : ""} · [ai-review-bot](https://github.com/joeblackwaslike/ai-review-bot)*`;

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
		retiredBlock,
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
	hasCarriedOpen = false,
): string {
	const resolution = hasCarriedOpen
		? "No blocking issues. The findings listed below are still open but do not block."
		: isReReview
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

/** A carried finding with a path has a thread the author can settle through
 * the ledger, so it blocks at every severity. A path-less (general) finding
 * has no thread, so only P0 and P1 decide the verdict; P2 and P3 stay listed
 * as still open. */
function blocksVerdict(f: PersistedFinding): boolean {
	return Boolean(f.path) || f.severity === "P0" || f.severity === "P1";
}

export async function buildReview(
	context: ReviewContext,
): Promise<ReviewDecision | null> {
	// Always fetch existing reviews — used for both idempotency check and
	// cross-bot dedup (collecting what the other bot already reported).
	const existingReviews = await context.octokit.paginate<PullRequestReview>(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		{
			owner: context.owner,
			repo: context.repo,
			pull_number: context.pullNumber,
		},
	);

	const legacyMarker = `Reviewed commit: \`${context.headSha.slice(0, 12)}\``;

	if (!context.force) {
		const alreadyReviewed = existingReviews.some((review) => {
			const body = review.body ?? "";
			if (!body.includes(`### ${context.commentPrefix}`)) return false;
			const meta = parseReviewMetadata(body);
			if (meta) return meta.sha === context.headSha;
			return body.includes(legacyMarker);
		});

		if (alreadyReviewed) {
			return null;
		}
	}

	// Collect prior reviews for dedup injection into the prompt.
	// Sister bot (has our metadata block): include only if same SHA.
	// External bots (Code Rabbit, etc.): always include — the review delay ensures
	// they've completed before we run.
	const priorBotReviews = existingReviews
		.filter((review) => {
			const body = review.body ?? "";
			if (!body) return false;
			if (body.includes(`### ${context.commentPrefix}`)) return false;
			const meta = parseReviewMetadata(body);
			if (meta) return meta.sha === context.headSha;
			if (body.includes("Reviewed commit: `")) {
				return body.includes(legacyMarker);
			}
			return true;
		})
		.map((review) => review.body as string);

	const priorOwnReview =
		existingReviews
			.filter((review) => {
				const body = review.body ?? "";
				if (!body.includes(`### ${context.commentPrefix}`)) return false;
				const meta = parseReviewMetadata(body);
				if (meta) return meta.sha !== context.headSha;
				return (
					body.includes("Reviewed commit: `") && !body.includes(legacyMarker)
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

	// Triage gate (re-review only). On a re-review against an OLDER head SHA, a
	// cheap triage call decides whether to SKIP (post nothing, just re-stamp the
	// check-run), review only the delta (INCREMENTAL), or fall through to a FULL
	// review. The baseline comes from KV when it holds a state, else it is
	// derived from the latest own review on GitHub (src/baseline.ts).
	// resolvedKeys feed mergeReviews so already-fixed findings stop blocking;
	// scopedFiles is the surface the agents actually review.
	const resolvedKeys = new Set<string>();
	let scopedFiles = files; // FULL default
	// Findings to carry into the next persisted state on any pass that has a
	// baseline (INCREMENTAL or FULL, forced included): prior findings still
	// open, plus resolved tombstones (so future rounds can tell "resolved" from
	// "never existed"). REVIEWER_TUNING's showPriorOwnFindings tells agents on
	// every pass not to re-file a finding already on record as open, so a FULL
	// pass that doesn't re-raise a real, still-broken finding would otherwise
	// silently drop it from tracked state and could false-APPROVE past it. Both
	// stay empty on a first review.
	let survivingPrior: PersistedFinding[] = [];
	/** SHA the surviving findings were last reviewed against. */
	let priorSha = "";
	let resolvedTombstones: PersistedFinding[] = [];
	/** Subset of resolvedTombstones resolved by THIS round (delta triage or
	 * fallback revalidation) — not every historical tombstone. Fed to
	 * generateSummary as "confirmed resolved this round"; the full tombstone
	 * list also includes findings resolved in an earlier round, which may have
	 * since been reintroduced and re-flagged by this round's agents. */
	let resolvedThisRound: PersistedFinding[] = [];
	const resolvedNowIds = new Set<string>();
	/** Whether this pass reviewed only the delta (INCREMENTAL) rather than the
	 * whole file set (FULL) — changes how the "still open" carry-forward is
	 * explained, since a FULL pass did see these findings' files and chose not
	 * to restate them, while an INCREMENTAL pass never saw them at all. */
	let incrementalPass = false;
	const ownReviews = existingReviews.filter((review) =>
		(review.body ?? "").includes(`### ${context.commentPrefix}`),
	);
	const hasOwnReview = ownReviews.length > 0;
	/** A COMMENTED review neither clears a change request nor grants approval,
	 * and a DISMISSED one means the approval is gone. */
	const standingVerdict = ownReviews
		.filter((review) => STANDING_REVIEW_STATES.has(review.state ?? ""))
		.at(-1)?.state;
	const needsFreshApprove =
		standingVerdict === "CHANGES_REQUESTED" || standingVerdict === "DISMISSED";
	let ledgerLoad: ReturnType<typeof loadLedger> | undefined;
	const fetchLedger = () => {
		ledgerLoad ??= loadLedger(context.octokit, {
			owner: context.owner,
			repo: context.repo,
			pull: context.pullNumber,
			commentPrefix: context.commentPrefix,
		});
		return ledgerLoad;
	};
	const prLog = {
		owner: context.owner,
		repo: context.repo,
		pullNumber: context.pullNumber,
	};

	let state: ReviewState | null = null;
	if (context.kv) {
		try {
			state = await loadReviewState(
				context.kv,
				context.provider,
				context.owner,
				context.repo,
				context.pullNumber,
			);
		} catch (err) {
			// Forced reviews used to skip KV entirely, so a KV outage must not
			// start failing them now that they read it for carrying.
			if (!context.force) throw err;
			console.warn("KV state unavailable on a forced run; using none", {
				...prLog,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	const baselineSource: "kv" | "github" = state ? "kv" : "github";
	let baselineComplete = true;
	// The source is the latest own review at ANY head, unlike priorOwnReview
	// (older heads only, for the agent prompt): a forced run right after a
	// review at this head must still find that review's findings to carry. It
	// must carry a sha marker, so a human review quoting the heading is skipped.
	const sourceReview = ownReviews
		.filter((r) => {
			const body = r.body ?? "";
			return (
				readMetadataValue(body, "sha") !== undefined ||
				body.includes("Reviewed commit: `")
			);
		})
		.at(-1);
	if (!state && sourceReview) {
		const loaded = await fetchLedger();
		const derived = deriveBaseline(
			{ id: sourceReview.id ?? -1, body: sourceReview.body ?? "" },
			{
				entries: loaded.ledger,
				reviewIds: loaded.reviewIds,
				warm: loaded.warm,
			},
			KNOWN_SKILLS,
		);
		if (derived) {
			state = derived.state;
			baselineComplete = derived.complete;
			if (!derived.complete)
				console.warn("derived baseline is incomplete", {
					...prLog,
					sourceReviewId: sourceReview.id ?? null,
					why: loaded.warm
						? "source review is not in the ledger's review list"
						: "ledger is cold and the source review posted inline comments",
				});
		}
	}
	// Retargeted before the triage gate, so triage ids, markResolved, the SKIP
	// blocking check and persistence all see one list. A finding whose file is
	// not in the PR cannot anchor to the head and stops being carried.
	let retiredPrior: PersistedFinding[] = [];
	if (state) {
		const { kept, retired } = retargetCarried(
			state.findings.filter((f) => f.status === "open"),
			files,
		);
		retiredPrior = retired;
		state.findings = [
			...kept,
			...state.findings.filter((f) => f.status !== "open"),
		];
	}
	// Skills that still owe the PR a whole-PR review. One whose skill file is
	// gone is dropped; a Tier 2 one waits while Tier 2 is switched off.
	const priorPending = [...new Set(state?.incompleteSkills ?? [])].filter((s) =>
		KNOWN_SKILLS.has(s),
	);
	const scheduledPending = priorPending.filter(
		(s) => context.tier2Enabled || TIER1_SKILLS.includes(s),
	);
	const pendingSet = new Set(scheduledPending);
	/** Triage said SKIP but skills are pending: only those run, over the whole PR. */
	let pendingOnly = false;
	let skipVerdict: ReviewState["event"] = "COMMENT";
	const reviewCountBase =
		state?.reviewCount ??
		Math.max(
			0,
			...ownReviews.map((r) =>
				Number(
					readMetadataValue(r.body ?? "", "review")?.match(/^\d+$/)?.[0] ?? 0,
				),
			),
		);
	const carryVerdictForward = async (event: ReviewState["event"]) => {
		if (context.kv && state) {
			state.event = event;
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
		}
		await restampCheckRun(context, event);
	};
	const markResolved = (ids: readonly string[]) => {
		for (const f of state?.findings ?? []) {
			if (!ids.includes(f.id)) continue;
			f.status = "resolved";
			resolvedNowIds.add(f.id);
			if (f.path && f.line != null) {
				resolvedKeys.add(`inline:${f.path}:${f.line}`);
			}
			resolvedKeys.add(`general:${f.title.toLowerCase().trim()}`);
		}
	};
	const fullScope = (reason: ScopeReason): ScopeNote => {
		if (reason !== "forced" && reason !== "triage" && reason !== "first review")
			console.warn("delta unusable; running a full review", {
				...prLog,
				reason,
			});
		return `scope: full (${reason})`;
	};

	let scope: ScopeNote;
	if (!state) {
		scope = fullScope("first review");
	} else if (context.force) {
		scope = fullScope("forced");
	} else if (context.headSha.startsWith(state.lastReviewedSha)) {
		// KV saved this head but its review never posted, so there is no delta.
		scope = fullScope("same head");
	} else if (!baselineComplete) {
		scope = fullScope("baseline incomplete");
	} else {
		// One compare call gives the delta diff, its files and a truncation flag.
		// null means the delta is unusable (request threw, or history was
		// rewritten); a truncated list (300-file cap) is unusable too. Neither
		// reaches triage, so nothing is resolved on evidence declared incomplete.
		const deltaMeta = await fetchDeltaMeta(
			context.octokit,
			context.owner,
			context.repo,
			state.lastReviewedSha,
			context.headSha,
		);
		if (!deltaMeta || deltaMeta.truncated) {
			scope = fullScope(deltaMeta ? "compare truncated" : "compare failed");
		} else {
			const triage = await triageReReview(
				selection,
				deltaMeta.diff,
				state.findings.filter((f) => f.status === "open"),
				context.auth,
			);
			markResolved(triage.resolved);

			let skipNeedsApprove = false;
			if (triage.recommendation === "SKIP") {
				const isOpen = (f: PersistedFinding) => f.status === "open";
				if (hasOwnReview && state.findings.some(isOpen)) {
					const { ledger } = await fetchLedger();
					const unsettled = new Set(
						reconcileSurvivingPrior(state.findings.filter(isOpen), ledger),
					);
					state.findings = state.findings.filter(
						(f) => !isOpen(f) || unsettled.has(f),
					);
				}
				const stillBlocking = state.findings.some(
					(f) => isOpen(f) && blocksVerdict(f),
				);
				// A re-stamped check-run does not supersede a standing CHANGES_REQUESTED
				// review, so that case runs as INCREMENTAL and posts its APPROVE.
				skipNeedsApprove = !stillBlocking && needsFreshApprove;
				if (!skipNeedsApprove && scheduledPending.length > 0) {
					pendingOnly = true;
					skipVerdict = stillBlocking ? state.event : "APPROVE";
					console.log("triage SKIP; running only the pending skills", {
						...prLog,
						pending: scheduledPending,
					});
				} else if (!skipNeedsApprove) {
					console.log("review scope", {
						scope: `scope: delta from ${state.lastReviewedSha.slice(0, 7)} (${baselineSource})`,
						decision: "SKIP",
					});
					// A skill still owing coverage (a Tier 2 one waiting while Tier 2 is
					// off) keeps the verdict short of an approval.
					await carryVerdictForward(
						stillBlocking
							? state.event
							: priorPending.length > 0
								? "COMMENT"
								: "APPROVE",
					);
					return null; // nothing to post — the check-run carries the verdict
				}
			}

			if (
				triage.recommendation === "INCREMENTAL" ||
				skipNeedsApprove ||
				pendingOnly
			) {
				// A merge of the base branch puts files in the compare that the PR
				// does not change; only the PR's own files are reviewed.
				const prPaths = new Set(files.map((f) => f.filename));
				scopedFiles = deltaMeta.files.filter((f) => prPaths.has(f.filename));
				incrementalPass = true;
				scope = `scope: delta from ${state.lastReviewedSha.slice(0, 7)} (${baselineSource})`;
			} else {
				scope = fullScope("triage");
			}
		}
	}
	console.log("review scope", { scope });

	const loadedLedger = hasOwnReview ? await fetchLedger() : null;
	const ledger = loadedLedger?.ledger ?? [];
	if (state) {
		priorSha = state.lastReviewedSha;
		survivingPrior = reconcileSurvivingPrior(
			state.findings.filter((f) => f.status === "open"),
			ledger,
		);
		// A FULL round with a baseline carries every open finding. If a carried
		// finding's fix lands in such a round, no later delta contains it, so one
		// revalidation call checks the carried findings against the current
		// patches and resolves nothing on error.
		if (!incrementalPass && survivingPrior.length > 0) {
			markResolved(
				await revalidateFindings(
					selection,
					survivingPrior,
					files,
					context.auth,
				),
			);
			survivingPrior = survivingPrior.filter((f) => f.status === "open");
		}
		resolvedTombstones = state.findings.filter((f) => f.status === "resolved");
		resolvedThisRound = state.findings.filter((f) => resolvedNowIds.has(f.id));
	}
	const kvFindings = state?.findings ?? [];
	const kvMatches = kvFindings.map((f) => findSettledMatch(f, ledger));
	const kvMatchedIds = new Set(kvMatches.map((m) => m?.id));
	const ledgerOnlySettled = ledger.filter(
		(e) => isSettled(e) && !kvMatchedIds.has(e.id),
	);

	const scopedFilePaths = scopedFiles.map((f) => f.filename);

	const tuning: ReviewerTuning = REVIEWER_TUNING;
	const promptBase = {
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
		priorBotReviews,
		priorOwnReview,
		priorOwnFindings: tuning.showPriorOwnFindings
			? [
					...kvFindings.map((f, i) => {
						const settled = kvMatches[i];
						return {
							path: f.path,
							line: f.line,
							title: f.title,
							severity: f.severity,
							status: settled?.status ?? f.status,
							...(settled
								? { decidedBy: settled.decidedBy, reason: settled.reason }
								: {}),
						};
					}),
					...ledgerOnlySettled.map((e) => ({
						path: e.path,
						line: e.line,
						title: e.title,
						severity: e.severity,
						status: e.status,
						decidedBy: e.decidedBy,
						reason: e.reason,
					})),
				]
			: undefined,
	};

	// Detect Tier 2 skills relevant to this PR and run all agents together.
	// Keyed off scopedFiles so an INCREMENTAL pass only activates Tier 2 skills
	// for the surface actually under review. Pending skills run whether or not
	// detection selects them; a pending-only round runs nothing else.
	const detectedTier2 =
		context.tier2Enabled && !pendingOnly
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
	const detectedPaths = new Set(detectedTier2.map((m) => m.skillPath));
	const tier2Matches = [
		...detectedTier2,
		...scheduledPending
			.filter((s) => !TIER1_SKILLS.includes(s) && !detectedPaths.has(s))
			.map((skillPath) => ({
				skillPath,
				reason: "did not complete in an earlier review",
			})),
	];

	const tier1Items = TIER1_SKILLS.filter(
		(s) => !pendingOnly || pendingSet.has(s),
	).map((skillPath) => ({
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
	// across both tiers rather than always dropping all Tier2 agents. Pending
	// skills go first, so the deadline cuts the other agents before them. When
	// the pending skills get the whole PR and the rest the delta, one delta
	// agent still goes first: the first agent runs alone to warm the cache, and
	// a whole-PR warm-up would only help the pending skills.
	const queue = tier1Items
		.flatMap((t1, i) => {
			const t2 = tier2Items[i];
			return t2 !== undefined ? [t1, t2] : [t1];
		})
		.concat(tier2Items.slice(tier1Items.length));
	const isPending = (s: { skillPath: string }) =>
		pendingSet.has(baseName(s.skillPath));
	const pendingItems = queue.filter(isPending);
	const otherItems = queue.filter((s) => !isPending(s));
	const warmUp =
		incrementalPass && pendingItems.length > 0 ? otherItems.slice(0, 1) : [];
	const allSkills = [
		...warmUp,
		...pendingItems,
		...otherItems.slice(warmUp.length),
	];

	const skillName = (path: string) => path.split("/").pop() ?? path;
	// A pending skill reviews the PR's own files, as on a FULL round; the rest
	// keep the delta. Each message version is built only if some agent uses it.
	const wholePrFor = (skillPath: string) =>
		!incrementalPass || pendingSet.has(skillName(skillPath));
	const userMessages = new Map<boolean, string>();
	for (const { skillPath } of allSkills) {
		const wholePr = wholePrFor(skillPath);
		if (userMessages.has(wholePr)) continue;
		userMessages.set(
			wholePr,
			buildUserMessage({
				...promptBase,
				files: wholePr ? files : scopedFiles,
				diffScope: wholePr
					? undefined
					: `INCREMENTAL — only files changed since ${priorSha.slice(0, 12)}. Continue any threads already open on other files; do not refile findings for files not shown in this diff.`,
			}),
		);
	}

	let lastRateLimit: RateLimitInfo | undefined;
	const deadline = Date.now() + context.agentBudgetMs;
	const dispatch = async (skillPath: string): Promise<AgentOutcome> => {
		const outcome = await runAgent(
			skillPath,
			userMessages.get(wholePrFor(skillPath)) ?? "",
			selection,
			customPrompt,
			{
				auth: context.auth,
				prompt: { strictEvidenceRules: tuning.strictEvidenceRules },
				abortSignal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
			},
		);
		// At the default concurrency 4 this is a benign best-effort race between
		// concurrent agents (pacing only needs an approximate recent signal).
		if (outcome.status === "ok" || outcome.status === "rate_limited") {
			lastRateLimit = outcome.rateLimit;
		}
		return outcome;
	};
	const paceNext = async (
		next: { idx: number } | { skill: string },
	): Promise<void> => {
		const delay = capPaceToDeadline(
			computePaceDelayMs(lastRateLimit, Date.now()),
			Date.now(),
			deadline,
		);
		if (delay > 0) {
			console.log("pacing before next agent", { ...next, delayMs: delay });
			await sleep(delay);
		}
	};
	const firstOutcomes = await mapWithConcurrency(
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
			const outcome = await dispatch(skillPath);
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
			serialFirst: true,
			onBeforeEach: async (i) => {
				if (i === 0) return; // nothing learned yet
				await paceNext({ idx: i + 1 });
			},
		},
	);

	const logAttempts = (batch: AgentAttempt[]) => {
		const messages: Record<string, string> = {};
		const stacks: Record<string, string> = {};
		for (const { skill, outcome } of batch) {
			if (outcome.status === "error" && outcome.message !== undefined) {
				messages[skill] = outcome.message;
			}
			if (outcome.status === "error" && outcome.stack !== undefined) {
				stacks[skill] = outcome.stack;
			}
		}
		logAgentRecords(
			batch.map((a) => toRecord(a.skill, a.attempt, a.outcome)),
			{
				owner: context.owner,
				repo: context.repo,
				pr: context.pullNumber,
				sha: context.headSha,
				provider: context.provider,
				model: selection.model,
				messages,
				stacks,
			},
		);
	};
	const attempts: AgentAttempt[] = firstOutcomes.map((outcome, i) => ({
		skill: skillName(allSkills[i]?.skillPath ?? "unknown"),
		attempt: 1,
		outcome,
	}));
	logAttempts(attempts);

	// One retry per retryable failure, only while enough of the original
	// deadline is left: at least 30s, and at least as long as the first attempt
	// took. Checked at collection and again right before dispatch, since pacing
	// can use up the time in between.
	const retrySkipped: string[] = [];
	const hasRetryTime = (first: AgentOutcome) =>
		deadline - Date.now() >=
		Math.max(
			MIN_RETRY_WINDOW_MS,
			first.status === "error" ? first.durationMs : 0,
		);
	const skipRetry = (skill: string) => {
		retrySkipped.push(skill);
		console.warn("agent retry skipped: out of time", {
			skill,
			leftMs: deadline - Date.now(),
		});
	};
	const toRetry = firstOutcomes.flatMap((o, i) => {
		if (o.status !== "error" || !o.failure.retryable) return [];
		if (hasRetryTime(o)) return [i];
		skipRetry(attempts[i].skill);
		return [];
	});
	// Paced from its first agent on, since the first pass already learned the
	// provider's pressure. No serialFirst: one warm-up covers one shared prefix,
	// and a transport failure says nothing about the cache.
	const retried = await mapWithConcurrency(
		toRetry,
		Math.min(context.agentConcurrency, toRetry.length),
		async (i): Promise<AgentAttempt | undefined> => {
			const { skill } = attempts[i];
			if (!hasRetryTime(firstOutcomes[i])) {
				skipRetry(skill);
				return undefined;
			}
			const t0 = Date.now();
			const outcome = await dispatch(allSkills[i].skillPath);
			console.log("agent retry done", {
				skill,
				status: outcome.status,
				ms: Date.now() - t0,
			});
			// Aborted at the deadline: the retry ran out of time, and the first
			// attempt's failure stays the agent's result.
			if (outcome.status === "skipped") skipRetry(skill);
			return { skill, attempt: 2, outcome };
		},
		{ onBeforeEach: (n) => paceNext({ skill: attempts[toRetry[n]].skill }) },
	);
	const retryAttempts = retried.filter(
		(a): a is AgentAttempt => a !== undefined,
	);
	logAttempts(retryAttempts);
	attempts.push(...retryAttempts);
	const outcomes = firstOutcomes.map((first, i) => {
		const retry = retried[toRetry.indexOf(i)]?.outcome;
		return retry && retry.status !== "skipped" ? retry : first;
	});

	const agentResults: ModelReview[] = [];
	const rateLimited: RateLimitInfo[] = [];
	const quotaExhausted: ModelSelection["provider"][] = [];
	const skipped: string[] = [];
	const errored: string[] = [];
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;

	// Every attempt is billed, including a failed first attempt whose retry
	// then succeeded.
	for (const { outcome: o } of attempts) {
		if ((o.status === "ok" || o.status === "error") && o.usage) {
			totalPromptTokens += o.usage.promptTokens;
			totalCompletionTokens += o.usage.completionTokens;
		}
	}

	outcomes.forEach((o, i) => {
		if (o.status === "ok") {
			agentResults.push(o.review);
		} else if (o.status === "rate_limited") {
			rateLimited.push(o.rateLimit);
		} else if (o.status === "quota_exhausted") {
			quotaExhausted.push(o.provider);
		} else if (o.status === "skipped") {
			skipped.push(o.skillPath);
		} else if (o.status === "error") {
			// The outcome records were logged above; this attaches the failure to
			// the review itself, so a crashed agent does not read the same as one
			// that ran clean and found nothing.
			errored.push(allSkills[i]?.skillPath ?? "unknown");
		}
	});

	if (skipped.length > 0) {
		console.warn("review ran out of time budget", {
			completed: agentResults.length,
			skipped,
		});
	}

	const agentRecords = attempts
		.filter((a) => !(a.attempt === 2 && a.outcome.status === "skipped"))
		.map((a) => toRecord(a.skill, a.attempt, a.outcome));
	// A pending skill clears only on an ok run over the whole PR with nothing
	// missing or trimmed. Pending afterwards: what was pending and did not
	// clear (run or not), plus every skill that ran this round and did not end ok.
	const inputComplete = wholePrInputComplete(files, context.changedFiles);
	const ranNames = allSkills.map((s) => skillName(s.skillPath));
	const cleared = scheduledPending.filter((s) => {
		const i = ranNames.indexOf(s);
		return i >= 0 && outcomes[i]?.status === "ok" && inputComplete;
	});
	const pending = [
		...new Set([
			...priorPending.filter((s) => !cleared.includes(s)),
			...ranNames.filter((_, i) => outcomes[i]?.status !== "ok"),
		]),
	];
	if (priorPending.length > 0 || pending.length > 0) {
		console.log("pending coverage", {
			...prLog,
			prior: priorPending,
			cleared,
			pending,
			inputComplete,
		});
	}
	const skipFallback = async (): Promise<null> => {
		console.log("pending skills changed nothing; keeping the SKIP verdict", {
			...prLog,
			cleared,
			pending,
		});
		if (state) state.incompleteSkills = pending;
		await carryVerdictForward(
			skipVerdict === "APPROVE" && pending.length > 0 ? "COMMENT" : skipVerdict,
		);
		return null;
	};
	if (pendingOnly && agentResults.length === 0) return skipFallback();

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
		quotaExhausted: quotaExhausted.length,
		errored: errored.length,
		notOk: allSkills.length - agentResults.length,
	});

	let suppressedCount = 0;
	const suppressedEntryIds = new Set<string>();
	const unsettledResults = agentResults.map((r) => {
		const outcome = suppressInReview(r, ledger);
		suppressedCount += outcome.suppressed.length;
		for (const { finding, entry } of outcome.suppressed) {
			suppressedEntryIds.add(entry.id);
			console.log("suppressed settled repeat", {
				title: finding.title,
				path: finding.path ?? null,
				line: finding.line ?? null,
				severity: finding.severity ?? null,
				entryId: entry.id,
				entryStatus: entry.status,
			});
		}
		return outcome.review;
	});
	if (loadedLedger) {
		console.log("ledger suppression", {
			warm: loadedLedger.warm,
			entries: ledger.length,
			suppressed: suppressedCount,
			settledEntries: suppressedEntryIds.size,
		});
	}

	const mergeOutcome = mergeReviewsDetailed(unsettledResults, resolvedKeys, {
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

	// A pending-only run on a triage SKIP that cleared nothing and found
	// nothing new would only repost the previous review.
	if (
		pendingOnly &&
		cleared.length === 0 &&
		modelReview.general_findings.length === 0 &&
		modelReview.inline_comments.length === 0
	)
		return skipFallback();

	// Anchors come from the PR's own patches: a compare patch can hold lines
	// from a base-branch merge that the PR diff does not have, and a comment
	// on one of those would make GitHub reject the review. A skill given the
	// whole PR may anchor anywhere in it.
	const scopedPathSet = new Set(scopedFilePaths);
	const anchorFiles = allSkills.some((s) => wholePrFor(s.skillPath))
		? files
		: files.filter((f) => scopedPathSet.has(f.filename));
	const validLines = buildValidLinesByPath(anchorFiles);

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
		anchorFiles,
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
	// A skill that still owes the PR a whole-PR review makes the round partial too.
	const allAgentsSucceeded = agentResults.length === allSkills.length;
	const cleanDelta =
		allAgentsSucceeded &&
		pending.length === 0 &&
		modelReview.event === "COMMENT" &&
		modelReview.general_findings.length === 0 &&
		// What the agents found, not what GitHub would accept. Measuring the
		// posted comments meant a review whose only finding failed to anchor
		// approved the PR while printing that finding in its own body.
		modelReview.inline_comments.length === 0;
	// An INCREMENTAL pass that left prior findings unresolved still blocks even if
	// the delta itself was clean — those findings live on files the agents never
	// reviewed this round. Force REQUEST_CHANGES so a clean delta can't APPROVE
	// away a still-open blocking finding (C1). Path-less P2/P3 findings stay
	// listed but do not block (see blocksVerdict).
	const blockingPrior = survivingPrior.filter(blocksVerdict);
	const finalEvent: ReviewDecision["event"] =
		blockingPrior.length > 0
			? "REQUEST_CHANGES"
			: cleanDelta
				? "APPROVE"
				: modelReview.event;

	// A round that cleared a pending skill always posts, so the agents marker
	// on GitHub stops listing it.
	if (
		finalEvent === "APPROVE" &&
		hasOwnReview &&
		!needsFreshApprove &&
		!context.force &&
		cleared.length === 0
	) {
		console.log("nothing new since the last review; posting nothing", {
			suppressed: suppressedCount,
			agents: agentResults.length,
		});
		// Only non-blocking findings can still be carried here; every other open
		// KV finding was settled by the ledger, and saving those open would let
		// a later cold-ledger run block.
		const carriedIds = new Set(survivingPrior.map((f) => f.id));
		if (state) {
			state.findings = state.findings.map((f) =>
				f.status === "open" && !carriedIds.has(f.id)
					? { ...f, status: "resolved" }
					: f,
			);
			state.incompleteSkills = pending;
		}
		await carryVerdictForward(
			standingVerdict === "APPROVED" ? "APPROVE" : "COMMENT",
		);
		return null;
	}

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
			survivingPrior.length > 0,
		);
	}

	const postedKeys = new Set(reviewComments.map((c) => `${c.path}:${c.line}`));
	const dropped = effectiveInlineComments.filter(
		(c) => !postedKeys.has(`${c.path}:${c.line}`),
	);

	const hasP0 =
		modelReview.general_findings.some((f) => f.severity === "P0") ||
		modelReview.inline_comments.some((c) => c.severity === "P0") ||
		survivingPrior.some((f) => f.severity === "P0");
	const readiness = computeReadinessScore({
		event: finalEvent,
		hasP0,
		survivingPrior: blockingPrior.map((f) => f.id),
		partial:
			skipped.length > 0 ||
			errored.length > 0 ||
			rateLimited.length > 0 ||
			quotaExhausted.length > 0 ||
			pending.length > 0,
	});

	const body = formatReviewBody({
		commentPrefix: context.commentPrefix,
		finalEvent,
		summary,
		approvalMessage,
		readiness,
		tier2Matches,
		skipped,
		agentRecords,
		pending,
		owedCoverage: pending.filter(
			(s) => !ranNames.some((n, i) => n === s && outcomes[i]?.status !== "ok"),
		),
		retrySkipped,
		allSkillsCount: allSkills.length,
		generalFindings: modelReview.general_findings,
		reviewComments,
		dropped,
		overflowCount: overflowComments.length,
		maxInlineComments: MAX_INLINE_COMMENTS,
		feedbackEnabled: context.feedbackEnabled,
		survivingPrior,
		retiredPrior,
		incrementalPass,
		priorSha,
		headSha: context.headSha,
		reviewCount: reviewCountBase + 1,
		provider: selection.provider,
		model: selection.model,
		cost,
		ledgerNote: loadedLedger
			? loadedLedger.warm
				? `ledger: warm, ${suppressedEntryIds.size} suppressed`
				: "ledger: cold"
			: undefined,
		scopeNote: scope,
	});

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
		// and resolvedTombstones are empty only when there was no baseline.
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
			reviewCount: reviewCountBase,
			incompleteSkills: pending,
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
