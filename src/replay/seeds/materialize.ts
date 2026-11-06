import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Seed } from "./schema.js";

const execFileAsync = promisify(execFile);

export interface MaterializedSeed {
	repoPath: string;
	baseSha: string;
	headSha: string;
	cleanup(): Promise<void>;
}

const FIXED_DATE = "2026-01-01T00:00:00+00:00";

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		[
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"user.name=seed",
			"-c",
			"user.email=seed@example.invalid",
			...args,
		],
		{
			cwd,
			env: {
				...process.env,
				GIT_AUTHOR_DATE: FIXED_DATE,
				GIT_COMMITTER_DATE: FIXED_DATE,
			},
		},
	);
	return stdout.trim();
}

async function replaceTree(repo: string, from: string): Promise<void> {
	for (const e of await readdir(repo)) {
		if (e !== ".git") await rm(join(repo, e), { recursive: true, force: true });
	}
	await cp(from, repo, { recursive: true });
}

async function commitTree(
	repo: string,
	from: string,
	message: string,
): Promise<string> {
	await replaceTree(repo, from);
	await git(repo, ["add", "-A", "-f"]);
	await git(repo, ["commit", "-q", "--allow-empty", "-m", message]);
	return git(repo, ["rev-parse", "HEAD"]);
}

/** Builds a temp git repo with a base commit and a head commit from the seed's trees. */
export async function materializeSeed(seed: Seed): Promise<MaterializedSeed> {
	const repoPath = await mkdtemp(join(tmpdir(), "ai-review-seed-"));
	const cleanup = () => rm(repoPath, { recursive: true, force: true });
	try {
		await git(repoPath, ["init", "-q", "-b", "main"]);
		const baseSha = await commitTree(repoPath, join(seed.dir, "base"), "base");
		const headSha = await commitTree(repoPath, join(seed.dir, "head"), "head");
		return { repoPath, baseSha, headSha, cleanup };
	} catch (err) {
		await cleanup();
		throw err;
	}
}
