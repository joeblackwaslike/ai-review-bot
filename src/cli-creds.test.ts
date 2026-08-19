import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (orig) => {
	const actual = await orig<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn() };
});

import {
	CLI_CREDENTIAL_VARS,
	type CliCredentialVar,
	isItemNotFoundError,
	isKeychainUnavailableError,
	KEYCHAIN_SERVICE,
	listCredentialSources,
	listCredentials,
	looksLikeCompletePemOneLiner,
	resolveCliCredentials,
	setCredential,
	unsetCredential,
} from "./cli-creds.js";

// Node-style (error, stdout, stderr) callback shape execFile actually uses —
// promisify's generic wrapper (no [promisify.custom] on our mock) rejects
// with exactly whatever `err` this passes, so a manually-attached `.stderr`
// on `err` is enough to exercise the real rejection shape without needing
// to replicate child_process's custom promisify behavior.
function mockExecFileRejection(err: unknown): void {
	vi.mocked(execFile).mockImplementation((..._args: unknown[]) => {
		const cb = _args[_args.length - 1] as (e: unknown) => void;
		cb(err);
		return {} as ReturnType<typeof execFile>;
	});
}

describe("resolveCliCredentials", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("never overwrites a var already present in env", async () => {
		const env: Record<string, string | undefined> = {
			GITHUB_APP_ID: "already-set",
		};
		const readKeychain = vi.fn(async () => "from-keychain");
		await resolveCliCredentials({ env, readKeychain });
		expect(env.GITHUB_APP_ID).toBe("already-set");
		expect(readKeychain).not.toHaveBeenCalledWith("GITHUB_APP_ID");
	});

	it("fills an unset var from the Keychain", async () => {
		const env: Record<string, string | undefined> = {};
		const readKeychain = vi.fn(async (account: string) =>
			account === "GITHUB_APP_ID" ? "kc-value" : null,
		);
		await resolveCliCredentials({ env, readKeychain });
		expect(env.GITHUB_APP_ID).toBe("kc-value");
	});

	it("resolves each var independently — one missing Keychain item never blocks the others", async () => {
		const env: Record<string, string | undefined> = {};
		const readKeychain = vi.fn(async (account: string) => {
			if (account === "GITHUB_APP_ID") return null; // missing
			if (account === "OPENAI_APP_ID") return "codex-id";
			return null;
		});
		await resolveCliCredentials({ env, readKeychain });
		expect(env.GITHUB_APP_ID).toBeUndefined();
		expect(env.OPENAI_APP_ID).toBe("codex-id");
	});

	it("degrades cleanly when the Keychain read throws (security not signed in / item missing)", async () => {
		const env: Record<string, string | undefined> = {};
		const readKeychain = vi.fn(async () => {
			throw new Error("security: item not found");
		});
		await expect(
			resolveCliCredentials({ env, readKeychain }),
		).resolves.not.toThrow();
		expect(env.GITHUB_APP_ID).toBeUndefined();
	});

	it("falls back to the XDG file only for vars the Keychain didn't resolve", async () => {
		const env: Record<string, string | undefined> = {};
		const readKeychain = vi.fn(async (account: string) =>
			account === "GITHUB_APP_ID" ? "kc-value" : null,
		);
		const readXdgFile = vi.fn(
			async () => "GITHUB_APP_ID=file-value\nOPENAI_APP_ID=file-codex-id\n",
		);
		await resolveCliCredentials({ env, readKeychain, readXdgFile });
		// Keychain already resolved GITHUB_APP_ID — the file must not override it.
		expect(env.GITHUB_APP_ID).toBe("kc-value");
		// Keychain had nothing for OPENAI_APP_ID — the file fills the gap.
		expect(env.OPENAI_APP_ID).toBe("file-codex-id");
	});

	it("a missing XDG file is not an error", async () => {
		const env: Record<string, string | undefined> = {};
		const readKeychain = vi.fn(async () => null);
		const readXdgFile = vi.fn(async () => null);
		await expect(
			resolveCliCredentials({ env, readKeychain, readXdgFile }),
		).resolves.not.toThrow();
		expect(env.GITHUB_APP_ID).toBeUndefined();
	});

	it("skips the Keychain and XDG lookups entirely once every known var is already set", async () => {
		const env: Record<string, string | undefined> = Object.fromEntries(
			CLI_CREDENTIAL_VARS.map((v) => [v, `preset-${v}`]),
		);
		const readKeychain = vi.fn(async () => "should-not-be-used");
		const readXdgFile = vi.fn(async () => "should-not-be-used");
		await resolveCliCredentials({ env, readKeychain, readXdgFile });
		expect(readKeychain).not.toHaveBeenCalled();
		expect(readXdgFile).not.toHaveBeenCalled();
	});
});

describe("setCredential / listCredentials / unsetCredential", () => {
	it("setCredential writes through the injected Keychain writer with the right service/account", async () => {
		const writeKeychain = vi.fn(async () => {});
		await setCredential("GITHUB_APP_ID", "the-value", { writeKeychain });
		expect(writeKeychain).toHaveBeenCalledWith("GITHUB_APP_ID", "the-value");
	});

	it("listCredentials reports only vars with a Keychain entry, never values", async () => {
		const readKeychain = vi.fn(async (account: string) =>
			account === "GITHUB_APP_ID" ? "secret-value" : null,
		);
		const readXdgFile = vi.fn(async () => null);
		const present = await listCredentials({ readKeychain, readXdgFile });
		expect(present).toEqual(["GITHUB_APP_ID"]);
	});

	it("listCredentials also reports a var satisfied only by the XDG fallback file", async () => {
		// Mirrors resolveCliCredentials's own fallback order — a var absent
		// from the Keychain but present in ~/.config/ai-review/.env resolves
		// fine at CLI startup, so `list` must not report it as ✗.
		const readKeychain = vi.fn(async () => null);
		const readXdgFile = vi.fn(
			async () => "GITHUB_APP_ID=from-file\nOPENAI_APP_ID=also-from-file\n",
		);
		const present = await listCredentials({ readKeychain, readXdgFile });
		expect(present).toEqual(
			expect.arrayContaining(["GITHUB_APP_ID", "OPENAI_APP_ID"]),
		);
	});

	it("listCredentials reads the XDG file at most once even when multiple vars fall through to it", async () => {
		const readKeychain = vi.fn(async () => null);
		const readXdgFile = vi.fn(async () => "GITHUB_APP_ID=x\n");
		await listCredentials({ readKeychain, readXdgFile });
		expect(readXdgFile).toHaveBeenCalledTimes(1);
	});

	// An empty-string Keychain value (however it got that way — only an
	// injected reader can produce one; defaultReadKeychain folds "" to null)
	// is genuinely stored, not absent. A truthy check would silently report
	// it as "xdg" or "absent" instead of "keychain", diverging from what the
	// var actually resolves to.
	it("listCredentialSources reports an empty-string Keychain value as keychain-sourced, not absent", async () => {
		const readKeychain = vi.fn(async () => "");
		const readXdgFile = vi.fn(async () => null);
		const sources = await listCredentialSources({ readKeychain, readXdgFile });
		expect(sources.GITHUB_APP_ID).toBe("keychain");
	});

	it("listCredentialSources reports which store satisfies each var — Keychain, XDG, or neither", async () => {
		// `creds unset` only removes from the Keychain, so a var satisfied
		// purely by the XDG file needs to be visibly distinguishable from one
		// `unset` can actually clear — otherwise `list` says "present" and
		// `unset` silently does nothing.
		const readKeychain = vi.fn(async (account: string) =>
			account === "GITHUB_APP_ID" ? "kc-value" : null,
		);
		const readXdgFile = vi.fn(async () => "OPENAI_APP_ID=from-file\n");
		const sources = await listCredentialSources({ readKeychain, readXdgFile });
		expect(sources.GITHUB_APP_ID).toBe("keychain");
		expect(sources.OPENAI_APP_ID).toBe("xdg");
		expect(sources.GITHUB_APP_PRIVATE_KEY).toBe("absent");
		expect(sources.OPENAI_APP_PRIVATE_KEY).toBe("absent");
	});

	// `CliCredentialVar` on these signatures is a compile-time constraint
	// only — `cmdCreds` already validates before calling in, but this module
	// is imported directly by tests and any future caller, so a bypass (e.g.
	// a plain-JS caller, or `"X" as CliCredentialVar`) must still be rejected
	// at runtime rather than writing/deleting an arbitrary Keychain entry.
	it("setCredential rejects a var name outside CLI_CREDENTIAL_VARS even if the type system is bypassed", async () => {
		const writeKeychain = vi.fn(async () => {});
		await expect(
			setCredential("NOT_A_REAL_VAR" as CliCredentialVar, "x", {
				writeKeychain,
			}),
		).rejects.toThrow(/Unknown credential variable/);
		expect(writeKeychain).not.toHaveBeenCalled();
	});

	it("unsetCredential rejects a var name outside CLI_CREDENTIAL_VARS even if the type system is bypassed", async () => {
		const deleteKeychain = vi.fn(async () => {});
		await expect(
			unsetCredential("NOT_A_REAL_VAR" as CliCredentialVar, {
				deleteKeychain,
			}),
		).rejects.toThrow(/Unknown credential variable/);
		expect(deleteKeychain).not.toHaveBeenCalled();
	});

	it("unsetCredential calls through the injected deleter", async () => {
		const deleteKeychain = vi.fn(async () => {});
		await unsetCredential("GITHUB_APP_ID", { deleteKeychain });
		expect(deleteKeychain).toHaveBeenCalledWith("GITHUB_APP_ID");
	});
});

describe("KEYCHAIN_SERVICE / CLI_CREDENTIAL_VARS", () => {
	it("uses a dedicated service name distinct from the Claude Code OAuth keychain item", () => {
		expect(KEYCHAIN_SERVICE).toBe("ai-review-cli-credentials");
	});

	it("covers the 4 identity vars ai-review watch needs to post through the GitHub App bots", () => {
		expect(CLI_CREDENTIAL_VARS).toEqual([
			"GITHUB_APP_ID",
			"GITHUB_APP_PRIVATE_KEY",
			"OPENAI_APP_ID",
			"OPENAI_APP_PRIVATE_KEY",
		]);
	});
});

// `defaultDeleteKeychain`'s catch used to swallow every `security` failure,
// not just "item not found" — so `creds unset` reported success even when the
// Keychain was locked or deletion otherwise failed. `security` distinguishes
// this reliably: exit code 44 with a stable stderr message for "not found",
// and `ENOENT` when the `security` binary itself isn't present (Linux,
// Windows, sandboxed CI). These two classifiers are what the default
// read/write/delete implementations key off to decide swallow-and-degrade
// vs. surface-the-real-error.
describe("isItemNotFoundError / isKeychainUnavailableError", () => {
	it("isItemNotFoundError recognizes security's exit code for a missing item", () => {
		expect(isItemNotFoundError({ code: 44 })).toBe(true);
	});

	// The real shape a rejected execFile() promise carries is an `Error`
	// instance with a numeric `code` property, not a bare object — a test
	// that only covers `{ code: 44 }` wouldn't catch a regression that
	// narrowed the check to `err instanceof Error` in a way that dropped the
	// `.code` read.
	it("isItemNotFoundError recognizes the real execFile rejection shape (Error with a numeric code)", () => {
		const nodeErr = Object.assign(new Error("exit 44"), { code: 44 });
		expect(isItemNotFoundError(nodeErr)).toBe(true);
	});

	it("isItemNotFoundError rejects other error shapes", () => {
		expect(isItemNotFoundError({ code: 1 })).toBe(false);
		expect(isItemNotFoundError(new Error("boom"))).toBe(false);
		expect(isItemNotFoundError(null)).toBe(false);
		expect(isItemNotFoundError(undefined)).toBe(false);
	});

	it("isKeychainUnavailableError recognizes ENOENT (security binary missing)", () => {
		expect(isKeychainUnavailableError({ code: "ENOENT" })).toBe(true);
	});

	// EACCES: the `security` binary is present but not executable by this
	// process (e.g. a restrictive sandbox) — same practical outcome as
	// ENOENT (Keychain can't be reached), so it degrades the same way.
	it("isKeychainUnavailableError recognizes EACCES (security binary not executable)", () => {
		expect(isKeychainUnavailableError({ code: "EACCES" })).toBe(true);
	});

	it("isKeychainUnavailableError rejects other error shapes", () => {
		expect(isKeychainUnavailableError({ code: 44 })).toBe(false);
		expect(isKeychainUnavailableError(new Error("boom"))).toBe(false);
		expect(isKeychainUnavailableError(null)).toBe(false);
	});
});

describe("looksLikeCompletePemOneLiner", () => {
	it("accepts the documented single-line \\n-escaped form", () => {
		expect(
			looksLikeCompletePemOneLiner(
				"-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n",
			),
		).toBe(true);
	});

	it("rejects a value truncated to just the BEGIN line", () => {
		expect(looksLikeCompletePemOneLiner("-----BEGIN PRIVATE KEY-----")).toBe(
			false,
		);
	});
});

// setCredential's own PEM shape check for `_PRIVATE_KEY` vars is
// defense-in-depth, mirroring the assertKnownCredentialVar pattern above: a
// caller that imports setCredential directly (bypassing cmdCreds' identical
// check) must not be able to silently store a truncated PEM.
describe("setCredential PEM validation", () => {
	it("rejects a truncated PEM for a _PRIVATE_KEY var even when called directly", async () => {
		const writeKeychain = vi.fn(async () => {});
		await expect(
			setCredential("GITHUB_APP_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----", {
				writeKeychain,
			}),
		).rejects.toThrow(/doesn't look like a complete PEM/);
		expect(writeKeychain).not.toHaveBeenCalled();
	});

	it("accepts a complete single-line PEM for a _PRIVATE_KEY var", async () => {
		const writeKeychain = vi.fn(async () => {});
		const value =
			"-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n";
		await setCredential("GITHUB_APP_PRIVATE_KEY", value, { writeKeychain });
		expect(writeKeychain).toHaveBeenCalledWith("GITHUB_APP_PRIVATE_KEY", value);
	});

	it("does not apply the PEM shape check to non-private-key vars", async () => {
		const writeKeychain = vi.fn(async () => {});
		await setCredential("GITHUB_APP_ID", "12345", { writeKeychain });
		expect(writeKeychain).toHaveBeenCalledWith("GITHUB_APP_ID", "12345");
	});
});

// A locked/denied Keychain write's rejection from `execFile` embeds the
// full command line it ran — including the `-w <value>` argument carrying
// the secret that just failed to write. Only the default (non-injected)
// writeKeychain goes through execFile at all, so these tests exercise
// setCredential without an injected writer to cover that real path.
describe("defaultWriteKeychain error sanitization (security-relevant)", () => {
	afterEach(() => {
		vi.mocked(execFile).mockReset();
	});

	it("never echoes the secret value into the thrown error when execFile's rejection has no stderr", async () => {
		const secret =
			"-----BEGIN PRIVATE KEY-----\\nTOTALLY-SECRET-VALUE\\n-----END PRIVATE KEY-----";
		mockExecFileRejection(
			new Error(
				`Command failed: security add-generic-password -U -s ai-review-cli-credentials -a GITHUB_APP_PRIVATE_KEY -w ${secret}`,
			),
		);

		let caught: unknown;
		try {
			await setCredential("GITHUB_APP_PRIVATE_KEY", secret);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(String(caught)).not.toContain("TOTALLY-SECRET-VALUE");
	});

	it("surfaces execFile's .stderr (the tool's own diagnostic, never the input value) when present", async () => {
		const secret =
			"-----BEGIN PRIVATE KEY-----\\nOTHER-SECRET-VALUE\\n-----END PRIVATE KEY-----";
		mockExecFileRejection(
			Object.assign(
				new Error(
					`Command failed: security add-generic-password ... -w ${secret}`,
				),
				{ stderr: "SecKeychainAddGenericPassword: -25293 (auth failed)" },
			),
		);

		await expect(
			setCredential("GITHUB_APP_PRIVATE_KEY", secret),
		).rejects.toThrow(/SecKeychainAddGenericPassword: -25293/);

		let caught: unknown;
		try {
			await setCredential("GITHUB_APP_PRIVATE_KEY", secret);
		} catch (err) {
			caught = err;
		}
		expect(String(caught)).not.toContain("OTHER-SECRET-VALUE");
	});
});
