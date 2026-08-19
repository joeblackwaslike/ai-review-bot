// Credential resolution for the `ai-review` CLI so the globally npm-linked
// binary keeps working when run from a directory outside this repo (no local
// `.env`). See docs/superpowers or ai-review-bot-yyn for the design writeup.
//
// Resolution order per var, only filling a var not already set:
//   1. process.env as already set — never overwritten, resolver skipped entirely.
//   2. macOS Keychain (service KEYCHAIN_SERVICE, one item per var) — the
//      preferred persistent store, same `security` CLI technique src/auth.ts
//      already uses for the Claude Code OAuth token.
//   3. ~/.config/ai-review/.env — last-resort plaintext fallback, only fills
//      whatever the Keychain didn't have.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import dotenv from "dotenv";

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = "ai-review-cli-credentials";

export const XDG_ENV_PATH = path.join(
	homedir(),
	".config",
	"ai-review",
	".env",
);

/** The identity credentials `ai-review watch` needs to post through the two
 * GitHub App bots. Not the full prod env surface — webhook secrets, QStash,
 * KV, etc. are server-only and never read by CLI code paths. */
export const CLI_CREDENTIAL_VARS = [
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"OPENAI_APP_ID",
	"OPENAI_APP_PRIVATE_KEY",
] as const;

export type CliCredentialVar = (typeof CLI_CREDENTIAL_VARS)[number];

export interface CliCredsIO {
	env?: Record<string, string | undefined>;
	readKeychain?: (account: string) => Promise<string | null>;
	writeKeychain?: (account: string, value: string) => Promise<void>;
	deleteKeychain?: (account: string) => Promise<void>;
	readXdgFile?: () => Promise<string | null>;
}

// `security` exits 44 with a stable stderr message for "item not found" and
// rejects with a Node `ENOENT` when the binary itself isn't present (Linux,
// Windows, sandboxed CI — degrade to the XDG fallback rather than erroring).
// Both are expected, common outcomes; anything else is a real failure
// (locked keychain, permission denial, corrupt keychain) that must not be
// swallowed and reported as if it were a routine miss.
export function isItemNotFoundError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === 44
	);
}

export function isKeychainUnavailableError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function defaultReadKeychain(account: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("security", [
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			account,
			"-w",
		]);
		return stdout.trim() || null;
	} catch (err) {
		if (!isItemNotFoundError(err) && !isKeychainUnavailableError(err)) {
			process.stderr.write(
				`ai-review: Keychain read failed for ${account}: ${errorMessage(err)}\n`,
			);
		}
		return null;
	}
}

// `-w <value>` puts the credential in this `security` subprocess's own argv
// for its (short) lifetime, regardless of how the caller obtained `value` —
// piped stdin, a hidden prompt, or a positional CLI arg all funnel through
// here identically. `security add-generic-password -h` documents the only
// non-argv input mode as an interactive double-entry prompt read from the
// controlling terminal (typed twice, not piped), which doesn't work for the
// non-interactive/scripted flow this CLI targets — verified directly
// (`security add-generic-password -w` with piped stdin still prompts twice
// via the tty rather than reading the pipe). `src/auth.ts`'s existing
// Keychain writer for the Claude Code OAuth token has the identical
// pattern for the same reason. See docs/cli-and-npm.md's "Residual
// exposure" note.
async function defaultWriteKeychain(
	account: string,
	value: string,
): Promise<void> {
	try {
		await execFileAsync("security", [
			"add-generic-password",
			"-U",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			account,
			"-w",
			value,
		]);
	} catch (err) {
		if (isKeychainUnavailableError(err)) {
			throw new Error(
				"macOS Keychain is not available on this platform (the `security` binary was not found). Use ~/.config/ai-review/.env as a fallback instead.",
			);
		}
		throw new Error(
			`Failed to write "${account}" to the Keychain: ${errorMessage(err)}`,
		);
	}
}

async function defaultDeleteKeychain(account: string): Promise<void> {
	try {
		await execFileAsync("security", [
			"delete-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			account,
		]);
	} catch (err) {
		// Already absent — deleting a credential that isn't there is a no-op,
		// not a failure. Anything else (locked keychain, permission denial,
		// binary missing) must not be swallowed — that's what let `creds unset`
		// previously report "Removed" when nothing was actually removed. The
		// binary-missing case below is translated into a friendlier message
		// rather than rethrown as-is; everything else propagates unchanged.
		if (isItemNotFoundError(err)) return;
		if (isKeychainUnavailableError(err)) {
			throw new Error(
				"macOS Keychain is not available on this platform (the `security` binary was not found).",
			);
		}
		throw new Error(
			`Failed to remove "${account}" from the Keychain: ${errorMessage(err)}`,
		);
	}
}

async function defaultReadXdgFile(): Promise<string | null> {
	try {
		return await readFile(XDG_ENV_PATH, "utf-8");
	} catch (err) {
		// ENOENT (no fallback file configured) is the expected, common case.
		// Anything else — e.g. a permissions error after the docs' recommended
		// `chmod 600` went wrong — is worth a diagnostic rather than silently
		// producing the same "nothing here" result.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			process.stderr.write(
				`ai-review: failed to read ${XDG_ENV_PATH}: ${errorMessage(err)}\n`,
			);
		}
		return null;
	}
}

/** Populates `io.env` (defaults to `process.env`) in place, filling only the
 * vars in `CLI_CREDENTIAL_VARS` that aren't already set. Call once at CLI
 * startup, before subcommand dispatch. */
export async function resolveCliCredentials(
	io: CliCredsIO = {},
): Promise<void> {
	const env = io.env ?? process.env;
	const missing = CLI_CREDENTIAL_VARS.filter((v) => !env[v]);
	if (missing.length === 0) return;

	const readKeychain = io.readKeychain ?? defaultReadKeychain;
	for (const v of missing) {
		let value: string | null = null;
		try {
			value = await readKeychain(v);
		} catch (err) {
			// A missing item / `security` not signed in / not installed all
			// degrade to the next tier rather than aborting resolution for every
			// other var — but a genuinely unexpected failure here otherwise
			// surfaces only as an opaque "GITHUB_APP_ID is required" much later,
			// out of `getConfig()`, with no link back to the real cause.
			process.stderr.write(
				`ai-review: credential resolution failed for ${v}: ${errorMessage(err)}\n`,
			);
			value = null;
		}
		if (value) env[v] = value;
	}

	const stillMissing = CLI_CREDENTIAL_VARS.filter((v) => !env[v]);
	if (stillMissing.length === 0) return;

	const readXdgFile = io.readXdgFile ?? defaultReadXdgFile;
	let raw: string | null;
	try {
		raw = await readXdgFile();
	} catch (err) {
		process.stderr.write(
			`ai-review: XDG fallback file read failed: ${errorMessage(err)}\n`,
		);
		raw = null;
	}
	if (!raw) return;

	// dotenv parses line-by-line, so an unquoted multi-line PEM block would
	// only capture its first line. docs/cli-and-npm.md requires the
	// `\n`-escaped one-liner form for exactly this reason.
	const parsed = dotenv.parse(raw);
	for (const v of stillMissing) {
		// `stillMissing` was already filtered to `!env[v]` above, and nothing
		// between that filter and here writes to `env` — the guard here was
		// dead code, not a defense against a real interleaving.
		if (parsed[v]) env[v] = parsed[v];
	}
}

// `cmdCreds` (cli.ts) already validates the CLI-argument path before calling
// through to these, but this module is imported directly by tests and any
// future caller — the `CliCredentialVar` parameter type is a compile-time
// constraint only and does nothing against a caller that bypasses it (a
// plain JS caller, or a `string as CliCredentialVar` cast). Guard here too so
// an invalid var can't silently write/delete a Keychain entry regardless of
// caller.
function assertKnownCredentialVar(varName: CliCredentialVar): void {
	if (!(CLI_CREDENTIAL_VARS as readonly string[]).includes(varName)) {
		throw new Error(
			`Unknown credential variable "${varName}". Supported: ${CLI_CREDENTIAL_VARS.join(", ")}`,
		);
	}
}

export async function setCredential(
	varName: CliCredentialVar,
	value: string,
	io: Pick<CliCredsIO, "writeKeychain"> = {},
): Promise<void> {
	assertKnownCredentialVar(varName);
	const writeKeychain = io.writeKeychain ?? defaultWriteKeychain;
	await writeKeychain(varName, value);
}

/** Names only — never values — of the known vars that have a Keychain entry. */
export async function listCredentials(
	io: Pick<CliCredsIO, "readKeychain"> = {},
): Promise<CliCredentialVar[]> {
	const readKeychain = io.readKeychain ?? defaultReadKeychain;
	const present: CliCredentialVar[] = [];
	for (const v of CLI_CREDENTIAL_VARS) {
		let value: string | null = null;
		try {
			value = await readKeychain(v);
		} catch (err) {
			// Same reasoning as the resolveCliCredentials loop above: an
			// injected readKeychain that throws for a reason other than
			// "item not found"/"Keychain unavailable" is worth a diagnostic —
			// otherwise a locked Keychain reports as "nothing stored" with no
			// indication `list` couldn't actually check.
			process.stderr.write(
				`ai-review: Keychain read failed for ${v}: ${errorMessage(err)}\n`,
			);
			value = null;
		}
		if (value) present.push(v);
	}
	return present;
}

export async function unsetCredential(
	varName: CliCredentialVar,
	io: Pick<CliCredsIO, "deleteKeychain"> = {},
): Promise<void> {
	assertKnownCredentialVar(varName);
	const deleteKeychain = io.deleteKeychain ?? defaultDeleteKeychain;
	await deleteKeychain(varName);
}
