"use server";

import "server-only";
import { validatePrivateKey } from "../../src/config";
import {
	type IssueOctokit,
	openProposalIssue,
	type ProposalPlan,
} from "../../src/improve/issues";
import { installationOctokit } from "../../src/improve/octokit";
import { auth } from "../auth";

export interface OpenIssueResult {
	action: "created" | "commented" | "would_create" | "would_comment" | "failed";
	url?: string;
	error?: string;
}

/** Gated behind DASHBOARD_DRY_RUN so the first deploy can be exercised without
 * filing real issues. Unset or any value other than the literal "false" stays
 * in dry-run — flip to "false" only after manually verifying one real
 * create/comment against a scratch repo (see the design spec's Manual steps). */
export async function openIssueFromProposal(
	plan: ProposalPlan,
): Promise<OpenIssueResult> {
	const session = await auth();
	if (!session?.user) return { action: "failed", error: "unauthenticated" };

	const slug =
		process.env.IMPROVE_TARGET_REPO ?? "joeblackwaslike/ai-review-bot";
	const [owner, repo] = slug.split("/");
	if (!owner || !repo) {
		return {
			action: "failed",
			error: "IMPROVE_TARGET_REPO must be <owner>/<repo>",
		};
	}
	const appId = process.env.GITHUB_APP_ID;
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
	if (!appId || !privateKey) {
		return {
			action: "failed",
			error: "GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY not configured",
		};
	}

	let validatedPrivateKey: string;
	try {
		validatedPrivateKey = validatePrivateKey(privateKey);
	} catch (err) {
		return {
			action: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	const octokit = (await installationOctokit(
		appId,
		validatedPrivateKey,
		owner,
		repo,
	)) as unknown as IssueOctokit;

	const dryRun = process.env.DASHBOARD_DRY_RUN !== "false";
	return openProposalIssue({ octokit, owner, repo, plan, dryRun });
}
