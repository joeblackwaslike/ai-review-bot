import { describe, expect, it, vi } from "vitest";
import {
	type AuthIO,
	CLAUDE_IDENTITY,
	jwtExpMs,
	makeAnthropicOAuthFetch,
	makeCodexFetch,
	needsRefresh,
	parseCodexSSEResponse,
	resolveAnthropicAuth,
	resolveAnthropicSubscriptionAuth,
	resolveOpenAIAuth,
	resolveOpenAISubscriptionAuth,
	resolveSubscriptionAuth,
	withClaudeCodeIdentity,
} from "./auth.js";

/** A trimmed but structurally faithful capture of a real ChatGPT/Codex
 * Responses-API `stream:true` response — the backend rejects `stream:false`
 * outright ({"detail":"Stream must be set to true"}, confirmed live
 * 2026-08-18 researching ai-review-bot-wt8), so every OAuth-path response
 * arrives in this SSE framing regardless of what the caller asked for.
 *
 * Critically, `response.completed`'s embedded `response.output` is ALWAYS an
 * empty array — confirmed live against the real backend — even though the
 * content was fully generated. The backend expects the caller to have
 * accumulated the actual output items from the incremental
 * `response.output_item.done` events as they streamed, the same way a real
 * streaming client would; `response.completed` is only a "the whole thing is
 * done" signal, not a content snapshot. This fixture includes a reasoning
 * item (typical of gpt-5.x) and a message item, in the order the real API
 * emits them, so the parser is tested against that reality rather than the
 * wrong assumption that response.completed carries the content. */
const CODEX_SSE_FIXTURE = [
	'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress","output":[]}}',
	'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"rs_1","type":"reasoning","content":[],"encrypted_content":"abc"},"output_index":0}',
	'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","content":[],"encrypted_content":"abc"},"output_index":0}',
	'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":1}',
	'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK","output_index":1}',
	'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"text":"OK"}],"role":"assistant"},"output_index":1}',
	'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[],"usage":{"input_tokens":23,"output_tokens":5,"total_tokens":28}}}',
].join("\n\n");

/** Build a fake JWT whose `exp` claim is `expSec` seconds since epoch. */
function fakeJwt(expSec: number): string {
	const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString(
		"base64url",
	);
	return `header.${payload}.sig`;
}

/** A withLock that just runs the function (no real file locking in tests). */
const passthroughLock = <T>(_name: string, fn: () => Promise<T>) => fn();

describe("jwtExpMs / needsRefresh", () => {
	it("parses exp (seconds) into ms", () => {
		expect(jwtExpMs(fakeJwt(1000))).toBe(1_000_000);
	});
	it("returns null for malformed tokens", () => {
		expect(jwtExpMs("not-a-jwt")).toBeNull();
		expect(jwtExpMs("a.b.c")).toBeNull();
	});
	it("needsRefresh is true within the skew window", () => {
		expect(needsRefresh(1000, 700, 300)).toBe(true); // 1000 <= 700+300
		expect(needsRefresh(1001, 700, 300)).toBe(false);
	});
});

describe("withClaudeCodeIdentity", () => {
	it("wraps a string system into [identity, original]", () => {
		expect(withClaudeCodeIdentity("be helpful")).toEqual([
			{ type: "text", text: CLAUDE_IDENTITY },
			{ type: "text", text: "be helpful" },
		]);
	});
	it("leaves an exact identity string untouched", () => {
		expect(withClaudeCodeIdentity(CLAUDE_IDENTITY)).toBe(CLAUDE_IDENTITY);
	});
	it("prepends identity to an array that lacks it", () => {
		const out = withClaudeCodeIdentity([{ type: "text", text: "x" }]) as Array<{
			text: string;
		}>;
		expect(out[0].text).toBe(CLAUDE_IDENTITY);
		expect(out[1].text).toBe("x");
	});
	it("is idempotent when identity is already first", () => {
		const sys = [
			{ type: "text", text: CLAUDE_IDENTITY },
			{ type: "text", text: "x" },
		];
		expect(withClaudeCodeIdentity(sys)).toBe(sys);
	});
});

describe("makeAnthropicOAuthFetch", () => {
	it("strips x-api-key, sets bearer + beta, splits the system block", async () => {
		let capturedInit: RequestInit | undefined;
		const base = (async (_url: unknown, init?: RequestInit) => {
			capturedInit = init;
			return new Response("{}");
		}) as unknown as typeof fetch;

		const f = makeAnthropicOAuthFetch("TKN", base);
		await f("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: { "x-api-key": "leak", "content-type": "application/json" },
			body: JSON.stringify({ system: "review carefully", messages: [] }),
		});

		const h = new Headers(capturedInit?.headers);
		expect(h.get("x-api-key")).toBeNull();
		expect(h.get("authorization")).toBe("Bearer TKN");
		expect(h.get("anthropic-beta")).toContain("oauth-2025-04-20");
		expect(h.get("anthropic-version")).toBe("2023-06-01");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.system[0]).toEqual({ type: "text", text: CLAUDE_IDENTITY });
		expect(body.system[1]).toEqual({ type: "text", text: "review carefully" });
	});
});

describe("makeCodexFetch", () => {
	it("injects account/originator headers and rewrites the body", async () => {
		let capturedInit: RequestInit | undefined;
		const base = (async (_url: unknown, init?: RequestInit) => {
			capturedInit = init;
			return new Response("{}");
		}) as unknown as typeof fetch;

		const f = makeCodexFetch("acct-1", base);
		await f("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
			body: JSON.stringify({
				input: [
					{ id: "msg_1", type: "message", content: "hi" },
					{ type: "item_reference", id: "ref_1" },
				],
				store: true,
			}),
		});

		const h = new Headers(capturedInit?.headers);
		expect(h.get("chatgpt-account-id")).toBe("acct-1");
		expect(h.get("originator")).toBe("codex_cli_rs");
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.store).toBe(false);
		expect(body.stream).toBe(true);
		expect(body.instructions).toBeTruthy();
		expect(body.include).toContain("reasoning.encrypted_content");
		// item_reference dropped; id stripped from the remaining item
		expect(body.input).toHaveLength(1);
		expect(body.input[0].id).toBeUndefined();
	});

	// Confirmed live 2026-08-18 dogfooding `ai-review watch --provider openai`
	// on this PR: every review agent failed with the ChatGPT/Codex backend's
	// raw `{"detail":"Unsupported parameter: max_output_tokens"}` — the AI
	// SDK's `generateObject({ maxOutputTokens })` auto-translates to a
	// `max_output_tokens` field in the Responses API request body, but this
	// backend (unlike the standard OpenAI API) rejects it outright. The real
	// `codex` CLI this fetch wrapper mimics never sends this field — it lets
	// the reasoning model manage its own budget — so strip it the same way
	// `store`/`stream`/`instructions`/item ids are already rewritten above.
	it("strips max_output_tokens — the backend rejects it outright", async () => {
		let capturedInit: RequestInit | undefined;
		const base = (async (_url: unknown, init?: RequestInit) => {
			capturedInit = init;
			return new Response("{}");
		}) as unknown as typeof fetch;

		const f = makeCodexFetch("acct-1", base);
		await f("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
			body: JSON.stringify({
				input: [],
				max_output_tokens: 4096,
			}),
		});

		const body = JSON.parse(capturedInit?.body as string);
		expect(body).not.toHaveProperty("max_output_tokens");
	});

	// ai-review-bot-wt8: the AI SDK's non-streaming generateObject can't parse
	// an SSE-formatted response body ("Invalid JSON response") — the fetch
	// wrapper must consume the stream itself and hand back a plain JSON
	// Response whose body is the response.completed event's `response` object,
	// so generateObject downstream is unaffected and unaware streaming ever
	// happened.
	it("converts an SSE response body into a plain JSON response", async () => {
		const base = (async () =>
			new Response(CODEX_SSE_FIXTURE)) as unknown as typeof fetch;
		const f = makeCodexFetch("acct-1", base);

		const res = await f("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
			body: JSON.stringify({ input: [] }),
		});

		expect(res.headers.get("content-type")).toContain("application/json");
		const parsed = await res.json();
		expect(parsed).toEqual({
			id: "resp_1",
			object: "response",
			status: "completed",
			output: [
				{
					id: "rs_1",
					type: "reasoning",
					content: [],
					encrypted_content: "abc",
				},
				{
					id: "msg_1",
					type: "message",
					status: "completed",
					content: [{ type: "output_text", annotations: [], text: "OK" }],
					role: "assistant",
				},
			],
			usage: { input_tokens: 23, output_tokens: 5, total_tokens: 28 },
		});
	});

	// An error response (e.g. the 400 "Stream must be set to true" this fetch
	// itself can never trigger since it always forces stream:true, but other
	// errors like auth/rate-limit failures) is already plain JSON — it must
	// pass through unchanged, not be misdetected as SSE.
	it("passes a plain JSON error response through unchanged", async () => {
		const base = (async () =>
			new Response('{"detail":"invalid_request"}', {
				status: 400,
			})) as unknown as typeof fetch;
		const f = makeCodexFetch("acct-1", base);

		const res = await f("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
			body: JSON.stringify({ input: [] }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ detail: "invalid_request" });
	});
});

describe("parseCodexSSEResponse", () => {
	it("extracts the response.completed event's response object", () => {
		expect(parseCodexSSEResponse(CODEX_SSE_FIXTURE)).toEqual({
			id: "resp_1",
			object: "response",
			status: "completed",
			output: [
				{
					id: "rs_1",
					type: "reasoning",
					content: [],
					encrypted_content: "abc",
				},
				{
					id: "msg_1",
					type: "message",
					status: "completed",
					content: [{ type: "output_text", annotations: [], text: "OK" }],
					role: "assistant",
				},
			],
			usage: { input_tokens: 23, output_tokens: 5, total_tokens: 28 },
		});
	});

	it("throws a clear error when the stream never reaches response.completed", () => {
		const truncated =
			'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}';
		expect(() => parseCodexSSEResponse(truncated)).toThrow(
			/response\.completed/,
		);
	});
});

describe("resolveOpenAIAuth", () => {
	it("prefers OPENAI_API_KEY env", async () => {
		const auth = await resolveOpenAIAuth({ env: { OPENAI_API_KEY: "sk-env" } });
		expect(auth).toMatchObject({ mode: "api-key", apiKey: "sk-env" });
	});

	it("uses an api key embedded in auth.json", async () => {
		const auth = await resolveOpenAIAuth({
			env: {},
			readCodexAuth: async () => JSON.stringify({ OPENAI_API_KEY: "sk-file" }),
		});
		expect(auth).toMatchObject({ mode: "api-key", apiKey: "sk-file" });
	});

	it("returns oauth without refreshing when the token is fresh", async () => {
		const future = Math.floor(Date.now() / 1000) + 3600;
		const fetchSpy = vi.fn();
		const auth = await resolveOpenAIAuth({
			env: {},
			fetch: fetchSpy as unknown as typeof fetch,
			readCodexAuth: async () =>
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: {
						access_token: fakeJwt(future),
						refresh_token: "rt",
						account_id: "acct-9",
					},
				}),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(auth).toMatchObject({
			mode: "oauth",
			provider: "openai",
			baseURL: "https://chatgpt.com/backend-api/codex",
		});
		if (auth.mode === "oauth")
			expect(auth.headers["chatgpt-account-id"]).toBe("acct-9");
	});

	it("refreshes an expired token and writes the rotated token back", async () => {
		const past = Math.floor(Date.now() / 1000) - 10;
		const future = Math.floor(Date.now() / 1000) + 3600;
		const writes: string[] = [];
		const fetchMock = (async () =>
			new Response(
				JSON.stringify({
					access_token: fakeJwt(future),
					refresh_token: "rt-NEW",
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const io: AuthIO = {
			env: {},
			fetch: fetchMock,
			withLock: passthroughLock,
			readCodexAuth: async () =>
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: {
						access_token: fakeJwt(past),
						refresh_token: "rt-OLD",
						account_id: "acct-9",
					},
				}),
			writeCodexAuth: async (t) => {
				writes.push(t);
			},
		};
		const auth = await resolveOpenAIAuth(io);
		expect(auth.mode).toBe("oauth");
		if (auth.mode === "oauth") expect(jwtExpMs(auth.token)).toBe(future * 1000);
		// rotated refresh token persisted
		expect(writes).toHaveLength(1);
		expect(JSON.parse(writes[0]).tokens.refresh_token).toBe("rt-NEW");
	});

	it("throws a clear re-login error when the refresh token is dead", async () => {
		const past = Math.floor(Date.now() / 1000) - 10;
		const fetchMock = (async () =>
			new Response("refresh_token_expired", {
				status: 400,
			})) as unknown as typeof fetch;
		await expect(
			resolveOpenAIAuth({
				env: {},
				fetch: fetchMock,
				withLock: passthroughLock,
				readCodexAuth: async () =>
					JSON.stringify({
						auth_mode: "chatgpt",
						tokens: {
							access_token: fakeJwt(past),
							refresh_token: "rt",
							account_id: "a",
						},
					}),
				writeCodexAuth: async () => {},
			}),
		).rejects.toThrow(/codex login/);
	});

	it("errors when no key and no auth.json", async () => {
		await expect(
			resolveOpenAIAuth({ env: {}, readCodexAuth: async () => null }),
		).rejects.toThrow(/OPENAI_API_KEY/);
	});
});

describe("resolveAnthropicAuth", () => {
	it("prefers ANTHROPIC_API_KEY env", async () => {
		const auth = await resolveAnthropicAuth({
			env: { ANTHROPIC_API_KEY: "sk-ant" },
		});
		expect(auth).toMatchObject({ mode: "api-key", apiKey: "sk-ant" });
	});

	it("uses an explicit OAuth env token without touching the keychain", async () => {
		const readKeychain = vi.fn();
		const auth = await resolveAnthropicAuth({
			env: { CLAUDE_CODE_OAUTH_TOKEN: "oat-123" },
			readClaudeKeychain: readKeychain as unknown as () => Promise<
				string | null
			>,
		});
		expect(readKeychain).not.toHaveBeenCalled();
		expect(auth).toMatchObject({ mode: "oauth", provider: "anthropic" });
		if (auth.mode === "oauth") expect(auth.token).toBe("oat-123");
	});

	it("reads a fresh keychain token without refreshing", async () => {
		const fetchSpy = vi.fn();
		const auth = await resolveAnthropicAuth({
			env: {},
			fetch: fetchSpy as unknown as typeof fetch,
			readClaudeKeychain: async () =>
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "at-fresh",
						refreshToken: "rt",
						expiresAt: Date.now() + 3_600_000,
					},
				}),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		if (auth.mode === "oauth") expect(auth.token).toBe("at-fresh");
	});

	it("refreshes an expired keychain token and writes it back", async () => {
		const writes: string[] = [];
		const fetchMock = (async () =>
			new Response(
				JSON.stringify({
					access_token: "at-NEW",
					refresh_token: "rt-NEW",
					expires_in: 3600,
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const auth = await resolveAnthropicAuth({
			env: {},
			now: () => 1_000_000,
			fetch: fetchMock,
			withLock: passthroughLock,
			readClaudeKeychain: async () =>
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "at-OLD",
						refreshToken: "rt-OLD",
						expiresAt: 0,
					},
				}),
			writeClaudeKeychain: async (t) => {
				writes.push(t);
			},
		});
		if (auth.mode === "oauth") expect(auth.token).toBe("at-NEW");
		expect(JSON.parse(writes[0]).claudeAiOauth.refreshToken).toBe("rt-NEW");
		expect(JSON.parse(writes[0]).claudeAiOauth.expiresAt).toBe(
			1_000_000 + 3_600_000,
		);
	});
});

// A stray ANTHROPIC_API_KEY/OPENAI_API_KEY in the environment (e.g. the same
// exhausted key the hosted webhook already failed on) must never silently
// override `watch`'s subscription-auth intent. Confirmed live 2026-08-18: the
// first `ai-review watch` dogfood run on PR #65 reused a dead
// ANTHROPIC_API_KEY from .env instead of falling back to the logged-in
// `claude` CLI session, because it was wired to the API-key-first
// resolveAuth/resolveAnthropicAuth instead of a subscription-only resolver.
describe("resolveAnthropicSubscriptionAuth", () => {
	it("ignores ANTHROPIC_API_KEY and reads the keychain instead", async () => {
		const auth = await resolveAnthropicSubscriptionAuth({
			env: { ANTHROPIC_API_KEY: "sk-stray-exhausted-key" },
			readClaudeKeychain: async () =>
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "at-fresh",
						refreshToken: "rt",
						expiresAt: Date.now() + 3_600_000,
					},
				}),
		});
		expect(auth.mode).toBe("oauth");
		if (auth.mode === "oauth") expect(auth.token).toBe("at-fresh");
	});

	it("still honors an explicit OAuth env token (not an API key)", async () => {
		const auth = await resolveAnthropicSubscriptionAuth({
			env: {
				ANTHROPIC_API_KEY: "sk-stray",
				CLAUDE_CODE_OAUTH_TOKEN: "oat-123",
			},
		});
		expect(auth.mode).toBe("oauth");
		if (auth.mode === "oauth") expect(auth.token).toBe("oat-123");
	});

	it("throws a login prompt, not an API-key suggestion, when nothing is available", async () => {
		await expect(
			resolveAnthropicSubscriptionAuth({
				env: { ANTHROPIC_API_KEY: "sk-stray" },
				readClaudeKeychain: async () => null,
			}),
		).rejects.toThrow(/run `claude` to log in/);
	});
});

describe("resolveOpenAISubscriptionAuth", () => {
	it("ignores OPENAI_API_KEY (env) and reads ~/.codex/auth.json instead", async () => {
		const auth = await resolveOpenAISubscriptionAuth({
			env: { OPENAI_API_KEY: "sk-stray-exhausted-key" },
			readCodexAuth: async () =>
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: {
						access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
						refresh_token: "rt",
						account_id: "a",
					},
				}),
		});
		expect(auth.mode).toBe("oauth");
	});

	it("ignores an OPENAI_API_KEY embedded in auth.json too, unlike resolveOpenAIAuth", async () => {
		await expect(
			resolveOpenAISubscriptionAuth({
				env: {},
				readCodexAuth: async () =>
					JSON.stringify({ OPENAI_API_KEY: "sk-file" }),
			}),
		).rejects.toThrow(/ChatGPT mode/);
	});
});

describe("resolveSubscriptionAuth", () => {
	it("dispatches to the anthropic subscription-only resolver, ignoring a stray API key", async () => {
		const auth = await resolveSubscriptionAuth("anthropic", {
			env: { ANTHROPIC_API_KEY: "sk-stray" },
			readClaudeKeychain: async () =>
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "at-fresh",
						refreshToken: "rt",
						expiresAt: Date.now() + 3_600_000,
					},
				}),
		});
		expect(auth.mode).toBe("oauth");
		expect(auth.provider).toBe("anthropic");
	});

	it("dispatches to the openai subscription-only resolver, ignoring a stray API key", async () => {
		const auth = await resolveSubscriptionAuth("openai", {
			env: { OPENAI_API_KEY: "sk-stray" },
			readCodexAuth: async () =>
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: {
						access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
						refresh_token: "rt",
						account_id: "a",
					},
				}),
		});
		expect(auth.mode).toBe("oauth");
		expect(auth.provider).toBe("openai");
	});
});
