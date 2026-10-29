/*
 * SDK facts, confirmed against installed declarations:
 * - NoObjectGeneratedError (ai): .name "AI_NoObjectGeneratedError"; fields text?: string,
 *   finishReason?: 'stop'|'length'|'content-filter'|'tool-calls'|'error'|'other', usage, response;
 *   static isInstance.
 * - APICallError (@ai-sdk/provider): .name "AI_APICallError"; fields statusCode?: number,
 *   isRetryable: boolean; static isInstance.
 * - RetryError (ai): .name "AI_RetryError"; fields lastError: unknown, errors: unknown[],
 *   reason; cause is NOT set, so unwrap lastError. static isInstance.
 */
import { APICallError } from "@ai-sdk/provider";
import { NoObjectGeneratedError, RetryError } from "ai";

export type FailureClass =
	| "content_refused"
	| "output_truncated"
	| "no_output"
	| "schema_mismatch"
	| "auth"
	| "transient_http"
	| "invalid_request"
	| "network"
	| "unknown";

export type ErrorName =
	| "AI_NoObjectGeneratedError"
	| "AI_APICallError"
	| "AI_RetryError"
	| "Error"
	| "other";

export interface AgentFailure {
	class: FailureClass;
	retryable: boolean;
	httpStatus?: number;
	finishReason?: string;
	errorName: ErrorName;
}

const MAX_CAUSE_DEPTH = 3;
const NETWORK_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"EPIPE",
]);

const isNetworkCode = (code: unknown): boolean =>
	typeof code === "string" &&
	(NETWORK_CODES.has(code) || code.startsWith("UND_ERR_"));

const causeOf = (e: unknown): unknown =>
	e instanceof Error ? e.cause : undefined;

function hasNetworkCode(err: unknown): boolean {
	let cur = err;
	for (let i = 0; i <= MAX_CAUSE_DEPTH && cur != null; i++) {
		if (isNetworkCode((cur as { code?: unknown }).code)) return true;
		cur = causeOf(cur);
	}
	return false;
}

function result(
	cls: FailureClass,
	retryable: boolean,
	errorName: ErrorName,
	extra: { httpStatus?: number; finishReason?: string } = {},
): AgentFailure {
	return {
		class: cls,
		retryable,
		...(extra.httpStatus !== undefined && { httpStatus: extra.httpStatus }),
		...(extra.finishReason !== undefined && {
			finishReason: extra.finishReason,
		}),
		errorName,
	};
}

function classifyApiStatus(
	status: number,
): { cls: FailureClass; retryable: boolean } | null {
	if (status === 401 || status === 403)
		return { cls: "auth", retryable: false };
	if (status === 408 || status === 409 || status >= 500) {
		return { cls: "transient_http", retryable: true };
	}
	if (status >= 400 && status !== 429) {
		return { cls: "invalid_request", retryable: false };
	}
	return null;
}

/** Classify a thrown agent error per the spec's precedence table. Pure. */
export function classifyAgentError(err: unknown): AgentFailure {
	const wasRetry = RetryError.isInstance(err);
	const cur: unknown = wasRetry ? (err as RetryError).lastError : err;

	let recognized: NoObjectGeneratedError | APICallError | undefined;
	let probe = cur;
	for (let i = 0; i <= MAX_CAUSE_DEPTH && probe != null; i++) {
		if (
			NoObjectGeneratedError.isInstance(probe) ||
			APICallError.isInstance(probe)
		) {
			recognized = probe;
			break;
		}
		probe = causeOf(probe);
	}

	if (recognized && NoObjectGeneratedError.isInstance(recognized)) {
		const name = "AI_NoObjectGeneratedError";
		const finishReason = recognized.finishReason;
		const extra = finishReason ? { finishReason } : {};
		if (finishReason === "content-filter") {
			return result("content_refused", false, name, extra);
		}
		if (finishReason === "length") {
			return result("output_truncated", false, name, extra);
		}
		if (!recognized.text?.trim()) return result("no_output", true, name, extra);
		return result("schema_mismatch", true, name, extra);
	}

	if (recognized) {
		const status = (recognized as APICallError).statusCode;
		const name = "AI_APICallError";
		if (status !== undefined) {
			const c = classifyApiStatus(status);
			if (c) return result(c.cls, c.retryable, name, { httpStatus: status });
			return result("unknown", false, name, { httpStatus: status });
		}
		if (hasNetworkCode(recognized)) return result("network", true, name);
		return result("unknown", false, name);
	}

	const name: ErrorName = wasRetry
		? "AI_RetryError"
		: cur instanceof Error
			? "Error"
			: "other";
	if (hasNetworkCode(cur)) return result("network", true, name);
	return result("unknown", false, name);
}
