import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLI_CREDENTIAL_VARS,
	KEYCHAIN_SERVICE,
	listCredentials,
	resolveCliCredentials,
	setCredential,
	unsetCredential,
} from "./cli-creds.js";

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
		const present = await listCredentials({ readKeychain });
		expect(present).toEqual(["GITHUB_APP_ID"]);
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
