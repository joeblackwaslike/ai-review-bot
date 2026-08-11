import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openIssueFromProposal } from "./actions";

const authMock = vi.hoisted(() => vi.fn());
const installationOctokitMock = vi.hoisted(() => vi.fn());
const openProposalIssueMock = vi.hoisted(() => vi.fn());

vi.mock("../auth", () => ({ auth: authMock }));
vi.mock("../../src/improve/octokit", () => ({
	installationOctokit: installationOctokitMock,
}));
vi.mock("../../src/improve/issues", () => ({
	openProposalIssue: openProposalIssueMock,
}));

const plan = {
	kind: "severity_reliability" as const,
	signature: "severity_reliability:high",
	title: "t",
	body: "b",
	targetFile: "src/prompt.ts",
};

describe("openIssueFromProposal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("refuses when there is no authenticated session", async () => {
		authMock.mockResolvedValue(null);

		const result = await openIssueFromProposal(plan);

		expect(result).toEqual({ action: "failed", error: "unauthenticated" });
		expect(installationOctokitMock).not.toHaveBeenCalled();
	});

	it("fails clearly when GitHub App credentials are not configured", async () => {
		authMock.mockResolvedValue({ user: { name: "Joe" } });
		vi.stubEnv("GITHUB_APP_ID", "");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");

		const result = await openIssueFromProposal(plan);

		expect(result.action).toBe("failed");
		expect(installationOctokitMock).not.toHaveBeenCalled();
	});

	it("fails clearly when IMPROVE_TARGET_REPO is malformed", async () => {
		authMock.mockResolvedValue({ user: { name: "Joe" } });
		vi.stubEnv("GITHUB_APP_ID", "app-1");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "key");
		vi.stubEnv("IMPROVE_TARGET_REPO", "just-a-name");

		const result = await openIssueFromProposal(plan);

		expect(result).toEqual({
			action: "failed",
			error: "IMPROVE_TARGET_REPO must be <owner>/<repo>",
		});
		expect(installationOctokitMock).not.toHaveBeenCalled();
	});

	it("rejects a PKCS#1-formatted private key before calling installationOctokit", async () => {
		authMock.mockResolvedValue({ user: { name: "Joe" } });
		vi.stubEnv("GITHUB_APP_ID", "app-1");
		vi.stubEnv(
			"GITHUB_APP_PRIVATE_KEY",
			"-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
		);
		vi.stubEnv("IMPROVE_TARGET_REPO", "o/r");

		const result = await openIssueFromProposal(plan);

		expect(result.action).toBe("failed");
		expect(result.error).toContain("PKCS#1 format");
		expect(installationOctokitMock).not.toHaveBeenCalled();
	});

	it("stays dry-run by default (DASHBOARD_DRY_RUN unset)", async () => {
		authMock.mockResolvedValue({ user: { name: "Joe" } });
		vi.stubEnv("GITHUB_APP_ID", "app-1");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "key");
		vi.stubEnv("IMPROVE_TARGET_REPO", "o/r");
		installationOctokitMock.mockResolvedValue({ marker: "octokit" });
		openProposalIssueMock.mockResolvedValue({ action: "would_create" });

		await openIssueFromProposal(plan);

		expect(openProposalIssueMock).toHaveBeenCalledWith({
			octokit: { marker: "octokit" },
			owner: "o",
			repo: "r",
			plan,
			dryRun: true,
		});
	});

	it("goes live only when DASHBOARD_DRY_RUN=false, using an installation Octokit", async () => {
		authMock.mockResolvedValue({ user: { name: "Joe" } });
		vi.stubEnv("GITHUB_APP_ID", "app-1");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "key");
		vi.stubEnv("IMPROVE_TARGET_REPO", "o/r");
		vi.stubEnv("DASHBOARD_DRY_RUN", "false");
		installationOctokitMock.mockResolvedValue({ marker: "octokit" });
		openProposalIssueMock.mockResolvedValue({
			action: "created",
			url: "https://github.com/o/r/issues/1",
		});

		const result = await openIssueFromProposal(plan);

		expect(installationOctokitMock).toHaveBeenCalledWith(
			"app-1",
			"key",
			"o",
			"r",
		);
		expect(openProposalIssueMock).toHaveBeenCalledWith({
			octokit: { marker: "octokit" },
			owner: "o",
			repo: "r",
			plan,
			dryRun: false,
		});
		expect(result).toEqual({
			action: "created",
			url: "https://github.com/o/r/issues/1",
		});
	});

	it("fails cleanly instead of throwing when installationOctokit rejects", async () => {
		authMock.mockResolvedValue({ user: { name: "Joe" } });
		vi.stubEnv("GITHUB_APP_ID", "app-1");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "key");
		vi.stubEnv("IMPROVE_TARGET_REPO", "o/r");
		installationOctokitMock.mockRejectedValue(
			new Error("installation not found"),
		);

		const result = await openIssueFromProposal(plan);

		expect(result).toEqual({
			action: "failed",
			error: "installation not found",
		});
		expect(openProposalIssueMock).not.toHaveBeenCalled();
	});
});
