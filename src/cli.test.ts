import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (orig) => {
	const actual = await orig<typeof import("./config.js")>();
	return { ...actual, getConfig: vi.fn(), getOpenAIAppConfig: vi.fn() };
});
vi.mock("./audit.js", async (orig) => {
	const actual = await orig<typeof import("./audit.js")>();
	return { ...actual, runLocalAudit: vi.fn() };
});
vi.mock("./improve/octokit.js", async (orig) => {
	const actual = await orig<typeof import("./improve/octokit.js")>();
	return {
		...actual,
		installationApp: vi.fn(),
		installationOctokit: vi.fn(),
	};
});
vi.mock("./watch.js", async (orig) => {
	const actual = await orig<typeof import("./watch.js")>();
	return { ...actual, watchPr: vi.fn() };
});
vi.mock("./cli-creds.js", async (orig) => {
	const actual = await orig<typeof import("./cli-creds.js")>();
	return {
		...actual,
		setCredential: vi.fn(),
		unsetCredential: vi.fn(),
		listCredentialSources: vi.fn(),
		resolveCliCredentials: vi.fn(),
	};
});

import { runLocalAudit } from "./audit.js";
import { resolveSubscriptionAuth } from "./auth.js";
import { cmdAudit, cmdCreds, cmdWatch, main, readHiddenLine } from "./cli.js";
import {
	listCredentialSources,
	resolveCliCredentials,
	setCredential,
	unsetCredential,
} from "./cli-creds.js";
import { getConfig, getOpenAIAppConfig } from "./config.js";
import { installationApp, installationOctokit } from "./improve/octokit.js";
import { watchPr } from "./watch.js";

class ProcessExitError extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

describe("cmdAudit credential validation", () => {
	beforeEach(() => {
		vi.mocked(getConfig).mockReset();
		vi.mocked(getOpenAIAppConfig).mockReset();
		vi.mocked(runLocalAudit).mockReset();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitError(code ?? 0);
		}) as never);
	});

	// Regression test for the unsafe `(err as Error).message` cast this diff
	// replaced: getConfig()/getOpenAIAppConfig() are untyped `unknown` at the
	// catch boundary, so a non-Error throw (a string, a plain object — plenty
	// of libraries and hand-rolled validators throw those) must still produce
	// a real, readable fatal message instead of silently printing "Error:
	// undefined", which is what `(err as Error).message` does when `err` has
	// no `.message` property.
	it("prints the real value when a config check throws a non-Error", async () => {
		vi.mocked(getConfig).mockImplementation(() => {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal
			throw "GITHUB_APP_PRIVATE_KEY is not set";
		});

		await expect(cmdAudit([])).rejects.toThrow(ProcessExitError);

		expect(console.error).toHaveBeenCalledWith(
			"Error: GITHUB_APP_PRIVATE_KEY is not set",
		);
		expect(process.exit).toHaveBeenCalledWith(1);
		expect(runLocalAudit).not.toHaveBeenCalled();
	});

	// String(err) on a plain object collapses it to "[object Object]",
	// throwing away whatever detail it carried (and throws outright for a
	// null-prototype object). inspect() preserves that detail instead.
	it("preserves object detail instead of collapsing to [object Object]", async () => {
		vi.mocked(getConfig).mockImplementation(() => {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal
			throw { code: "GITHUB_APP_PRIVATE_KEY is not set" };
		});

		await expect(cmdAudit([])).rejects.toThrow(ProcessExitError);

		const [message] = vi.mocked(console.error).mock.calls[0] as [string];
		expect(message).toContain("GITHUB_APP_PRIVATE_KEY is not set");
		expect(message).not.toContain("[object Object]");
	});

	it("still prints a real Error's message unchanged", async () => {
		vi.mocked(getConfig).mockImplementation(() => {
			throw new Error("OPENAI_APP_ID is not set");
		});

		await expect(cmdAudit([])).rejects.toThrow(ProcessExitError);

		expect(console.error).toHaveBeenCalledWith(
			"Error: OPENAI_APP_ID is not set",
		);
		expect(runLocalAudit).not.toHaveBeenCalled();
	});

	it("skips the credential check entirely for --dry-run", async () => {
		vi.mocked(getConfig).mockImplementation(() => {
			throw new Error("should never be reached");
		});
		vi.mocked(runLocalAudit).mockResolvedValue({
			artifacts: [],
			url: undefined,
			pr: undefined,
		} as unknown as Awaited<ReturnType<typeof runLocalAudit>>);

		await cmdAudit(["--dry-run"]);

		expect(getConfig).not.toHaveBeenCalled();
		expect(process.exit).not.toHaveBeenCalled();
	});
});

describe("cmdWatch", () => {
	let claudeGetInstallationOctokit: ReturnType<typeof vi.fn>;
	let codexGetInstallationOctokit: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.mocked(getConfig)
			.mockReset()
			.mockReturnValue({
				appId: "claude-app",
				privateKey: "claude-pem",
			} as unknown as ReturnType<typeof getConfig>);
		vi.mocked(getOpenAIAppConfig)
			.mockReset()
			.mockReturnValue({
				appId: "codex-app",
				privateKey: "codex-pem",
			} as unknown as ReturnType<typeof getOpenAIAppConfig>);
		claudeGetInstallationOctokit = vi
			.fn()
			.mockResolvedValue({ request: vi.fn() });
		codexGetInstallationOctokit = vi
			.fn()
			.mockResolvedValue({ request: vi.fn() });
		vi.mocked(installationApp)
			.mockReset()
			.mockImplementation(async (appId) => ({
				app: {
					marker: appId,
					getInstallationOctokit:
						appId === "claude-app"
							? claudeGetInstallationOctokit
							: codexGetInstallationOctokit,
				} as never,
				installationId: appId === "claude-app" ? 1 : 2,
			}));
		vi.mocked(installationOctokit)
			.mockReset()
			.mockResolvedValue({ request: vi.fn() } as never);
		vi.mocked(watchPr)
			.mockReset()
			.mockResolvedValue({ cycles: 1, reason: "merged" });
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitError(code ?? 0);
		}) as never);
	});

	it("requires --pr", async () => {
		await expect(cmdWatch(["--repo", "o/r"])).rejects.toThrow(ProcessExitError);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric --pr value", async () => {
		await expect(cmdWatch(["--pr", "abc", "--repo", "o/r"])).rejects.toThrow(
			ProcessExitError,
		);
		expect(console.error).toHaveBeenCalledWith(
			"Error: --pr must be a positive integer, got: abc",
		);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("rejects an invalid --provider value", async () => {
		await expect(
			cmdWatch(["--pr", "5", "--repo", "o/r", "--provider", "bogus"]),
		).rejects.toThrow(ProcessExitError);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("rejects a non-positive --interval value", async () => {
		await expect(
			cmdWatch(["--pr", "5", "--repo", "o/r", "--interval", "0"]),
		).rejects.toThrow(ProcessExitError);
		expect(console.error).toHaveBeenCalledWith(
			"Error: --interval must be a positive integer, got: 0",
		);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("rejects a --repo value with no slash", async () => {
		await expect(cmdWatch(["--pr", "5", "--repo", "noSlash"])).rejects.toThrow(
			ProcessExitError,
		);
		expect(console.error).toHaveBeenCalledWith(
			"Error: --repo must be <owner>/<name>, got: noSlash",
		);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("rejects a --repo value with an extra slash instead of silently truncating", async () => {
		await expect(cmdWatch(["--pr", "5", "--repo", "o/r/x"])).rejects.toThrow(
			ProcessExitError,
		);
		expect(console.error).toHaveBeenCalledWith(
			"Error: --repo must be <owner>/<name>, got: o/r/x",
		);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("rejects a --repo value with an empty owner or repo segment", async () => {
		await expect(cmdWatch(["--pr", "5", "--repo", "/r"])).rejects.toThrow(
			ProcessExitError,
		);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("defaults to both providers, a conservative 5-minute interval, and passes the resolved targets to watchPr", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r"]);

		expect(watchPr).toHaveBeenCalledTimes(1);
		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.owner).toBe("o");
		expect(call.repo).toBe("r");
		expect(call.pullNumber).toBe(5);
		expect(call.intervalMs).toBe(300_000);
		expect(call.targets.map((t) => t.provider)).toEqual([
			"anthropic",
			"openai",
		]);
		// pollOctokit is built directly off the already-resolved claude
		// installation (target[0].app.getInstallationOctokit), not by
		// re-resolving the installation through a second installationOctokit()
		// call — that would be a redundant GET /installation round trip.
		expect(claudeGetInstallationOctokit).toHaveBeenCalledWith(1);
		expect(installationOctokit).not.toHaveBeenCalled();
	});

	// A stray ANTHROPIC_API_KEY/OPENAI_API_KEY in the environment must never
	// silently defeat watch's whole reason for existing (bypassing a funded
	// API key via subscription auth) — confirmed live 2026-08-18 dogfooding
	// this PR: resolveAuth (api-key-first) was wired in here and reused a
	// dead ANTHROPIC_API_KEY from .env instead of falling back to the
	// logged-in `claude` session.
	it("wires the subscription-only auth resolver, not the api-key-first one", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r"]);

		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.resolveAuthFor).toBe(resolveSubscriptionAuth);
	});

	it("--provider narrows to a single target", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r", "--provider", "anthropic"]);

		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.targets.map((t) => t.provider)).toEqual(["anthropic"]);
		expect(getOpenAIAppConfig).not.toHaveBeenCalled();
	});

	it("--interval converts seconds to milliseconds", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r", "--interval", "15"]);

		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.intervalMs).toBe(15_000);
	});

	it("leaves the circuit breaker on watch.ts's own default by default", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r"]);

		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.circuitBreaker).toBeUndefined();
	});

	// ai-review-bot-599: the circuit breaker (watch.ts) is the mechanical
	// default; --no-circuit-breaker is the deliberate, explicit escape hatch
	// for e.g. a final confirmation pass the operator has already decided to
	// run unthrottled.
	it("--no-circuit-breaker disables the circuit breaker", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r", "--no-circuit-breaker"]);

		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.circuitBreaker).toBe(false);
	});
});

describe("main credential-resolution dispatch", () => {
	const originalArgv = process.argv;

	beforeEach(() => {
		vi.mocked(resolveCliCredentials).mockReset().mockResolvedValue(undefined);
		vi.mocked(listCredentialSources).mockReset().mockResolvedValue({
			GITHUB_APP_ID: "absent",
			GITHUB_APP_PRIVATE_KEY: "absent",
			OPENAI_APP_ID: "absent",
			OPENAI_APP_PRIVATE_KEY: "absent",
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitError(code ?? 0);
		}) as never);
	});

	afterEach(() => {
		process.argv = originalArgv;
	});

	// This is the actual regression ai-review-bot-yyn fixes: the CLI must
	// resolve credentials (Keychain/XDG) before any subcommand that needs
	// them runs, so watch/review/audit work when the globally npm-linked
	// binary is invoked from outside this repo. Locking the dispatch guard
	// in main() under test — not just resolveCliCredentials()'s own
	// internal logic — is what would actually catch a future regression
	// where a new subcommand is added above the check, or the check is
	// accidentally removed.
	it("resolves credentials before dispatching a normal subcommand", async () => {
		process.argv = ["node", "dist/cli.js", "unknown-subcommand"];
		await expect(main()).rejects.toThrow(ProcessExitError);
		expect(resolveCliCredentials).toHaveBeenCalled();
	});

	it("skips credential resolution for the creds subcommand itself", async () => {
		process.argv = ["node", "dist/cli.js", "creds", "list"];
		await main();
		expect(resolveCliCredentials).not.toHaveBeenCalled();
		expect(listCredentialSources).toHaveBeenCalled();
	});
});

describe("cmdCreds", () => {
	beforeEach(() => {
		vi.mocked(setCredential).mockReset().mockResolvedValue(undefined);
		vi.mocked(unsetCredential).mockReset().mockResolvedValue(undefined);
		vi.mocked(listCredentialSources).mockReset().mockResolvedValue({
			GITHUB_APP_ID: "absent",
			GITHUB_APP_PRIVATE_KEY: "absent",
			OPENAI_APP_ID: "absent",
			OPENAI_APP_PRIVATE_KEY: "absent",
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitError(code ?? 0);
		}) as never);
	});

	// Validates varName against CLI_CREDENTIAL_VARS before writing to the
	// Keychain — an unrecognized <VAR> otherwise silently wrote an orphaned
	// entry that `resolveCliCredentials`/`creds list` never look at again; a
	// typo like `GITHUB_APPID` looked like it worked and failed only much
	// later, in `watch`, with no link back to the typo.
	it("rejects an unknown var name for set", async () => {
		await expect(cmdCreds(["set", "NOT_A_REAL_VAR", "x"])).rejects.toThrow(
			ProcessExitError,
		);

		expect(setCredential).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringMatching(/NOT_A_REAL_VAR.*GITHUB_APP_ID/),
		);
	});

	it("rejects an unknown var name for unset", async () => {
		await expect(cmdCreds(["unset", "NOT_A_REAL_VAR"])).rejects.toThrow(
			ProcessExitError,
		);

		expect(unsetCredential).not.toHaveBeenCalled();
	});

	it("accepts a known var name with a positional value", async () => {
		await cmdCreds(["set", "GITHUB_APP_ID", "the-value"]);

		expect(setCredential).toHaveBeenCalledWith("GITHUB_APP_ID", "the-value");
		expect(process.exit).not.toHaveBeenCalled();
	});

	it("accepts a known var name for unset", async () => {
		await cmdCreds(["unset", "GITHUB_APP_ID"]);

		expect(unsetCredential).toHaveBeenCalledWith("GITHUB_APP_ID");
	});

	// A value with unquoted spaces (`ai-review creds set VAR one two`) used to
	// silently store "one" and drop "two" with no error — the same
	// truncated-value failure mode the PEM shape check exists to catch, but
	// for any var, not just private keys.
	it("rejects extra positional arguments to set instead of silently dropping them", async () => {
		await expect(
			cmdCreds(["set", "GITHUB_APP_ID", "one", "two"]),
		).rejects.toThrow(ProcessExitError);

		expect(setCredential).not.toHaveBeenCalled();
	});

	it("rejects extra positional arguments to unset", async () => {
		await expect(cmdCreds(["unset", "GITHUB_APP_ID", "extra"])).rejects.toThrow(
			ProcessExitError,
		);

		expect(unsetCredential).not.toHaveBeenCalled();
	});

	// `unsetCredential` only ever deletes the Keychain entry — it has no path
	// to edit ~/.config/ai-review/.env. A var satisfied purely by that file
	// is untouched by `creds unset`, so the flat "Removed" message would be
	// false for exactly the vars where the XDG fallback matters.
	it("warns instead of claiming success when unset can't actually clear an XDG-only credential", async () => {
		vi.mocked(listCredentialSources).mockResolvedValue({
			GITHUB_APP_ID: "xdg",
			GITHUB_APP_PRIVATE_KEY: "absent",
			OPENAI_APP_ID: "absent",
			OPENAI_APP_PRIVATE_KEY: "absent",
		});

		await cmdCreds(["unset", "GITHUB_APP_ID"]);

		expect(unsetCredential).toHaveBeenCalledWith("GITHUB_APP_ID");
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("still set in ~/.config/ai-review/.env"),
		);
	});

	it("reports plain success when unset actually cleared the only source (Keychain)", async () => {
		vi.mocked(listCredentialSources).mockResolvedValue({
			GITHUB_APP_ID: "absent",
			GITHUB_APP_PRIVATE_KEY: "absent",
			OPENAI_APP_ID: "absent",
			OPENAI_APP_PRIVATE_KEY: "absent",
		});

		await cmdCreds(["unset", "GITHUB_APP_ID"]);

		expect(console.log).toHaveBeenCalledWith(
			"Removed GITHUB_APP_ID from the Keychain (if it was set).",
		);
	});

	// Only set/unset dispatch had coverage; a typo in the "list" branch would
	// have gone uncaught.
	it("dispatches list and prints presence + source for every known var", async () => {
		vi.mocked(listCredentialSources).mockResolvedValue({
			GITHUB_APP_ID: "keychain",
			GITHUB_APP_PRIVATE_KEY: "absent",
			OPENAI_APP_ID: "absent",
			OPENAI_APP_PRIVATE_KEY: "xdg",
		});

		await cmdCreds(["list"]);

		expect(listCredentialSources).toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith("✓ GITHUB_APP_ID (Keychain)");
		expect(console.log).toHaveBeenCalledWith("✗ GITHUB_APP_PRIVATE_KEY");
		expect(console.log).toHaveBeenCalledWith("✗ OPENAI_APP_ID");
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining(
				"✓ OPENAI_APP_PRIVATE_KEY (~/.config/ai-review/.env",
			),
		);
	});

	// A value passed as `creds set <VAR> <value>` sits in argv (visible to
	// `ps` for the life of the process) and typically lands in shell
	// history. When the value is omitted, read it through an injectable,
	// non-argv channel instead.
	it("reads the value from the injected reader when omitted", async () => {
		const readSecret = vi.fn().mockResolvedValue("from-reader");

		await cmdCreds(["set", "GITHUB_APP_ID"], { readSecret });

		expect(readSecret).toHaveBeenCalled();
		expect(setCredential).toHaveBeenCalledWith("GITHUB_APP_ID", "from-reader");
	});

	it("fails clearly when the injected reader returns nothing", async () => {
		const readSecret = vi.fn().mockResolvedValue("");

		await expect(
			cmdCreds(["set", "GITHUB_APP_ID"], { readSecret }),
		).rejects.toThrow(ProcessExitError);

		expect(setCredential).not.toHaveBeenCalled();
	});

	// Round 5 of PR #72 review (codexreviewbot): an earlier version of this
	// code refused *all* interactive private-key entry, which also rejected
	// the documented, correct single-line \n-escaped paste — not just the
	// truncation-prone raw multi-line paste it was meant to catch. Replaced
	// with a shape check on the resolved value instead of blocking the
	// channel outright.
	it("accepts a private-key value that looks like a complete single-line PEM", async () => {
		await cmdCreds([
			"set",
			"GITHUB_APP_PRIVATE_KEY",
			"-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n",
		]);

		expect(setCredential).toHaveBeenCalledWith(
			"GITHUB_APP_PRIVATE_KEY",
			"-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n",
		);
	});

	it("rejects a private-key value truncated to just the BEGIN line (the raw multi-line-paste failure mode)", async () => {
		await expect(
			cmdCreds([
				"set",
				"GITHUB_APP_PRIVATE_KEY",
				"-----BEGIN PRIVATE KEY-----",
			]),
		).rejects.toThrow(ProcessExitError);

		expect(setCredential).not.toHaveBeenCalled();
	});
});

describe("readHiddenLine", () => {
	// A TTY without `setRawMode` (some CI pseudo-TTYs, certain terminal
	// emulation layers) used to fall through silently to cooked mode, where
	// the terminal echoes every typed character despite the "input hidden"
	// prompt — a real secret-exposure regression in exactly the path meant
	// to avoid it. This must fail closed instead.
	it("rejects instead of silently echoing input when the terminal has no setRawMode support", async () => {
		const fakeStdin = Object.create(process.stdin, {
			setRawMode: { value: undefined, configurable: true },
		});
		const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
		Object.defineProperty(process, "stdin", {
			value: fakeStdin,
			configurable: true,
		});
		try {
			await expect(readHiddenLine("Value: ")).rejects.toThrow(
				/not available on this terminal/,
			);
		} finally {
			if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
		}
	});
});
