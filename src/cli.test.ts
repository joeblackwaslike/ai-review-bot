import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { runLocalAudit } from "./audit.js";
import { cmdAudit, cmdWatch } from "./cli.js";
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
		vi.mocked(installationApp)
			.mockReset()
			.mockImplementation(async (appId) => ({
				app: { marker: appId } as never,
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

	it("rejects an invalid --provider value", async () => {
		await expect(
			cmdWatch(["--pr", "5", "--repo", "o/r", "--provider", "bogus"]),
		).rejects.toThrow(ProcessExitError);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("defaults to both providers, 60s interval, and passes the resolved targets to watchPr", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r"]);

		expect(watchPr).toHaveBeenCalledTimes(1);
		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.owner).toBe("o");
		expect(call.repo).toBe("r");
		expect(call.pullNumber).toBe(5);
		expect(call.intervalMs).toBe(60_000);
		expect(call.targets.map((t) => t.provider)).toEqual([
			"anthropic",
			"openai",
		]);
		expect(installationOctokit).toHaveBeenCalledWith(
			"claude-app",
			"claude-pem",
			"o",
			"r",
		);
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
});
