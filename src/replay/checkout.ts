import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CheckoutHandle } from "./strategy.js";

const execFileAsync = promisify(execFile);

export type GitRunner = (
	args: string[],
	cwd?: string,
) => Promise<{ stdout: string }>;

export interface CheckoutUnavailable {
	unavailable: true;
	reason: string;
}

export interface CheckoutOptions {
	owner: string;
	repo: string;
	baseSha: string;
	headSha: string;
	cacheDir?: string;
	git?: GitRunner;
	remoteUrl?: (owner: string, repo: string) => Promise<string>;
}

export function isCheckoutUnavailable(
	value: unknown,
): value is CheckoutUnavailable {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { unavailable?: unknown }).unavailable === true
	);
}

const defaultGit: GitRunner = async (args, cwd) => {
	const { stdout } = await execFileAsync(
		"git",
		["-c", "core.hooksPath=/dev/null", ...args],
		{ cwd, maxBuffer: 16 * 1024 * 1024 },
	);
	return { stdout };
};

async function defaultRemoteUrl(owner: string, repo: string): Promise<string> {
	const { stdout } = await execFileAsync("gh", [
		"repo",
		"view",
		`${owner}/${repo}`,
		"--json",
		"url",
		"--jq",
		".url",
	]);
	return stdout.trim();
}

function cacheRoot(override?: string): string {
	return (
		override ??
		process.env.AI_REVIEW_CHECKOUT_DIR ??
		join(homedir(), ".ai-review", "checkouts")
	);
}

const message = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Runs `fn` against a read-only worktree of the repository at `headSha`. The bare clone is
 * cached and reused; the worktree is removed when `fn` returns or throws. A commit that
 * cannot be fetched yields `{unavailable: true, reason}` instead of throwing. Nothing in the
 * checkout is ever executed.
 */
export async function withCheckout<T>(
	opts: CheckoutOptions,
	fn: (handle: CheckoutHandle) => Promise<T>,
): Promise<T | CheckoutUnavailable> {
	const git = opts.git ?? defaultGit;
	const bare = join(
		cacheRoot(opts.cacheDir),
		`${opts.owner}__${opts.repo}.git`,
	);

	try {
		if (!(await exists(bare))) {
			await mkdir(cacheRoot(opts.cacheDir), { recursive: true });
			const url = await (opts.remoteUrl ?? defaultRemoteUrl)(
				opts.owner,
				opts.repo,
			);
			await git(["clone", "--bare", url, bare]);
		}
	} catch (err) {
		return { unavailable: true, reason: `clone failed: ${message(err)}` };
	}

	for (const [label, sha] of [
		["head", opts.headSha],
		["base", opts.baseSha],
	] as const) {
		try {
			await git(["cat-file", "-e", `${sha}^{commit}`], bare);
		} catch {
			try {
				await git(["fetch", "origin", sha], bare);
				await git(["cat-file", "-e", `${sha}^{commit}`], bare);
			} catch (err) {
				return {
					unavailable: true,
					reason: `${label} commit ${sha} not fetchable: ${message(err)}`,
				};
			}
		}
	}

	const scratch = await mkdtemp(join(tmpdir(), "ai-review-wt-"));
	const tree = join(scratch, "tree");
	try {
		try {
			await git(["worktree", "add", "--detach", tree, opts.headSha], bare);
			await execFileAsync("chmod", ["-R", "a-w", tree]);
		} catch (err) {
			return { unavailable: true, reason: `worktree failed: ${message(err)}` };
		}
		return await fn({
			path: tree,
			baseSha: opts.baseSha,
			headSha: opts.headSha,
		});
	} finally {
		await execFileAsync("chmod", ["-R", "u+w", scratch]).catch(() => {});
		await git(["worktree", "remove", "--force", tree], bare).catch(() => {});
		await rm(scratch, { recursive: true, force: true });
		await git(["worktree", "prune"], bare).catch(() => {});
	}
}
