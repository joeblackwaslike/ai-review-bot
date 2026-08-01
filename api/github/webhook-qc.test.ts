import type { VercelRequest, VercelResponse } from "@vercel/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./webhook-qc.js";

const verify = vi.fn();
const verifyAndReceive = vi.fn();

vi.mock("@vercel/functions", () => ({
	waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock("../../src/http.js", () => ({
	readRawBody: async () => Buffer.from('{"action":"created"}', "utf8"),
}));

vi.mock("../../src/qc-app.js", () => ({
	getQcApp: () => ({
		webhooks: {
			verify: (...args: unknown[]) => verify(...args),
			verifyAndReceive: (...args: unknown[]) => verifyAndReceive(...args),
		},
	}),
}));

function stubRes() {
	const res = {
		statusCode: 0,
		body: undefined as unknown,
		headers: {} as Record<string, string>,
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(payload: unknown) {
			res.body = payload;
			return res;
		},
		setHeader(name: string, value: string) {
			res.headers[name] = value;
			return res;
		},
	};
	return res;
}

function stubReq(over: Partial<VercelRequest> = {}): VercelRequest {
	return {
		method: "POST",
		headers: {
			"x-github-delivery": "d1",
			"x-github-event": "issue_comment",
			"x-hub-signature-256": "sha256=abc",
		},
		...over,
	} as VercelRequest;
}

async function call(req: VercelRequest) {
	const res = stubRes();
	await handler(req, res as unknown as VercelResponse);
	return res;
}

beforeEach(() => {
	vi.clearAllMocks();
	verify.mockResolvedValue(true);
	verifyAndReceive.mockResolvedValue(undefined);
});

describe("QC webhook handler", () => {
	it("rejects a non-POST with the allowed method", async () => {
		const res = await call(stubReq({ method: "GET" }));

		expect(res.statusCode).toBe(405);
		expect(res.headers.Allow).toBe("POST");
		expect(verify).not.toHaveBeenCalled();
	});

	it.each([
		"x-github-delivery",
		"x-github-event",
		"x-hub-signature-256",
	])("rejects a delivery missing %s", async (header) => {
		const headers = { ...stubReq().headers };
		delete headers[header];

		const res = await call(stubReq({ headers }));

		expect(res.statusCode).toBe(400);
		expect(verify).not.toHaveBeenCalled();
	});

	// A forged request must never be acked, and must never reach a handler that
	// spends model budget.
	it("rejects a bad signature without dispatching the event", async () => {
		verify.mockResolvedValue(false);

		const res = await call(stubReq());

		expect(res.statusCode).toBe(400);
		expect(res.body).toEqual({ error: "Invalid webhook signature" });
		expect(verifyAndReceive).not.toHaveBeenCalled();
	});

	// verify() rejecting (rather than returning false) is still an unverified
	// payload — it must not fall through to the dispatch path.
	it("treats a verification error as an invalid signature", async () => {
		verify.mockRejectedValue(new Error("malformed signature header"));

		const res = await call(stubReq());

		expect(res.statusCode).toBe(400);
		expect(verifyAndReceive).not.toHaveBeenCalled();
	});

	it("acks a verified delivery and dispatches it", async () => {
		const res = await call(stubReq());

		expect(res.statusCode).toBe(202);
		expect(verifyAndReceive).toHaveBeenCalledWith({
			id: "d1",
			name: "issue_comment",
			signature: "sha256=abc",
			payload: '{"action":"created"}',
		});
	});

	// The ack is sent before processing, so a handler that throws must not turn
	// into an unhandled rejection. Asserting on the log rather than the status
	// code: the handler does not await the dispatch, so the 202 stands whether
	// or not the rejection is caught, and would prove nothing.
	it("logs a processing failure after the ack instead of rejecting", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new Error("handler exploded");
		verifyAndReceive.mockRejectedValue(failure);

		const res = await call(stubReq());
		await new Promise((resolve) => setImmediate(resolve));

		expect(res.statusCode).toBe(202);
		expect(logged).toHaveBeenCalledWith(
			"QC webhook processing failed",
			expect.objectContaining({ deliveryId: "d1", error: failure }),
		);
		logged.mockRestore();
	});
});
