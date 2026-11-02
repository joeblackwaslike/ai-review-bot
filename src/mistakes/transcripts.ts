import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface SessionActivity {
	sessionId: string;
	times: number[];
	commitTimes: number[];
}

export interface TranscriptMatch {
	sessionId: string;
	confidence: "medium" | "low";
}

export const LATE_ACTIVITY_MS = 6 * 60 * 60 * 1000;

const GIT_COMMIT_OR_PUSH =
	/(?:^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?(?:commit|push)\b/;

interface TranscriptLine {
	sessionId?: unknown;
	gitBranch?: unknown;
	cwd?: unknown;
	timestamp?: unknown;
	message?: { content?: unknown };
}

function isGitCommitOrPush(line: TranscriptLine): boolean {
	const content = line.message?.content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(block) =>
			block?.type === "tool_use" &&
			block.name === "Bash" &&
			typeof block.input?.command === "string" &&
			GIT_COMMIT_OR_PUSH.test(block.input.command),
	);
}

function isRepoCwd(cwd: unknown, repoName: string): boolean {
	if (typeof cwd !== "string") return false;
	const trimmed = cwd.replace(/\/+$/, "");
	return (
		trimmed.slice(trimmed.lastIndexOf("/") + 1) === repoName ||
		cwd.includes(`/${repoName}/.worktrees/`)
	);
}

async function listDir(dir: string, warnings: string[]): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warnings.push(
				`could not list ${dir}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return [];
	}
}

/** A project dir belongs to `repoName` when its name ends with `-<repoName>` (a plain checkout) or contains `-<repoName>--worktrees-` (a worktree under it) — never by bare substring, so `ai-review-bot-demo` does not match `ai-review-bot`. */
async function projectFiles(
	dir: string,
	repoName: string,
	warnings: string[],
): Promise<string[]> {
	const needle = repoName.replace(/[^a-zA-Z0-9]/g, "-");
	const projects = (await listDir(dir, warnings)).filter(
		(name) =>
			name.endsWith(`-${needle}`) || name.includes(`-${needle}--worktrees-`),
	);
	const files: string[] = [];
	for (const project of projects) {
		for (const name of await listDir(join(dir, project), warnings)) {
			if (name.endsWith(".jsonl")) files.push(join(dir, project, name));
		}
	}
	return files;
}

/** Streams the repo's Claude Code transcripts and collects, per session, the times of lines on `branch` and of `git commit`/`git push` Bash calls among them. Malformed lines are counted in `skipped`. */
export async function scanTranscripts(opts: {
	dir: string;
	repoName: string;
	branch: string;
}): Promise<{
	sessions: SessionActivity[];
	skipped: number;
	warnings: string[];
}> {
	const sessions = new Map<string, SessionActivity>();
	let skipped = 0;
	const warnings: string[] = [];
	const needle = JSON.stringify(opts.branch).slice(1, -1);
	for (const file of await projectFiles(opts.dir, opts.repoName, warnings)) {
		try {
			const lines = createInterface({
				input: createReadStream(file, { encoding: "utf-8" }),
				crlfDelay: Number.POSITIVE_INFINITY,
			});
			for await (const raw of lines) {
				if (!raw.trim() || !raw.includes(needle)) continue;
				let line: TranscriptLine;
				try {
					line = JSON.parse(raw);
				} catch {
					skipped++;
					continue;
				}
				if (line?.gitBranch !== opts.branch) continue;
				if (!isRepoCwd(line.cwd, opts.repoName)) continue;
				if (typeof line.sessionId !== "string") continue;
				const at =
					typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
				if (Number.isNaN(at)) continue;
				const session = sessions.get(line.sessionId) ?? {
					sessionId: line.sessionId,
					times: [],
					commitTimes: [],
				};
				sessions.set(line.sessionId, session);
				session.times.push(at);
				if (isGitCommitOrPush(line)) session.commitTimes.push(at);
			}
		} catch (error) {
			warnings.push(
				`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	for (const s of sessions.values()) {
		s.times.sort((a, b) => a - b);
		s.commitTimes.sort((a, b) => a - b);
	}
	return { sessions: [...sessions.values()], skipped, warnings };
}

/** Picks the implementer session for a run at `runTime`: sessions active on the branch before the run, a commit or push before the run first, then the latest activity up to six hours after it. One session in the top tier is `medium`, a shared tier is `low`. */
export function pickSession(
	sessions: readonly SessionActivity[],
	runTime: number,
): TranscriptMatch | null {
	const cap = runTime + LATE_ACTIVITY_MS;
	const ranked = sessions
		.filter((s) => (s.times[0] ?? Number.POSITIVE_INFINITY) <= runTime)
		.map((s) => ({
			sessionId: s.sessionId,
			committed: s.commitTimes.some((c) => c <= runTime),
			last: s.times.reduce((m, t) => (t <= cap && t > m ? t : m), 0),
		}))
		.sort(
			(a, b) => Number(b.committed) - Number(a.committed) || b.last - a.last,
		);
	const best = ranked[0];
	if (!best) return null;
	const tier = ranked.filter((r) => r.committed === best.committed);
	return {
		sessionId: best.sessionId,
		confidence: tier.length === 1 ? "medium" : "low",
	};
}
