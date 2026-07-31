#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { App, Octokit } from "octokit";
import {
	auditRepo,
	type ReviewScope,
	runLocalAudit,
	runLocalReview,
} from "./audit.js";
import { makeReady, type OctokitLike } from "./audit-pr.js";
import { getConfig, getOpenAIAppConfig } from "./config.js";
import {
	type BackfillOctokit,
	type BackfillResult,
	backfillPr,
	discoverReviewedPrs,
} from "./improve/backfill.js";
import { classifyBundles } from "./improve/classify.js";
import { getDb } from "./improve/db/client.js";
import {
	insertClassified,
	listUnclassifiedBundles,
} from "./improve/db/repo.js";
import { fpSignature } from "./improve/match.js";
import { slugify } from "./report.js";

function fatal(msg: string): never {
	console.error(`Error: ${msg}`);
	process.exit(1);
}

// Reads the value for a value-taking flag at args[i]. Errors clearly if the
// value is missing (flag was last) or looks like another flag (e.g.
// `--commit --slug x` would otherwise silently swallow `--slug` as the sha).
// Pass `i++` so the consumed value is skipped by the loop.
function requireValue(args: string[], i: number, flag: string): string {
	const value = args[i + 1];
	if (value === undefined || value.startsWith("--")) {
		fatal(`Flag ${flag} requires a value`);
	}
	return value;
}

function usage(): never {
	console.error("Usage:");
	console.error(
		"  ai-review review [--full | --commit <sha>] [--slug <slug>] [--title <t>] [--out <dir>] [--extra <text>] [--json]",
	);
	console.error(
		"      Local code review → Markdown report in docs/code-reviews/.",
	);
	console.error(
		"      Auth: prefers OPENAI_API_KEY / ANTHROPIC_API_KEY, else falls back to your",
	);
	console.error(
		"      logged-in `codex` / `claude` subscription (local, personal use only).",
	);
	console.error(
		"  ai-review audit [--full] [--dry-run] [--out <dir>] [--extra <text>] [--json]",
	);
	console.error("  ai-review ready [pr#]");
	console.error("  ai-review backfill --repo <owner/name> [--pr <n>] [--json]");
	console.error(
		"      Harvest already-posted findings, reactions and reply threads into the",
	);
	console.error(
		"      Neon corpus. Requires DATABASE_URL. Idempotent — safe to re-run.",
	);
	console.error("  ai-review classify [--limit <n>] [--dry-run] [--json]");
	console.error(
		"      Classify captured feedback into intents. Requires DATABASE_URL.",
	);
	console.error(
		"  ai-review OWNER/REPO [...]      (legacy remote audit — deprecated)",
	);
	process.exit(1);
}

function createApp(): App {
	const appId = process.env.GITHUB_APP_ID;
	const rawKey = process.env.GITHUB_APP_PRIVATE_KEY;
	if (!appId) fatal("GITHUB_APP_ID environment variable is required");
	if (!rawKey) fatal("GITHUB_APP_PRIVATE_KEY environment variable is required");
	return new App({
		appId,
		// Normalize escaped newlines stored as \n in env vars.
		privateKey: rawKey.replaceAll(String.raw`\n`, "\n"),
	});
}

function originSlug(): { owner: string; repo: string } {
	let url: string;
	try {
		url = execFileSync("git", ["remote", "get-url", "origin"], {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
	} catch {
		fatal("not inside a git repository with an 'origin' remote");
	}
	const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
	if (!m) fatal(`Cannot parse owner/repo from origin: ${url}`);
	return { owner: m[1], repo: m[2] };
}

async function installationOctokit(
	appId: string,
	privateKey: string,
	owner: string,
	repo: string,
) {
	const app = new App({
		appId,
		privateKey: privateKey.replaceAll(String.raw`\n`, "\n"),
	});
	const { data: inst } = await app.octokit.request(
		"GET /repos/{owner}/{repo}/installation",
		{ owner, repo },
	);
	return app.getInstallationOctokit(inst.id);
}

async function buildResolvePr() {
	const { owner, repo } = originSlug();
	const claude = getConfig();
	const codex = getOpenAIAppConfig();
	const claudeKit = await installationOctokit(
		claude.appId,
		claude.privateKey,
		owner,
		repo,
	);
	const codexKit = await installationOctokit(
		codex.appId,
		codex.privateKey,
		owner,
		repo,
	);
	const { data: repoData } = await claudeKit.request(
		"GET /repos/{owner}/{repo}",
		{
			owner,
			repo,
		},
	);

	// Each postProviderReview must run under the matching identity; runLocalAudit
	// uses ctx.octokit for branch/PR ops and looks up per-provider kits via postAs.
	return {
		octokit: claudeKit as unknown as OctokitLike,
		owner,
		repo,
		baseBranch: repoData.default_branch,
		postAs: [
			{
				provider: "anthropic" as const,
				prefix: claude.reviewCommentPrefix,
				octokit: claudeKit as unknown as OctokitLike,
			},
			{
				provider: "openai" as const,
				prefix: codex.reviewCommentPrefix,
				octokit: codexKit as unknown as OctokitLike,
			},
		],
	};
}

function gitOut(args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
	} catch {
		return null;
	}
}

function deriveSlug(scope: ReviewScope): string {
	if (scope.kind === "commit") {
		const subject = gitOut(["show", "-s", "--format=%s", scope.sha]);
		return slugify(subject ?? scope.sha.slice(0, 7));
	}
	if (scope.kind === "full") return "full-audit";
	const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
	return slugify(branch && branch !== "HEAD" ? branch : "local-changes");
}

function deriveTitle(scope: ReviewScope): string {
	if (scope.kind === "commit")
		return `Code Review — commit ${scope.sha.slice(0, 7)}`;
	if (scope.kind === "full") return "Code Review — full tree";
	return "Code Review — local changes";
}

async function cmdReview(args: string[]): Promise<void> {
	let scope: ReviewScope = { kind: "changed" };
	let slug: string | undefined;
	let title: string | undefined;
	let extra = "";
	let outDir = "docs/code-reviews";
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--full") scope = { kind: "full" };
		else if (a === "--commit")
			scope = { kind: "commit", sha: requireValue(args, i++, a) };
		else if (a === "--slug") slug = requireValue(args, i++, a);
		else if (a === "--title") title = requireValue(args, i++, a);
		else if (a === "--extra") extra = requireValue(args, i++, a);
		else if (a === "--out") outDir = requireValue(args, i++, a);
		else if (a === "--json") json = true;
		else if (a.startsWith("--")) fatal(`Unknown flag: ${a}`);
	}

	const { owner, repo } = originSlug();
	const result = await runLocalReview({
		cwd: process.cwd(),
		scope,
		docsDir: outDir,
		slug: slug ?? deriveSlug(scope),
		title: title ?? deriveTitle(scope),
		owner,
		repo,
		remote: `https://github.com/${owner}/${repo}`,
		extraInstructions: extra,
	});

	if (json) {
		console.log(
			JSON.stringify({
				path: result.path,
				durationSeconds: result.durationSeconds,
				costUsd: result.costUsd,
				filesReviewed: result.filesReviewed,
				providers: result.providersRun,
			}),
		);
	} else {
		console.log(`Report: ${result.path}`);
		console.log(
			`${result.filesReviewed} file(s) · ${result.providersRun.join(" + ")} · ${result.durationSeconds}s · $${result.costUsd.toFixed(4)}`,
		);
	}
}

async function cmdAudit(args: string[]): Promise<void> {
	let mode: "changed" | "full" = "changed";
	let dryRun = false;
	let outDir = ".ai-review";
	let extra = "";
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--full") mode = "full";
		else if (a === "--dry-run") dryRun = true;
		else if (a === "--out") outDir = requireValue(args, i++, a);
		else if (a === "--extra") extra = requireValue(args, i++, a);
		else if (a === "--json") json = true;
		else if (a.startsWith("--")) fatal(`Unknown flag: ${a}`);
	}

	// Validate both apps' creds upfront so a non-dry-run doesn't burn two
	// expensive provider passes only to fail at PR-post time.
	if (!dryRun) {
		try {
			getConfig();
			getOpenAIAppConfig();
		} catch (err) {
			fatal((err as Error).message);
		}
	}

	const result = await runLocalAudit({
		cwd: process.cwd(),
		mode,
		outDir,
		dryRun,
		extraInstructions: extra,
		resolvePr: dryRun ? undefined : buildResolvePr,
	});

	if (json) {
		console.log(
			JSON.stringify({
				pr: result.pr,
				url: result.url,
				artifacts: result.artifacts,
			}),
		);
	} else {
		console.log(`Artifacts: ${result.artifacts.join(", ")}`);
		if (result.url) console.log(`Review PR: ${result.url}`);
	}
}

async function cmdReady(args: string[]): Promise<void> {
	const positional = args.find((a) => !a.startsWith("--"));
	const { owner, repo } = originSlug();
	const claude = getConfig();
	const octokit = await installationOctokit(
		claude.appId,
		claude.privateKey,
		owner,
		repo,
	);

	// `ready` always acts under the Claude identity; the PR number is
	// provider-agnostic, so reading the anthropic artifact is sufficient.
	let pr = positional ? Number(positional) : undefined;
	if (!pr) {
		try {
			const meta = JSON.parse(
				await readFile(".ai-review/audit-anthropic.json", "utf-8"),
			);
			pr = meta?.meta?.pr;
		} catch (err) {
			if (err instanceof SyntaxError)
				fatal(
					"audit file .ai-review/audit-anthropic.json is corrupt: could not parse JSON",
				);
			// File absent (ENOENT) → fall through to the "no PR" fatal below.
			// Any other error (e.g. EACCES) is unexpected — rethrow.
			if ((err as { code?: string }).code !== "ENOENT") throw err;
		}
	}
	if (!pr)
		fatal(
			"No PR number given and none recorded in .ai-review/audit-anthropic.json",
		);

	const { data: repoData } = await octokit.request(
		"GET /repos/{owner}/{repo}",
		{
			owner,
			repo,
		},
	);
	await makeReady({
		octokit: octokit as unknown as OctokitLike,
		owner,
		repo,
		pullNumber: pr,
		base: repoData.default_branch,
	});
	console.log(
		`PR #${pr} retargeted to ${repoData.default_branch} and marked ready.`,
	);
}

async function cmdLegacyRemote(args: string[]): Promise<void> {
	const repoArg = args[0];
	if (!repoArg.includes("/")) usage();
	const slashIdx = repoArg.indexOf("/");
	const owner = repoArg.slice(0, slashIdx);
	const repo = repoArg.slice(slashIdx + 1);

	let ref: string | undefined;
	let dryRun = false;
	let extraInstructions = "";
	let provider: "anthropic" | "openai" = "anthropic";

	for (let i = 1; i < args.length; i++) {
		const a = args[i];
		if (a === "--ref") {
			ref = requireValue(args, i++, a);
		} else if (a === "--dry-run") {
			dryRun = true;
		} else if (a === "--extra") {
			extraInstructions = requireValue(args, i++, a);
		} else if (a === "--provider") {
			const val = requireValue(args, i++, a);
			if (val !== "anthropic" && val !== "openai")
				fatal(`Invalid provider: ${val} (must be "anthropic" or "openai")`);
			provider = val;
		} else if (a.startsWith("--")) {
			fatal(`Unknown flag: ${a}`);
		}
	}

	if (!owner || !repo) usage();

	const app = createApp();
	await auditRepo({
		app,
		owner,
		repo,
		ref,
		extraInstructions,
		dryRun,
		provider,
	});
}

async function cmdBackfill(args: string[]): Promise<void> {
	let slug: string | undefined;
	let pr: number | undefined;
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--repo") slug = requireValue(args, i++, a);
		else if (a === "--pr") {
			const raw = requireValue(args, i++, a);
			pr = Number(raw);
			// Without this, `--pr 55x` yields NaN, which is falsy and silently
			// falls through to repo-wide discovery — a typo would harvest every
			// reviewed PR instead of failing.
			if (!Number.isInteger(pr) || pr <= 0) {
				fatal(`--pr must be a positive integer, got: ${raw}`);
			}
		} else if (a === "--json") json = true;
		else if (a.startsWith("--")) fatal(`Unknown flag: ${a}`);
	}

	const [owner, repo] = (slug ?? "").split("/");
	if (!owner || !repo) fatal("--repo <owner/name> is required");

	// The backfill only reads (comments, reactions, threads) and posts nothing,
	// so a personal token is sufficient and is preferred when present: it avoids
	// needing the App's private key on a developer machine just to harvest.
	const token = process.env.GITHUB_TOKEN;
	const octokit = (token
		? new Octokit({ auth: token })
		: await (async () => {
				const config = getConfig();
				return installationOctokit(
					config.appId,
					config.privateKey,
					owner,
					repo,
				);
			})()) as unknown as BackfillOctokit;

	const targets = pr ? [pr] : await discoverReviewedPrs(octokit, owner, repo);
	if (!pr) {
		console.error(`Discovered ${targets.length} reviewed PR(s) in ${slug}`);
	}

	const db = getDb();
	const results: BackfillResult[] = [];
	for (const number of targets) {
		const result = await backfillPr(
			{ db, octokit },
			{ owner, repo, pr: number },
		);
		results.push(result);
		if (!json) {
			console.log(
				`#${number}: ${result.findings} findings, ${result.reactions} reactions, ${result.replies} replies` +
					(result.unparseable > 0 ? `, ${result.unparseable} unparseable` : ""),
			);
		}
	}

	const totals = results.reduce(
		(acc, r) => ({
			findings: acc.findings + r.findings,
			reactions: acc.reactions + r.reactions,
			replies: acc.replies + r.replies,
			unparseable: acc.unparseable + r.unparseable,
		}),
		{ findings: 0, reactions: 0, replies: 0, unparseable: 0 },
	);

	if (json) console.log(JSON.stringify({ prs: results, totals }, null, 2));
	else console.log(`\nTotals: ${JSON.stringify(totals)}`);
}

async function cmdClassify(args: string[]): Promise<void> {
	let limit = 500;
	let json = false;
	let dryRun = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--limit") {
			const raw = requireValue(args, i++, a);
			limit = Number(raw);
			if (!Number.isInteger(limit) || limit <= 0) {
				fatal(`--limit must be a positive integer, got: ${raw}`);
			}
		} else if (a === "--dry-run") dryRun = true;
		else if (a === "--json") json = true;
		else if (a.startsWith("--")) fatal(`Unknown flag: ${a}`);
	}

	const db = getDb();
	const bundles = await listUnclassifiedBundles(db, limit);
	if (bundles.length === 0) {
		console.log("Nothing to classify.");
		return;
	}

	const classified = await classifyBundles(bundles, {
		provider: "anthropic",
		model: "claude-haiku-4-5",
	});

	const byId = new Map(bundles.map((b) => [b.rawFeedbackId, b]));
	let written = 0;
	for (const c of classified) {
		const bundle = byId.get(c.rawFeedbackId);
		if (!bundle) continue;
		if (dryRun) continue;
		written += await insertClassified(db, {
			rawFeedbackId: c.rawFeedbackId,
			intent: c.intent,
			confidence: c.confidence.toFixed(2),
			isBotRelated: c.isBotRelated,
			matchedFindingId: bundle.findingId,
			fpSignature: fpSignature(bundle.skills, bundle.findingTitle),
			model: c.model,
		});
	}

	const counts: Record<string, number> = {};
	for (const c of classified) counts[c.intent] = (counts[c.intent] ?? 0) + 1;
	const deterministic = classified.filter(
		(c) => c.model === "deterministic",
	).length;

	const summary = {
		considered: bundles.length,
		classified: classified.length,
		unresolved: bundles.length - classified.length,
		deterministic,
		viaModel: classified.length - deterministic,
		written,
		byIntent: counts,
	};
	console.log(
		json ? JSON.stringify(summary, null, 2) : JSON.stringify(summary),
	);
}

async function main(): Promise<void> {
	const [sub, ...rest] = process.argv.slice(2);
	if (sub === "classify") return cmdClassify(rest);

	if (sub === "review") return cmdReview(rest);
	if (sub === "audit") return cmdAudit(rest);
	if (sub === "ready") return cmdReady(rest);
	if (sub === "backfill") return cmdBackfill(rest);
	if (sub?.includes("/")) return cmdLegacyRemote([sub, ...rest]); // back-compat
	usage();
}

main().catch((err: unknown) => {
	console.error("Fatal:", err instanceof Error ? err.message : err);
	process.exit(1);
});
