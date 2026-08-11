import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (orig) => {
	const actual = await orig<typeof import("./config.js")>();
	return { ...actual, getConfig: vi.fn(), getOpenAIAppConfig: vi.fn() };
});
vi.mock("./audit.js", async (orig) => {
	const actual = await orig<typeof import("./audit.js")>();
	return { ...actual, runLocalAudit: vi.fn() };
});

import { runLocalAudit } from "./audit.js";
import { cmdAudit } from "./cli.js";
import { getConfig, getOpenAIAppConfig } from "./config.js";

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
