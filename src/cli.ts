#!/usr/bin/env node
import process from "node:process";
import { App } from "octokit";
import { auditRepo } from "./audit.js";

function fatal(msg: string): never {
	console.error(`Error: ${msg}`);
	process.exit(1);
}

function usage(): never {
	console.error(
		"Usage: ai-review OWNER/REPO [--ref <branch>] [--dry-run] [--extra <instructions>]",
	);
	console.error("");
	console.error("Required env vars:");
	console.error("  GITHUB_APP_ID          — GitHub App ID");
	console.error(
		"  GITHUB_APP_PRIVATE_KEY — PKCS#8 private key (newlines as \\\\n)",
	);
	console.error("  ANTHROPIC_API_KEY      — Anthropic API key");
	process.exit(1);
}

function createApp(): App {
	const appId = process.env.GITHUB_APP_ID;
	const rawKey = process.env.GITHUB_APP_PRIVATE_KEY;
	if (!appId) fatal("GITHUB_APP_ID environment variable is required");
	if (!rawKey) fatal("GITHUB_APP_PRIVATE_KEY environment variable is required");
	// Normalize escaped newlines stored as \\n in env vars
	const privateKey = rawKey.replaceAll(String.raw`\n`, "\n");
	return new App({ appId, privateKey });
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0) usage();

	const repoArg = args[0];
	if (!repoArg.includes("/")) usage();
	const slashIdx = repoArg.indexOf("/");
	const owner = repoArg.slice(0, slashIdx);
	const repo = repoArg.slice(slashIdx + 1);

	let ref: string | undefined;
	let dryRun = false;
	let extraInstructions = "";

	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--ref" && args[i + 1]) {
			ref = args[++i];
		} else if (args[i] === "--dry-run") {
			dryRun = true;
		} else if (args[i] === "--extra" && args[i + 1]) {
			extraInstructions = args[++i];
		} else if (args[i].startsWith("--")) {
			fatal(`Unknown flag: ${args[i]}`);
		}
	}

	if (!owner || !repo) usage();

	const app = createApp();
	await auditRepo({ app, owner, repo, ref, extraInstructions, dryRun });
}

main().catch((err: unknown) => {
	console.error("Fatal:", err instanceof Error ? err.message : err);
	process.exit(1);
});
