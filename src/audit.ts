import type { App } from "octokit";
import { buildAuditUserMessage } from "./prompt.js";
import {
	type ModelReview,
	mergeReviews,
	runAgent,
	TIER1_SKILLS,
} from "./review.js";
import { routeModel } from "./router.js";

const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".rb",
	".java",
	".cs",
	".cpp",
	".c",
	".h",
	".swift",
	".kt",
]);

function hasCodeExtension(path: string): boolean {
	const dot = path.lastIndexOf(".");
	return dot !== -1 && CODE_EXTENSIONS.has(path.slice(dot));
}

export interface AuditParams {
	app: App;
	owner: string;
	repo: string;
	ref?: string;
	extraInstructions?: string;
	dryRun?: boolean;
}

export async function auditRepo({
	app,
	owner,
	repo,
	ref: refParam,
	extraInstructions = "",
	dryRun = false,
}: AuditParams): Promise<void> {
	// Resolve installation and get per-installation octokit
	const { data: installation } = await app.octokit.request(
		"GET /repos/{owner}/{repo}/installation",
		{ owner, repo },
	);
	const octokit = await app.getInstallationOctokit(installation.id);

	// Resolve ref to a concrete branch/SHA
	let ref = refParam;
	if (!ref) {
		const { data: repoData } = await octokit.request(
			"GET /repos/{owner}/{repo}",
			{ owner, repo },
		);
		ref = repoData.default_branch;
	}

	// Fetch the complete recursive file tree
	const { data: treeData } = await octokit.request(
		"GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
		{ owner, repo, tree_sha: ref, recursive: "1" },
	);

	if (treeData.truncated) {
		console.warn(
			"Warning: file tree was truncated — large repos may be partially audited.",
		);
	}

	const blobPaths = (treeData.tree as Array<{ type?: string; path?: string }>)
		.filter((e) => e.type === "blob" && e.path && hasCodeExtension(e.path))
		.map((e) => e.path as string);

	console.log(
		`Found ${blobPaths.length} code files in ${owner}/${repo}@${ref}`,
	);

	// Fetch file contents in parallel batches of 20
	const FETCH_BATCH_SIZE = 20;
	const files: Array<{ path: string; content: string }> = [];

	for (let i = 0; i < blobPaths.length; i += FETCH_BATCH_SIZE) {
		const slice = blobPaths.slice(i, i + FETCH_BATCH_SIZE);
		const results = await Promise.allSettled(
			slice.map(async (path) => {
				const { data } = await octokit.request(
					"GET /repos/{owner}/{repo}/contents/{path}",
					{ owner, repo, path, ref: ref as string },
				);
				const file = data as { content?: string; encoding?: string };
				if (file.encoding === "base64" && file.content) {
					return {
						path,
						content: Buffer.from(
							file.content.replace(/\n/g, ""),
							"base64",
						).toString("utf-8"),
					};
				}
				return null;
			}),
		);
		for (const r of results) {
			if (r.status === "fulfilled" && r.value) files.push(r.value);
		}
	}

	console.log(`Fetched ${files.length} files`);

	// Chunk files into content batches of ≤150 KB each
	const BATCH_BYTES = 150 * 1024;
	const batches: (typeof files)[] = [];
	let currentBatch: typeof files = [];
	let currentBytes = 0;

	for (const f of files) {
		if (
			currentBytes + f.content.length > BATCH_BYTES &&
			currentBatch.length > 0
		) {
			batches.push(currentBatch);
			currentBatch = [f];
			currentBytes = f.content.length;
		} else {
			currentBatch.push(f);
			currentBytes += f.content.length;
		}
	}
	if (currentBatch.length > 0) batches.push(currentBatch);

	console.log(`Running agents over ${batches.length} batch(es)...`);

	const selection = routeModel(
		{ additions: 0, deletions: 0, filePaths: blobPaths, labels: [] },
		"anthropic",
	);

	// Run all 5 agents on each batch, collect ModelReview results
	const allReviews: ModelReview[] = [];

	for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
		const batch = batches[batchIdx];
		console.log(
			`  Batch ${batchIdx + 1}/${batches.length}: ${batch.length} files`,
		);

		const userMessage = buildAuditUserMessage({
			owner,
			repo,
			ref,
			extraInstructions,
			files: batch,
		});

		const agentRuns = await Promise.allSettled(
			TIER1_SKILLS.map((skill) =>
				runAgent(skill, userMessage, selection, extraInstructions),
			),
		);

		for (const r of agentRuns) {
			if (r.status === "fulfilled" && r.value) {
				allReviews.push(r.value.review);
			}
		}
	}

	if (allReviews.length === 0) {
		console.log("No findings — all agents returned null.");
		return;
	}

	const merged = mergeReviews(allReviews);
	const date = new Date().toISOString().slice(0, 10);
	const body = formatAuditIssue({
		merged,
		owner,
		repo,
		ref,
		date,
		fileCount: files.length,
	});

	if (dryRun) {
		console.log("\n--- AUDIT REPORT ---\n");
		console.log(body);
		return;
	}

	const { data: issue } = await octokit.request(
		"POST /repos/{owner}/{repo}/issues",
		{ owner, repo, title: `Code Audit Report — ${date}`, body },
	);
	console.log(
		`\nAudit issue created: ${(issue as { html_url: string }).html_url}`,
	);
}

function formatAuditIssue({
	merged,
	owner,
	repo,
	ref,
	date,
	fileCount,
}: {
	merged: ModelReview;
	owner: string;
	repo: string;
	ref: string;
	date: string;
	fileCount: number;
}): string {
	const lines: string[] = [
		"## Code Audit Report",
		"",
		`**Repository:** ${owner}/${repo} &nbsp; **Ref:** ${ref} &nbsp; **Date:** ${date}`,
	];

	if (merged.summary) {
		lines.push("", "### Summary", "", merged.summary);
	}

	if (merged.general_findings.length > 0) {
		lines.push("", "### Findings");
		const emoji: Record<string, string> = {
			high: "🔴",
			medium: "🟡",
			low: "🟢",
		};
		for (const [i, f] of merged.general_findings.entries()) {
			lines.push(
				"",
				`${i + 1}. **${emoji[f.severity] ?? ""} [${f.severity.toUpperCase()}] ${f.title}**`,
				"",
				`   ${f.body}`,
			);
		}
	}

	if (merged.inline_comments.length > 0) {
		lines.push(
			"",
			"### Inline Notes",
			"",
			"| File | Line | Comment |",
			"|------|------|---------|",
		);
		for (const c of merged.inline_comments) {
			const truncated = c.body.slice(0, 120).replace(/[|\n]/g, " ");
			lines.push(
				`| \`${c.path}\` | ${c.line} | **${c.title}**: ${truncated} |`,
			);
		}
	}

	lines.push(
		"",
		"---",
		`*Generated by [ai-review-bot](https://github.com/joeblackwaslike/ai-review-bot) — ${fileCount} files reviewed*`,
	);

	return lines.join("\n");
}
