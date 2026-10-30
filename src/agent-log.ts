import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentFailure, ErrorName, FailureClass } from "./agent-failure.js";
import { readMetadataBlock } from "./review-metadata.js";

export type AgentStatus =
	| "ok"
	| "error"
	| "rate_limited"
	| "quota_exhausted"
	| "skipped";

export interface AgentRecord {
	skill: string;
	attempt: 1 | 2;
	status: AgentStatus;
	class?: FailureClass;
	retryable?: boolean;
	httpStatus?: number;
	finishReason?: string;
	errorName?: ErrorName;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
}

interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
}

/** Structural mirror of AgentOutcome without the review payload. */
export type OutcomeLike =
	| { status: "ok"; usage: TokenUsage; durationMs: number }
	| {
			status: "error";
			failure: AgentFailure;
			usage?: TokenUsage;
			durationMs: number;
			message?: string;
	  }
	| { status: "rate_limited" }
	| { status: "quota_exhausted" }
	| { status: "skipped" };

export interface AgentLogContext {
	owner: string;
	repo: string;
	pr: number;
	sha: string;
	provider: string;
	model: string;
	messages?: Record<string, string>;
	/** Stack frames of `unknown` failures, for the console line only. */
	stacks?: Record<string, string>;
}

const STATUSES: readonly AgentStatus[] = [
	"ok",
	"error",
	"rate_limited",
	"quota_exhausted",
	"skipped",
];
const CLASSES: readonly FailureClass[] = [
	"content_refused",
	"output_truncated",
	"no_output",
	"schema_mismatch",
	"auth",
	"transient_http",
	"invalid_request",
	"network",
	"unknown",
];
const ERROR_NAMES: readonly ErrorName[] = [
	"AI_NoObjectGeneratedError",
	"AI_APICallError",
	"AI_RetryError",
	"Error",
	"other",
];

const MARKER_PREFIX = "<!-- ai-review:agents=";
const MARKER_SUFFIX = " -->";
const SOFT_MAX_RECORDS = 20;
const SOFT_MAX_MARKER_BYTES = 4096;
const MAX_RECORDS = 40;
const MAX_MARKER_BYTES = 16384;
const MAX_FINISH_REASON = 40;
const MAX_MESSAGE = 300;
const MAX_STACK = 1500;

export function toRecord(
	skill: string,
	attempt: 1 | 2,
	outcome: OutcomeLike,
): AgentRecord {
	const base = { skill, attempt, status: outcome.status };
	if (outcome.status === "ok") {
		return {
			...base,
			durationMs: outcome.durationMs,
			inputTokens: outcome.usage.promptTokens,
			outputTokens: outcome.usage.completionTokens,
		};
	}
	if (outcome.status !== "error") return base;
	const f = outcome.failure;
	return {
		...base,
		class: f.class,
		retryable: f.retryable,
		...(f.httpStatus !== undefined && { httpStatus: f.httpStatus }),
		...(f.finishReason !== undefined && { finishReason: f.finishReason }),
		errorName: f.errorName,
		durationMs: outcome.durationMs,
		...(outcome.usage && {
			inputTokens: outcome.usage.promptTokens,
			outputTokens: outcome.usage.completionTokens,
		}),
	};
}

const escapeJson = (json: string): string =>
	json.replace(
		/[\s<>]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);

const render = (records: AgentRecord[], pending: string[]): string =>
	`${MARKER_PREFIX}${escapeJson(JSON.stringify({ r: records, p: pending }))}${MARKER_SUFFIX}`;

/** The whole `<!-- ai-review:agents=<json> -->` line, within the size bound. */
export function formatAgentsMarker(
	records: AgentRecord[],
	pending: string[],
	knownSkills: ReadonlySet<string>,
): string {
	let kept = records
		.map((r) => validRecord(r, knownSkills))
		.filter((r): r is AgentRecord => r !== null);
	const retried = new Set(
		kept.filter((r) => r.attempt === 2).map((r) => r.skill),
	);
	const isRetriedFirst = (r: AgentRecord) =>
		r.attempt === 1 && retried.has(r.skill);
	const dropOrder = [
		...kept.filter((r) => r.status === "ok" && isRetriedFirst(r)),
		...kept.filter((r) => r.status === "ok" && !isRetriedFirst(r)),
	];
	const pend = pending.filter((s) => knownSkills.has(s));
	const tooBig = () =>
		kept.length > SOFT_MAX_RECORDS ||
		render(kept, pend).length > SOFT_MAX_MARKER_BYTES;
	for (const victim of dropOrder) {
		if (!tooBig()) break;
		kept = kept.filter((r) => r !== victim);
	}
	for (const victim of kept.filter(isRetriedFirst)) {
		if (kept.length <= MAX_RECORDS) break;
		kept = kept.filter((r) => r !== victim);
	}
	if (kept.length > MAX_RECORDS) kept = kept.slice(-MAX_RECORDS);
	return render(kept, pend);
}

const isCount = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;

function validRecord(
	raw: unknown,
	knownSkills: ReadonlySet<string>,
): AgentRecord | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.skill !== "string" || !knownSkills.has(o.skill)) return null;
	if (o.attempt !== 1 && o.attempt !== 2) return null;
	if (!STATUSES.includes(o.status as AgentStatus)) return null;
	const rec: AgentRecord = {
		skill: o.skill,
		attempt: o.attempt,
		status: o.status as AgentStatus,
	};
	if (o.class !== undefined) {
		if (!CLASSES.includes(o.class as FailureClass)) return null;
		rec.class = o.class as FailureClass;
	}
	if (o.errorName !== undefined) {
		if (!ERROR_NAMES.includes(o.errorName as ErrorName)) return null;
		rec.errorName = o.errorName as ErrorName;
	}
	if (o.retryable !== undefined) {
		if (typeof o.retryable !== "boolean") return null;
		rec.retryable = o.retryable;
	}
	if (o.finishReason !== undefined) {
		if (typeof o.finishReason !== "string") return null;
		rec.finishReason = o.finishReason.slice(0, MAX_FINISH_REASON);
	}
	for (const key of [
		"httpStatus",
		"durationMs",
		"inputTokens",
		"outputTokens",
	] as const) {
		if (o[key] === undefined) continue;
		if (!isCount(o[key])) return null;
		rec[key] = o[key];
	}
	return rec;
}

/** Reads the agents marker from the metadata block; null if absent or invalid. */
export function parseAgentsMarker(
	body: string,
	knownSkills: ReadonlySet<string>,
): { records: AgentRecord[]; pending: string[] } | null {
	const raw = readMetadataBlock(body)?.get("agents");
	if (!raw || raw.length > MAX_MARKER_BYTES) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { r, p } = parsed as { r?: unknown; p?: unknown };
	const records = (Array.isArray(r) ? r : [])
		.slice(0, MAX_RECORDS)
		.map((x) => validRecord(x, knownSkills))
		.filter((x): x is AgentRecord => x !== null);
	const pending = (Array.isArray(p) ? p : []).filter(
		(s): s is string => typeof s === "string" && knownSkills.has(s),
	);
	if (records.length === 0 && pending.length === 0) return null;
	return { records, pending };
}

let logFilePath: string | null = null;

/** Turns on the local JSONL sink. Only the CLI calls this, never webhook code.
 * The path is the argument, else `AI_REVIEW_LOG_FILE`, else
 * `~/.ai-review/logs/agents.jsonl`, outside any repository. */
export function enableAgentLogFile(path?: string): void {
	logFilePath =
		path ||
		process.env.AI_REVIEW_LOG_FILE ||
		join(homedir(), ".ai-review", "logs", "agents.jsonl");
}

export function disableAgentLogFile(): void {
	logFilePath = null;
}

export function logAgentRecords(
	records: AgentRecord[],
	ctx: AgentLogContext,
): void {
	const { messages, stacks, ...ids } = ctx;
	for (const record of records) {
		const message = messages?.[record.skill]?.slice(0, MAX_MESSAGE);
		const stack = stacks?.[record.skill]?.slice(0, MAX_STACK);
		console.log("agent outcome", {
			...ids,
			...record,
			...(message !== undefined && { message }),
			...(stack !== undefined && { stack }),
		});
	}
	if (!logFilePath) return;
	try {
		mkdirSync(dirname(logFilePath), { recursive: true });
		const ts = new Date().toISOString();
		const lines = records.map((record) => {
			const message = messages?.[record.skill]?.slice(0, MAX_MESSAGE);
			return JSON.stringify({
				ts,
				...ids,
				...record,
				...(message !== undefined && { message }),
			});
		});
		if (lines.length > 0) appendFileSync(logFilePath, `${lines.join("\n")}\n`);
	} catch (err) {
		console.error("agent log file write failed", err);
	}
}
