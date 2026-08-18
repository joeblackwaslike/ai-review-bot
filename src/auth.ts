// Local-only subscription/OAuth auth resolution for the `ai-review review`
// and `audit`/`ready` CLI subcommands.
//
// IMPORTANT — personal, local use only:
//   * Anthropic's ToS (eff. 2026-02-20) prohibits using Claude *subscription*
//     OAuth tokens in third-party tools outside Claude Code / Claude.ai. The
//     OAuth path here is for a developer's own machine. NEVER import or invoke
//     this module from the hosted webhook / Vercel code paths — those must use
//     API keys only.
//   * Refresh tokens for both providers are single-use and shared with the real
//     `codex` / `claude` CLIs. Refresh is serialized behind a lock and the
//     rotated token is written back to the source store to minimise the chance
//     of logging the real CLI out (`refresh_token_reused`).

import { execFile } from "node:child_process";
import { unlinkSync } from "node:fs";
import {
	chmod,
	open,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Provider = "anthropic" | "openai";

export type ResolvedAuth =
	| { mode: "api-key"; provider: Provider; apiKey: string; baseURL?: string }
	| {
			mode: "oauth";
			provider: Provider;
			token: string;
			baseURL: string;
			headers: Record<string, string>;
			fetch: typeof fetch;
	  };

// --- Constants (from openai/codex + Claude Code source / community research) ---

/** Refresh once the access token is within 5 min of expiry (matches Codex). */
export const REFRESH_SKEW_MS = 5 * 60_000;

const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_INSTRUCTIONS = "You are a meticulous code review assistant.";

const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_BETA = "claude-code-20250219,oauth-2025-04-20";
/** Required first system block when using a Claude subscription OAuth token. */
export const CLAUDE_IDENTITY =
	"You are Claude Code, Anthropic's official CLI for Claude.";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const CODEX_AUTH_PATH = path.join(homedir(), ".codex", "auth.json");

// --- Injectable IO (real implementations by default; overridden in tests) ---

export interface AuthIO {
	env?: Record<string, string | undefined>;
	now?: () => number;
	fetch?: typeof fetch;
	readCodexAuth?: () => Promise<string | null>;
	writeCodexAuth?: (text: string) => Promise<void>;
	readClaudeKeychain?: () => Promise<string | null>;
	writeClaudeKeychain?: (text: string) => Promise<void>;
	withLock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

interface ResolvedIO {
	env: Record<string, string | undefined>;
	now: () => number;
	fetch: typeof fetch;
	readCodexAuth: () => Promise<string | null>;
	writeCodexAuth: (text: string) => Promise<void>;
	readClaudeKeychain: () => Promise<string | null>;
	writeClaudeKeychain: (text: string) => Promise<void>;
	withLock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

function withDefaults(io: AuthIO): ResolvedIO {
	return {
		env: io.env ?? process.env,
		now: io.now ?? Date.now,
		fetch: io.fetch ?? fetch,
		readCodexAuth: io.readCodexAuth ?? defaultReadCodexAuth,
		writeCodexAuth: io.writeCodexAuth ?? defaultWriteCodexAuth,
		readClaudeKeychain: io.readClaudeKeychain ?? defaultReadKeychain,
		writeClaudeKeychain: io.writeClaudeKeychain ?? defaultWriteKeychain,
		withLock: io.withLock ?? defaultWithLock,
	};
}

async function defaultReadCodexAuth(): Promise<string | null> {
	try {
		return await readFile(CODEX_AUTH_PATH, "utf-8");
	} catch {
		return null;
	}
}

async function defaultWriteCodexAuth(text: string): Promise<void> {
	// Write-then-rename so a crash mid-write can't leave a truncated/corrupt
	// auth file — rename is atomic on the same filesystem. Mode the temp file
	// 0600 before the rename so the secret is never briefly world-readable.
	const tmpPath = `${CODEX_AUTH_PATH}.${process.pid}.tmp`;
	await writeFile(tmpPath, text, { encoding: "utf-8", mode: 0o600 });
	await chmod(tmpPath, 0o600);
	await rename(tmpPath, CODEX_AUTH_PATH);
}

async function defaultReadKeychain(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("security", [
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-w",
		]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

async function defaultWriteKeychain(text: string): Promise<void> {
	// Match the existing item by service + account so we update it in place.
	let account = "";
	try {
		const { stdout } = await execFileAsync("security", [
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
		]);
		account = /"acct"<blob>="([^"]*)"/.exec(stdout)?.[1] ?? "";
	} catch {
		// fall through with empty account
	}
	await execFileAsync("security", [
		"add-generic-password",
		"-U",
		"-s",
		KEYCHAIN_SERVICE,
		"-a",
		account,
		"-w",
		text,
	]);
}

/** Serialize token refresh across processes via an exclusive lock file. */
async function defaultWithLock<T>(
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lockPath = path.join(tmpdir(), `ai-review-auth-${name}.lock`);
	// The lock wraps a token-refresh network round-trip, which can be slow on a
	// flaky connection. Keep staleMs comfortably above a realistic refresh so a
	// waiter never steals a lock from a peer mid-refresh; allow up to staleMs to
	// acquire so a waiter outlasts (and can then steal) a genuinely dead holder.
	const staleMs = 60_000;
	const deadline = Date.now() + staleMs;
	for (;;) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(String(process.pid));
			await handle.close();
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// Steal the lock if it is stale; otherwise wait and retry.
			try {
				const st = await stat(lockPath);
				if (Date.now() - st.mtimeMs > staleMs) await unlink(lockPath);
			} catch {
				// lock vanished between stat and unlink — race; just retry
			}
			if (Date.now() > deadline)
				throw new Error(`Timed out acquiring auth refresh lock: ${lockPath}`);
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	// Remove our lock if the process is interrupted while holding it, so a
	// Ctrl-C during refresh doesn't leave a stale lock that blocks peers until
	// staleMs elapses. Sync unlink because signal/exit handlers can't await.
	const releaseOnSignal = (signal: NodeJS.Signals) => {
		try {
			unlinkSync(lockPath);
		} catch {
			// already gone / never created — nothing to clean up
		}
		process.kill(process.pid, signal);
	};
	const onSigint = () => releaseOnSignal("SIGINT");
	const onSigterm = () => releaseOnSignal("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	try {
		return await fn();
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		await unlink(lockPath).catch(() => {});
	}
}

// --- Pure helpers ---

/** Parse the `exp` claim (seconds) from a JWT and return it in ms, or null. */
export function jwtExpMs(jwt: string): number | null {
	const parts = jwt.split(".");
	if (parts.length < 2) return null;
	try {
		const payload = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf-8"),
		);
		return typeof payload.exp === "number" ? payload.exp * 1000 : null;
	} catch {
		return null;
	}
}

export function needsRefresh(
	expMs: number,
	nowMs: number,
	skewMs: number,
): boolean {
	return expMs <= nowMs + skewMs;
}

function mergeBeta(existing: string | null): string {
	const parts = new Set(
		(existing ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	for (const b of ANTHROPIC_BETA.split(",")) parts.add(b);
	return [...parts].join(",");
}

/**
 * Ensure the request `system` is shaped so its first text block is exactly the
 * Claude Code identity string — required for subscription OAuth tokens, else
 * the API returns a generic 400.
 */
export function withClaudeCodeIdentity(system: unknown): unknown {
	const idBlock = { type: "text", text: CLAUDE_IDENTITY };
	if (system == null) return [idBlock];
	if (typeof system === "string") {
		return system === CLAUDE_IDENTITY
			? system
			: [idBlock, { type: "text", text: system }];
	}
	if (Array.isArray(system)) {
		const first = system[0] as { type?: string; text?: string } | undefined;
		if (first?.type === "text" && first.text === CLAUDE_IDENTITY) return system;
		return [idBlock, ...system];
	}
	return [idBlock];
}

/** Remove `id` fields and `item_reference` entries (required with store:false). */
function stripItemIds(input: unknown): void {
	if (!Array.isArray(input)) return;
	for (let i = input.length - 1; i >= 0; i--) {
		const item = input[i] as Record<string, unknown> | null;
		if (item && typeof item === "object") {
			if (item.type === "item_reference") {
				input.splice(i, 1);
				continue;
			}
			delete item.id;
		}
	}
}

// --- Custom fetch builders ---

export function makeAnthropicOAuthFetch(
	token: string,
	baseFetch: typeof fetch = fetch,
): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		headers.delete("x-api-key");
		headers.set("authorization", `Bearer ${token}`);
		headers.set("anthropic-beta", mergeBeta(headers.get("anthropic-beta")));
		headers.set("anthropic-version", "2023-06-01");
		let body = init?.body;
		if (typeof body === "string") {
			try {
				const json = JSON.parse(body);
				json.system = withClaudeCodeIdentity(json.system);
				body = JSON.stringify(json);
			} catch {
				// non-JSON body — leave untouched
			}
		}
		return baseFetch(input, { ...init, headers, body });
	}) as typeof fetch;
}

/**
 * Reconstruct a plain Responses-API `response` object from a raw
 * Codex/ChatGPT SSE body — `event: <name>\ndata: <json>` blocks separated by
 * blank lines. The backend rejects `stream:false` outright
 * ({"detail":"Stream must be set to true"}, confirmed live researching
 * ai-review-bot-wt8), so every OAuth-path response arrives in this framing
 * regardless of what the caller asked for.
 *
 * `response.completed`'s embedded `response.output` is ALWAYS an empty
 * array, even though the content was fully generated — confirmed live
 * against the real backend. It expects the caller to have accumulated the
 * actual output items (a `reasoning` item, then a `message` item, for a
 * typical gpt-5.x turn) from the incremental `response.output_item.done`
 * events as they streamed, the same way a real streaming client would;
 * `response.completed` is only a "the whole thing is done" signal, not a
 * content snapshot. This is what lets `makeCodexFetch` hand the AI SDK's
 * non-streaming `generateObject` a plain JSON body as if the backend had
 * never streamed at all.
 *
 * @param rawSSEText - the full raw SSE response body (lines of `event: ...` /
 *   `data: ...` pairs separated by blank lines; CRLF and bare-CR line
 *   endings are normalized to LF before parsing).
 * @returns the reconstructed Responses-API `response` object, with `output`
 *   populated from the accumulated `response.output_item.done` events.
 * @throws if the stream never reaches a `response.completed` event.
 */
export function parseCodexSSEResponse(rawSSEText: string): unknown {
	// The real backend uses LF-only (confirmed live), but SSE permits CRLF or bare CR —
	// normalize first so a server that does isn't silently misparsed.
	const blocks = rawSSEText
		.replace(/\r\n|\r/g, "\n")
		.split("\n\n")
		.filter((b) => b.trim());
	const outputItems: unknown[] = [];
	let finalResponse: Record<string, unknown> | null = null;
	for (const block of blocks) {
		const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
		if (!dataLine) continue;
		const parsed = JSON.parse(dataLine.slice("data:".length).trim());
		if (parsed.type === "response.output_item.done" && parsed.item) {
			outputItems.push(parsed.item);
		} else if (parsed.type === "response.completed" && parsed.response) {
			finalResponse = parsed.response;
		}
	}
	if (!finalResponse) {
		throw new Error(
			"Codex SSE stream ended without a response.completed event",
		);
	}
	return { ...finalResponse, output: outputItems };
}

export function makeCodexFetch(
	accountId: string,
	baseFetch: typeof fetch = fetch,
): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		headers.set("chatgpt-account-id", accountId);
		headers.set("originator", "codex_cli_rs");
		headers.set("accept", "text/event-stream");
		let body = init?.body;
		if (typeof body === "string") {
			try {
				const json = JSON.parse(body);
				json.store = false;
				json.stream = true;
				if (json.instructions == null) json.instructions = CODEX_INSTRUCTIONS;
				// The backend rejects this field outright
				// ({"detail":"Unsupported parameter: max_output_tokens"}) — the real
				// `codex` CLI never sends it, letting the reasoning model manage its
				// own budget. Confirmed live 2026-08-18: every review agent failed
				// until this was stripped.
				delete json.max_output_tokens;
				stripItemIds(json.input);
				json.include = [
					...new Set([
						...(Array.isArray(json.include) ? json.include : []),
						"reasoning.encrypted_content",
					]),
				];
				body = JSON.stringify(json);
			} catch {
				// non-JSON body — leave untouched
			}
		}
		const res = await baseFetch(input, { ...init, headers, body });
		// ai-review-bot-wt8: since `stream:true` is now always forced above, a
		// successful response is always SSE-framed — the AI SDK's non-streaming
		// generateObject can't parse that directly ("Invalid JSON response").
		// An error response is already plain JSON (confirmed: the backend's own
		// 400s look like {"detail":"..."}), so only rewrite what actually fails
		// to parse as JSON on its own — never misdetect a real error as SSE.
		const rawText = await res.text();
		try {
			JSON.parse(rawText);
			return new Response(rawText, {
				status: res.status,
				statusText: res.statusText,
				headers: res.headers,
			});
		} catch {
			let parsedResponse: unknown;
			try {
				parsedResponse = parseCodexSSEResponse(rawText);
			} catch (parseErr) {
				// Neither valid JSON nor parseable SSE — a real upstream failure
				// (truncated response, HTML error page, etc.), not a bug in this
				// parser. Surface the original status/body rather than losing them
				// behind parseCodexSSEResponse's generic "no response.completed"
				// message, which is indistinguishable from a genuine SSE-shape bug.
				// `cause` preserves parseCodexSSEResponse's own error (and stack) so
				// a genuine parser bug is still fully diagnosable from this
				// wrapper's summary, not just from the message string. Set directly
				// to `parseErr` (not wrapped) — Error.cause is typed `unknown`
				// precisely so the original thrown value, whatever it was, survives
				// intact for a caller that inspects `err.cause`.
				throw new Error(
					`Codex response (status ${res.status}) was neither valid JSON nor a parseable SSE stream: ${
						parseErr instanceof Error ? parseErr.message : String(parseErr)
					}. Body (first 500 chars): ${rawText.slice(0, 500)}`,
					{ cause: parseErr },
				);
			}
			// Only the framing headers change here — content-length/-encoding and
			// transfer-encoding described the original SSE wire payload, not the
			// JSON.stringify(parsedResponse) body being returned, and a stale
			// content-length in particular can make a downstream consumer that
			// re-serializes this Response see a truncated/invalid body.
			const headers = new Headers(res.headers);
			headers.delete("content-length");
			headers.delete("content-encoding");
			headers.delete("transfer-encoding");
			headers.set("content-type", "application/json");
			return new Response(JSON.stringify(parsedResponse), {
				status: res.status,
				statusText: res.statusText,
				headers,
			});
		}
	}) as typeof fetch;
}

// --- Token refresh ---

interface RefreshResult {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expires_in?: number;
}

function isPermanentRefreshFailure(status: number, text: string): boolean {
	return (
		status === 400 ||
		status === 401 ||
		/refresh_token_(expired|reused|invalidated)|invalid_grant/.test(text)
	);
}

async function refreshCodex(
	f: typeof fetch,
	refreshToken: string,
): Promise<RefreshResult> {
	const res = await f(CODEX_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_id: CODEX_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		if (isPermanentRefreshFailure(res.status, text))
			throw new Error(
				"Codex session expired — run `codex login` to re-authenticate.",
			);
		throw new Error(`Codex token refresh failed: ${res.status} ${text}`);
	}
	return res.json() as Promise<RefreshResult>;
}

async function refreshAnthropic(
	f: typeof fetch,
	refreshToken: string,
): Promise<RefreshResult> {
	const res = await f(ANTHROPIC_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_id: ANTHROPIC_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		if (isPermanentRefreshFailure(res.status, text))
			throw new Error(
				"Claude session expired — run `claude` to re-authenticate.",
			);
		throw new Error(`Claude token refresh failed: ${res.status} ${text}`);
	}
	return res.json() as Promise<RefreshResult>;
}

// --- Resolution ---

export async function resolveOpenAIAuth(
	io: AuthIO = {},
): Promise<ResolvedAuth> {
	const d = withDefaults(io);

	if (d.env.OPENAI_API_KEY)
		return {
			mode: "api-key",
			provider: "openai",
			apiKey: d.env.OPENAI_API_KEY,
		};

	// An API key can also be embedded directly in ~/.codex/auth.json (not
	// just the env var) — checked here, ahead of the subscription-only
	// delegate below, so resolveOpenAIAuth's existing api-key-first contract
	// (including this exact error message) is unchanged.
	// resolveOpenAISubscriptionAuth deliberately does NOT honor this branch
	// or fall back to it — see its own doc comment.
	const raw = await d.readCodexAuth();
	if (!raw)
		throw new Error(
			"No OPENAI_API_KEY and no ~/.codex/auth.json — run `codex login` or set OPENAI_API_KEY.",
		);
	const auth = JSON.parse(raw);
	if (auth.OPENAI_API_KEY)
		return { mode: "api-key", provider: "openai", apiKey: auth.OPENAI_API_KEY };

	return resolveOpenAISubscriptionAuth(io);
}

/**
 * Like `resolveOpenAIAuth`, but never falls back to `OPENAI_API_KEY` (env or
 * ~/.codex/auth.json's own stored key) — only ChatGPT/Codex-subscription
 * OAuth credentials. `watch`'s whole purpose is bypassing a funded API key
 * via subscription auth; wiring the API-key-first `resolveOpenAIAuth` into
 * it means a stray `OPENAI_API_KEY` in the environment (e.g. one left over
 * from the hosted webhook's own `.env`, possibly exhausted) silently
 * overrides subscription intent every time. Fixed symmetrically with
 * `resolveAnthropicSubscriptionAuth`, whose doc comment has the confirmed
 * live incident this class of bug was caught from — the Codex GitHub App
 * credentials this OpenAI side needs weren't available yet when that
 * incident happened, so this side was fixed preventatively rather than
 * independently reproduced.
 */
export async function resolveOpenAISubscriptionAuth(
	io: AuthIO = {},
): Promise<ResolvedAuth> {
	const d = withDefaults(io);

	const raw = await d.readCodexAuth();
	if (!raw) throw new Error("No ~/.codex/auth.json — run `codex login`.");

	const auth = JSON.parse(raw);
	if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token)
		throw new Error(
			"~/.codex/auth.json is not in ChatGPT mode — run `codex login`.",
		);

	let accessToken: string = auth.tokens.access_token;
	const accountId: string = auth.tokens.account_id;
	const expMs = jwtExpMs(accessToken);

	if (expMs === null || needsRefresh(expMs, d.now(), REFRESH_SKEW_MS)) {
		accessToken = await d.withLock("codex", async () => {
			// Re-read inside the lock: another process may have rotated already.
			const cur = JSON.parse((await d.readCodexAuth()) ?? raw);
			const curExp = jwtExpMs(cur.tokens.access_token);
			if (curExp !== null && !needsRefresh(curExp, d.now(), REFRESH_SKEW_MS))
				return cur.tokens.access_token;
			const r = await refreshCodex(d.fetch, cur.tokens.refresh_token);
			cur.tokens.access_token = r.access_token ?? cur.tokens.access_token;
			cur.tokens.refresh_token = r.refresh_token ?? cur.tokens.refresh_token;
			if (r.id_token) cur.tokens.id_token = r.id_token;
			cur.last_refresh = new Date(d.now()).toISOString();
			await d.writeCodexAuth(JSON.stringify(cur, null, 2));
			return cur.tokens.access_token;
		});
	}

	return {
		mode: "oauth",
		provider: "openai",
		token: accessToken,
		baseURL: CODEX_BASE,
		headers: {
			"chatgpt-account-id": accountId,
			originator: "codex_cli_rs",
			"user-agent": `codex_cli_rs (ai-review-bot; Node ${process.version})`,
		},
		fetch: makeCodexFetch(accountId, d.fetch),
	};
}

export async function resolveAnthropicAuth(
	io: AuthIO = {},
): Promise<ResolvedAuth> {
	const d = withDefaults(io);

	if (d.env.ANTHROPIC_API_KEY)
		return {
			mode: "api-key",
			provider: "anthropic",
			apiKey: d.env.ANTHROPIC_API_KEY,
		};

	return resolveAnthropicSubscriptionAuth(io);
}

/**
 * Like `resolveAnthropicAuth`, but never falls back to `ANTHROPIC_API_KEY` —
 * only an explicit OAuth token (`ANTHROPIC_AUTH_TOKEN`/
 * `CLAUDE_CODE_OAUTH_TOKEN`) or stored Claude Code subscription credentials.
 * `watch`'s whole purpose is bypassing a funded API key via subscription
 * auth; wiring the API-key-first `resolveAnthropicAuth` into it means a
 * stray `ANTHROPIC_API_KEY` in the environment (e.g. one left over from the
 * hosted webhook's own `.env`, possibly exhausted) silently overrides
 * subscription intent every time. Confirmed live 2026-08-18: the first
 * `ai-review watch` dogfood run on PR #65 hit exactly this — an exhausted
 * `ANTHROPIC_API_KEY` in `.env` made the run reuse the same dead credential
 * the hosted bot was already failing on, requiring the operator to manually
 * `unset` it before every invocation.
 */
export async function resolveAnthropicSubscriptionAuth(
	io: AuthIO = {},
): Promise<ResolvedAuth> {
	const d = withDefaults(io);

	const envToken = d.env.ANTHROPIC_AUTH_TOKEN || d.env.CLAUDE_CODE_OAUTH_TOKEN;
	if (envToken) return anthropicOAuth(envToken, d.fetch);

	const raw = await d.readClaudeKeychain();
	if (!raw)
		throw new Error(
			"No OAuth token and no stored Claude Code credentials — run `claude` to log in.",
		);

	const store = JSON.parse(raw);
	const oauth = store.claudeAiOauth ?? store;
	let accessToken: string = oauth.accessToken;
	const expiresAt: number | undefined = oauth.expiresAt; // epoch ms

	if (expiresAt == null || needsRefresh(expiresAt, d.now(), REFRESH_SKEW_MS)) {
		accessToken = await d.withLock("claude", async () => {
			const curRaw = (await d.readClaudeKeychain()) ?? raw;
			const cur = JSON.parse(curRaw);
			const curOauth = cur.claudeAiOauth ?? cur;
			if (
				curOauth.expiresAt != null &&
				!needsRefresh(curOauth.expiresAt, d.now(), REFRESH_SKEW_MS)
			)
				return curOauth.accessToken;
			const r = await refreshAnthropic(d.fetch, curOauth.refreshToken);
			curOauth.accessToken = r.access_token ?? curOauth.accessToken;
			curOauth.refreshToken = r.refresh_token ?? curOauth.refreshToken;
			if (r.expires_in) curOauth.expiresAt = d.now() + r.expires_in * 1000;
			await d.writeClaudeKeychain(JSON.stringify(cur));
			return curOauth.accessToken;
		});
	}

	return anthropicOAuth(accessToken, d.fetch);
}

function anthropicOAuth(token: string, f: typeof fetch): ResolvedAuth {
	return {
		mode: "oauth",
		provider: "anthropic",
		token,
		baseURL: ANTHROPIC_BASE,
		headers: { "anthropic-beta": ANTHROPIC_BETA },
		fetch: makeAnthropicOAuthFetch(token, f),
	};
}

/** Resolve auth for a provider, surfacing a clear error on failure. */
export async function resolveAuth(
	provider: Provider,
	io: AuthIO = {},
): Promise<ResolvedAuth> {
	return provider === "anthropic"
		? resolveAnthropicAuth(io)
		: resolveOpenAIAuth(io);
}

/**
 * Like `resolveAuth`, but never falls back to a funded API key — only
 * subscription/OAuth credentials. This is what `ai-review watch` must use
 * (not `resolveAuth`): a stray `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` left in
 * the environment would otherwise silently defeat the entire point of
 * `watch`. See `resolveAnthropicSubscriptionAuth`/
 * `resolveOpenAISubscriptionAuth`'s own doc comments.
 */
export async function resolveSubscriptionAuth(
	provider: Provider,
	io: AuthIO = {},
): Promise<ResolvedAuth> {
	return provider === "anthropic"
		? resolveAnthropicSubscriptionAuth(io)
		: resolveOpenAISubscriptionAuth(io);
}
