import { execFileSync } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";

export interface AuditFile {
	path: string;
	content: string;
}
export type FileMode = "changed" | "full";
export type GitRunner = (args: readonly string[]) => string;

export const CODE_EXTENSIONS = new Set([
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

export function hasCodeExtension(p: string): boolean {
	const dot = p.lastIndexOf(".");
	return dot !== -1 && CODE_EXTENSIONS.has(p.slice(dot));
}

function defaultGitRunner(cwd: string): GitRunner {
	return (args) =>
		execFileSync("git", [...args], {
			cwd,
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
		});
}

function defaultBranch(runGit: GitRunner): string {
	// Resolve origin/HEAD → remote-tracking ref "origin/<name>"; this lets
	// merge-base work without a local branch of the same name. Fall back to the
	// bare "main" only when origin/HEAD is unset.
	try {
		const ref = runGit([
			"symbolic-ref",
			"--quiet",
			"refs/remotes/origin/HEAD",
		]).trim();
		const name = ref.split("/").pop();
		if (name) return `origin/${name}`;
	} catch {
		// origin/HEAD not set; fall through
	}
	return "main";
}

function changedPaths(runGit: GitRunner): string[] {
	const base = defaultBranch(runGit);
	const mergeBase = runGit(["merge-base", "HEAD", base]).trim() || base;
	const committed = runGit(["diff", "--name-only", mergeBase])
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	// porcelain lines look like " M path", "?? path", "A  path",
	// or rename entries "R  old -> new" — take the new path after " -> "
	const working = runGit(["status", "--porcelain"])
		.split("\n")
		.map((l) => {
			const rest = l.slice(3).trim();
			const arrow = rest.indexOf(" -> ");
			return arrow === -1 ? rest : rest.slice(arrow + 4).trim();
		})
		.filter(Boolean);
	return [...committed, ...working];
}

export async function collectFilesFromLocal(opts: {
	cwd: string;
	mode: FileMode;
	runGit?: GitRunner;
	readFile?: (p: string) => Promise<string>;
}): Promise<AuditFile[]> {
	const runGit = opts.runGit ?? defaultGitRunner(opts.cwd);
	const readFile =
		opts.readFile ??
		((p: string) => fsReadFile(path.join(opts.cwd, p), "utf-8"));

	const raw =
		opts.mode === "full"
			? runGit(["ls-files"])
					.split("\n")
					.map((l) => l.trim())
			: changedPaths(runGit);

	const unique = [...new Set(raw.filter(Boolean))]
		.filter(hasCodeExtension)
		.sort();

	const root = path.resolve(opts.cwd);
	const files: AuditFile[] = [];
	for (const p of unique) {
		// Guard against path traversal: skip anything that resolves outside cwd.
		const abs = path.resolve(opts.cwd, p);
		if (abs !== root && !abs.startsWith(root + path.sep)) continue;
		try {
			files.push({ path: p, content: await readFile(p) });
		} catch {
			// deleted, unreadable, or binary — skip
		}
	}
	return files;
}

/**
 * Collect the code files touched by a single commit, reading each file's
 * content **as of that commit** (`git show <sha>:<path>`) rather than the
 * current working tree — the review must reflect the commit, not later edits.
 *
 * Renamed and deleted paths are handled implicitly: `diff-tree` lists the old
 * path too, but `git show <sha>:<oldpath>` fails for a path that no longer
 * exists at the commit, so it is skipped. Reads from the object DB (not the
 * filesystem), so no path-traversal guard is required.
 */
export async function collectFilesFromCommit(opts: {
	cwd: string;
	sha: string;
	runGit?: GitRunner;
}): Promise<AuditFile[]> {
	const runGit = opts.runGit ?? defaultGitRunner(opts.cwd);

	const raw = runGit([
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		opts.sha,
	])
		.split("\n")
		.map((l) => l.trim());

	const unique = [...new Set(raw.filter(Boolean))]
		.filter(hasCodeExtension)
		.sort();

	const files: AuditFile[] = [];
	for (const p of unique) {
		try {
			files.push({ path: p, content: runGit(["show", `${opts.sha}:${p}`]) });
		} catch {
			// deleted in this commit (or the old side of a rename) — skip
		}
	}
	return files;
}
