import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { App } from "octokit";
import {
	createHeadBranch,
	ensureOrphanBase,
	type OctokitLike,
	openDraftPr,
	postProviderReview,
} from "./audit-pr.js";
import { buildAuditUserMessage } from "./prompt.js";
import {
	type ModelReview,
	mergeReviews,
	runAgent,
	TIER1_SKILLS,
} from "./review.js";
import { type ModelSelection, routeModel } from "./router.js";
import {
	type AuditFile,
	collectFilesFromLocal,
	type FileMode,
	hasCodeExtension,
} from "./sources.js";

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
		const size = Buffer.byteLength(f.content, "utf8");
		if (bytes + size > BATCH_BYTES && current.length > 0) {
			batches.push(current);
			current = [f];
			bytes = size;
		} else {
			current.push(f);
			bytes += size;
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
		// stderr so machine-readable --json stdout stays clean.
		console.error(
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
			if (r.status === "fulfilled" && r.value.status === "ok")
				reviews.push(r.value.review);
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

const PROVIDERS = ["anthropic", "openai"] as const;

export interface LocalAuditResult {
	providers: Array<{ provider: "anthropic" | "openai"; review: ModelReview }>;
	artifacts: string[];
	pr?: number;
	url?: string;
}

export async function runLocalAudit(opts: {
	cwd: string;
	mode: FileMode;
	outDir: string;
	dryRun: boolean;
	extraInstructions?: string;
	resolvePr?: () => Promise<{
		octokit: OctokitLike;
		owner: string;
		repo: string;
		baseBranch: string;
		postAs: Array<{
			provider: "anthropic" | "openai";
			prefix: string;
			octokit?: OctokitLike;
		}>;
	}>;
}): Promise<LocalAuditResult> {
	const files = await collectFilesFromLocal({ cwd: opts.cwd, mode: opts.mode });
	const filePaths = files.map((f) => f.path);
	const meta = { owner: "local", repo: "local", ref: "working-tree" };
	const extraInstructions = opts.extraInstructions ?? "";

	const providers: LocalAuditResult["providers"] = [];
	const perProvider: Array<{ review: ModelReview; meta: AuditMeta }> = [];

	for (const provider of PROVIDERS) {
		const selection = routeModel(
			{ additions: 0, deletions: 0, filePaths, labels: [] },
			provider,
		);
		const review = await runAuditPass({
			files,
			selection,
			extraInstructions,
			meta,
		});
		providers.push({ provider, review });
		perProvider.push({
			review,
			meta: {
				...meta,
				provider,
				model: selection.model,
				fileCount: files.length,
			},
		});
	}

	const combined = mergeReviews(providers.map((p) => p.review));
	const markdown = formatAuditIssue({
		merged: combined,
		owner: meta.owner,
		repo: meta.repo,
		ref: meta.ref,
		date: new Date().toISOString().slice(0, 10),
		fileCount: files.length,
	});
	const artifacts = await writeArtifacts({
		outDir: opts.outDir,
		perProvider,
		markdown,
	});

	if (opts.dryRun) {
		return { providers, artifacts };
	}

	const hasFindings =
		combined.general_findings.length > 0 || combined.inline_comments.length > 0;
	if (!hasFindings || !opts.resolvePr) {
		return { providers, artifacts };
	}

	const ctx = await opts.resolvePr();
	const ORPHAN = "ai-review/empty";
	const head = `ai-review/audit-${Date.now()}`;

	let number: number;
	let url: string;
	let headSha: string;
	// Only the branch/PR-creation calls are guarded by the 403 → issue fallback.
	// A 403 here means contents:write was not granted, so no PR was created.
	// Posting errors (after the PR exists) must propagate normally.
	try {
		await ensureOrphanBase(ctx.octokit, ctx.owner, ctx.repo, ORPHAN);
		await createHeadBranch({
			octokit: ctx.octokit,
			owner: ctx.owner,
			repo: ctx.repo,
			branch: head,
			baseBranch: ctx.baseBranch,
			files,
		});
		const opened = await openDraftPr({
			octokit: ctx.octokit,
			owner: ctx.owner,
			repo: ctx.repo,
			head,
			base: ORPHAN,
			title: `AI audit — ${new Date().toISOString().slice(0, 10)}`,
		});
		number = opened.number;
		url = opened.url;
		headSha = await headShaFor(ctx.octokit, ctx.owner, ctx.repo, head);
	} catch (err) {
		if ((err as { status?: number }).status === 403) {
			console.warn(
				"contents:write not granted — PR path skipped; writing artifacts + issue fallback.",
			);
			try {
				await createOrUpdateAuditIssue({
					octokit: ctx.octokit,
					owner: ctx.owner,
					repo: ctx.repo,
					body: markdown,
				});
			} catch {
				// best-effort: artifacts are already written regardless
			}
			return { providers, artifacts };
		}
		throw err;
	}

	const pullFiles = files.map((f) => ({
		filename: f.path,
		status: "added",
		patch: `@@ -0,0 +1,${f.content.split("\n").length} @@\n${f.content
			.split("\n")
			.map((l) => `+${l}`)
			.join("\n")}`,
	}));
	for (const target of ctx.postAs) {
		const review = providers.find(
			(p) => p.provider === target.provider,
		)?.review;
		if (review) {
			await postProviderReview({
				octokit: target.octokit ?? ctx.octokit,
				owner: ctx.owner,
				repo: ctx.repo,
				pullNumber: number,
				headSha,
				files: pullFiles,
				review,
				prefix: target.prefix,
			});
		}
	}
	// persist meta.pr into the JSON artifacts
	for (const entry of perProvider) entry.meta.pr = number;
	await writeArtifacts({ outDir: opts.outDir, perProvider, markdown });
	return { providers, artifacts, pr: number, url };
}

async function headShaFor(
	octokit: OctokitLike,
	owner: string,
	repo: string,
	branch: string,
): Promise<string> {
	const { data } = await octokit.request<{ object: { sha: string } }>(
		"GET /repos/{owner}/{repo}/git/ref/{ref}",
		{ owner, repo, ref: `heads/${branch}` },
	);
	return data.object.sha;
}

// Idempotent fallback: reuse the open "Code Audit Report" issue, else create one.
async function createOrUpdateAuditIssue(opts: {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	body: string;
}): Promise<void> {
	const { octokit, owner, repo, body } = opts;
	const title = `Code Audit Report — ${new Date().toISOString().slice(0, 10)}`;
	const { data: open } = await octokit.request<
		Array<{ number: number; title: string }>
	>("GET /repos/{owner}/{repo}/issues", {
		owner,
		repo,
		state: "open",
		labels: "AI audit",
	});
	const existing = open.find((i) => i.title.startsWith("Code Audit Report"));
	if (existing) {
		await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
			owner,
			repo,
			issue_number: existing.number,
			body,
		});
	} else {
		await octokit.request("POST /repos/{owner}/{repo}/issues", {
			owner,
			repo,
			title,
			body,
			labels: ["AI audit"],
		});
	}
}
