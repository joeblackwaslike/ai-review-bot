import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { App } from "octokit";
import { buildAuditUserMessage } from "./prompt.js";
import {
	type ModelReview,
	mergeReviews,
	runAgent,
	TIER1_SKILLS,
} from "./review.js";
import { type ModelSelection, routeModel } from "./router.js";
import { type AuditFile, hasCodeExtension } from "./sources.js";

export interface AuditParams {
	app: App;
	owner: string;
	repo: string;
	ref?: string;
	extraInstructions?: string;
	dryRun?: boolean;
	provider?: "anthropic" | "openai";
}

const BATCH_BYTES = 150 * 1024;

function batchFiles(files: AuditFile[]): AuditFile[][] {
	const batches: AuditFile[][] = [];
	let current: AuditFile[] = [];
	let bytes = 0;
	for (const f of files) {
		if (bytes + f.content.length > BATCH_BYTES && current.length > 0) {
			batches.push(current);
			current = [f];
			bytes = f.content.length;
		} else {
			current.push(f);
			bytes += f.content.length;
		}
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

export async function runAuditPass(opts: {
	files: AuditFile[];
	selection: ModelSelection;
	extraInstructions: string;
	meta: { owner: string; repo: string; ref: string };
}): Promise<ModelReview> {
	const { files, selection, extraInstructions, meta } = opts;
	const reviews: ModelReview[] = [];

	const batches = batchFiles(files);

	for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
		const batch = batches[batchIdx];
		console.log(
			`  Batch ${batchIdx + 1}/${batches.length}: ${batch.length} files`,
		);
		const userMessage = buildAuditUserMessage({
			owner: meta.owner,
			repo: meta.repo,
			ref: meta.ref,
			extraInstructions,
			files: batch,
		});
		const settled = await Promise.allSettled(
			TIER1_SKILLS.map((skill) =>
				runAgent(skill, userMessage, selection, extraInstructions),
			),
		);
		for (const r of settled) {
			if (r.status === "fulfilled" && r.value) reviews.push(r.value.review);
		}
	}

	if (reviews.length === 0) {
		return { event: "COMMENT", general_findings: [], inline_comments: [] };
	}
	return mergeReviews(reviews);
}

export async function auditRepo({
	app,
	owner,
	repo,
	ref: refParam,
	extraInstructions = "",
	dryRun = false,
	provider = "anthropic",
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
	const files: AuditFile[] = [];

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

	const selection = routeModel(
		{ additions: 0, deletions: 0, filePaths: blobPaths, labels: [] },
		provider,
	);

	console.log(`Running agents over ${files.length} file(s)...`);

	const merged = await runAuditPass({
		files,
		selection,
		extraInstructions,
		meta: { owner, repo, ref },
	});
	if (
		merged.general_findings.length === 0 &&
		merged.inline_comments.length === 0
	) {
		console.log("No findings.");
		return;
	}

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

export interface AuditMeta {
	owner: string;
	repo: string;
	ref: string;
	provider: "anthropic" | "openai";
	model: string;
	fileCount: number;
	pr?: number;
}

export function formatAuditJson(opts: {
	review: ModelReview;
	meta: AuditMeta;
}): string {
	return JSON.stringify({ meta: opts.meta, review: opts.review }, null, 2);
}

export async function writeArtifacts(opts: {
	outDir: string;
	perProvider: Array<{ review: ModelReview; meta: AuditMeta }>;
	markdown: string;
}): Promise<string[]> {
	await mkdir(opts.outDir, { recursive: true });
	const written: string[] = [];
	try {
		for (const entry of opts.perProvider) {
			const file = path.join(opts.outDir, `audit-${entry.meta.provider}.json`);
			await writeFile(file, formatAuditJson(entry), "utf-8");
			written.push(file);
		}
		const md = path.join(opts.outDir, "audit.md");
		await writeFile(md, opts.markdown, "utf-8");
		written.push(md);
	} catch (error) {
		throw new Error(
			`Failed to write audit artifacts to ${opts.outDir}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return written;
}
