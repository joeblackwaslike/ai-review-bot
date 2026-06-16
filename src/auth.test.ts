import { describe, expect, it, vi } from "vitest";
import {
	type AuthIO,
	CLAUDE_IDENTITY,
	jwtExpMs,
	makeAnthropicOAuthFetch,
	makeCodexFetch,
	needsRefresh,
	resolveAnthropicAuth,
	resolveOpenAIAuth,
	withClaudeCodeIdentity,
} from "./auth.js";

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
