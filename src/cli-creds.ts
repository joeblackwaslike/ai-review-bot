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
	} catch {
		return null;
	}
}

async function defaultWriteKeychain(
	account: string,
	value: string,
): Promise<void> {
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
	} catch {
		// Already absent — deleting a credential that isn't there is a no-op,
		// not a failure.
	}
}

async function defaultReadXdgFile(): Promise<string | null> {
	try {
		return await readFile(XDG_ENV_PATH, "utf-8");
	} catch {
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
		if (env[v]) continue;
		let value: string | null = null;
		try {
			value = await readKeychain(v);
		} catch {
			// A missing item / `security` not signed in / not installed all
			// degrade to the next tier rather than aborting resolution for
			// every other var.
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
	} catch {
		raw = null;
	}
	if (!raw) return;

	const parsed = dotenv.parse(raw);
	for (const v of stillMissing) {
		if (!env[v] && parsed[v]) env[v] = parsed[v];
	}
}

export async function setCredential(
	varName: string,
	value: string,
	io: Pick<CliCredsIO, "writeKeychain"> = {},
): Promise<void> {
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
		} catch {
			value = null;
		}
		if (value) present.push(v);
	}
	return present;
}

export async function unsetCredential(
	varName: string,
	io: Pick<CliCredsIO, "deleteKeychain"> = {},
): Promise<void> {
	const deleteKeychain = io.deleteKeychain ?? defaultDeleteKeychain;
	await deleteKeychain(varName);
}
