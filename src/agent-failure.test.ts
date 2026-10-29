import { APICallError } from "@ai-sdk/provider";
import { NoObjectGeneratedError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyAgentError } from "./agent-failure.js";

const usage = {} as never;
const response = {} as never;

const noObject = (finishReason: string, text?: string) =>
	new NoObjectGeneratedError({
		message: "x",
		text,
		response,
		usage,
		finishReason: finishReason as never,
	});

const api = (statusCode?: number, cause?: unknown) =>
	new APICallError({
		message: "x",
		url: "https://example.test",
		requestBodyValues: {},
		statusCode,
		cause,
	});

const retry = (lastError: unknown) =>
	new RetryError({
		message: "x",
		reason: "maxRetriesExceeded",
		errors: [lastError],
	});

const netErr = (code: string) =>
	Object.assign(new TypeError("fetch failed"), {
		cause: Object.assign(new Error("boom"), { code }),
	});

describe("classifyAgentError", () => {
	it("content-filter finish reason is content_refused", () => {
		expect(classifyAgentError(noObject("content-filter", "{}"))).toEqual({
			class: "content_refused",
			retryable: false,
			finishReason: "content-filter",
			errorName: "AI_NoObjectGeneratedError",
		});
	});

	it("length is output_truncated", () => {
		const r = classifyAgentError(noObject("length", "{"));
		expect(r).toMatchObject({
			class: "output_truncated",
			retryable: false,
			finishReason: "length",
		});
	});

	it("empty text is no_output and retryable", () => {
		for (const t of [undefined, "", "  "]) {
			expect(classifyAgentError(noObject("stop", t))).toMatchObject({
				class: "no_output",
				retryable: true,
			});
		}
	});

	it("other text is schema_mismatch and retryable", () => {
		expect(classifyAgentError(noObject("stop", "not json"))).toMatchObject({
			class: "schema_mismatch",
			retryable: true,
			errorName: "AI_NoObjectGeneratedError",
		});
	});

	it.each([
		[401, "auth", false],
		[403, "auth", false],
		[408, "transient_http", true],
		[409, "transient_http", true],
		[500, "transient_http", true],
		[529, "transient_http", true],
		[400, "invalid_request", false],
		[404, "invalid_request", false],
		[422, "invalid_request", false],
	])("status %i is %s", (status, cls, retryable) => {
		expect(classifyAgentError(api(status))).toEqual({
			class: cls,
			retryable,
			httpStatus: status,
			errorName: "AI_APICallError",
		});
	});

	it("429 is not classified here", () => {
		expect(classifyAgentError(api(429))).toMatchObject({
			class: "unknown",
			retryable: false,
			httpStatus: 429,
		});
	});

	it("unwraps RetryError around each recognized error", () => {
		expect(classifyAgentError(retry(api(503)))).toMatchObject({
			class: "transient_http",
			httpStatus: 503,
			errorName: "AI_APICallError",
		});
		expect(classifyAgentError(retry(noObject("length", "{")))).toMatchObject({
			class: "output_truncated",
			errorName: "AI_NoObjectGeneratedError",
		});
	});

	it("finds a recognized error in the cause chain", () => {
		const wrapped = new Error("outer", { cause: api(401) });
		expect(classifyAgentError(wrapped)).toMatchObject({
			class: "auth",
			errorName: "AI_APICallError",
		});
	});

	it("network code on cause is network", () => {
		for (const code of ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"]) {
			expect(classifyAgentError(netErr(code))).toEqual({
				class: "network",
				retryable: true,
				errorName: "Error",
			});
		}
	});

	it("network error inside RetryError and APICallError without status", () => {
		expect(classifyAgentError(retry(netErr("ECONNRESET")))).toMatchObject({
			class: "network",
			errorName: "AI_RetryError",
		});
		expect(
			classifyAgentError(
				api(undefined, Object.assign(new Error("x"), { code: "ENOTFOUND" })),
			),
		).toMatchObject({ class: "network", errorName: "AI_APICallError" });
	});

	it("fetch failed without a code is unknown", () => {
		expect(classifyAgentError(new TypeError("fetch failed"))).toEqual({
			class: "unknown",
			retryable: false,
			errorName: "Error",
		});
	});

	it("plain TypeError is unknown", () => {
		expect(classifyAgentError(new TypeError("x is undefined"))).toMatchObject({
			class: "unknown",
			errorName: "Error",
		});
	});

	it("content-filter and length win over empty text", () => {
		expect(classifyAgentError(noObject("content-filter", ""))).toMatchObject({
			class: "content_refused",
		});
		expect(classifyAgentError(noObject("length", undefined))).toMatchObject({
			class: "output_truncated",
		});
	});

	it("a network-code cause does not override the HTTP status", () => {
		const cause = Object.assign(new Error("x"), { code: "ECONNRESET" });
		expect(classifyAgentError(api(500, cause))).toMatchObject({
			class: "transient_http",
			httpStatus: 500,
		});
		expect(classifyAgentError(api(429, cause))).toMatchObject({
			class: "unknown",
			httpStatus: 429,
		});
		expect(classifyAgentError(api(400, cause))).toMatchObject({
			class: "invalid_request",
			httpStatus: 400,
		});
	});

	it("null and undefined are unknown/other", () => {
		for (const v of [null, undefined]) {
			expect(classifyAgentError(v)).toEqual({
				class: "unknown",
				retryable: false,
				errorName: "other",
			});
		}
	});

	it("a circular cause chain terminates", () => {
		const a = new Error("a");
		const b = new Error("b", { cause: a });
		(a as { cause?: unknown }).cause = b;
		expect(classifyAgentError(a)).toMatchObject({ class: "unknown" });
	});

	it("thrown string is unknown/other", () => {
		expect(classifyAgentError("boom")).toEqual({
			class: "unknown",
			retryable: false,
			errorName: "other",
		});
	});
});
