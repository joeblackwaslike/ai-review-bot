import { describe, expect, it, vi } from "vitest";

const requestMock = vi.fn();
const getInstallationOctokitMock = vi.fn();
const AppCtor = vi.fn().mockImplementation(() => ({
	octokit: { request: requestMock },
	getInstallationOctokit: getInstallationOctokitMock,
}));

vi.mock("octokit", () => ({ App: AppCtor }));

const { installationOctokit } = await import("./octokit.js");

describe("installationOctokit", () => {
	it("resolves the installation id then returns its Octokit", async () => {
		requestMock.mockResolvedValue({ data: { id: 42 } });
		getInstallationOctokitMock.mockResolvedValue({
			marker: "installation-octokit",
		});

		const result = await installationOctokit(
			"app-1",
			"-----BEGIN...",
			"owner",
			"repo",
		);

		expect(requestMock).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/installation",
			{ owner: "owner", repo: "repo" },
		);
		expect(getInstallationOctokitMock).toHaveBeenCalledWith(42);
		expect(result).toEqual({ marker: "installation-octokit" });
	});

	it("normalizes escaped \\n sequences in the private key", async () => {
		requestMock.mockResolvedValue({ data: { id: 1 } });
		getInstallationOctokitMock.mockResolvedValue({});

		await installationOctokit(
			"app-1",
			String.raw`line1\nline2`,
			"owner",
			"repo",
		);

		expect(AppCtor).toHaveBeenCalledWith({
			appId: "app-1",
			privateKey: "line1\nline2",
		});
	});
});
