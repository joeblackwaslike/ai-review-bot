import { parse } from "yaml";
import type { KvClient } from "../feedback/kv.js";
import { type RepoConfig, RepoConfigSchema } from "./schema.js";

export const REPO_CONFIG_PATH = ".github/ai-review.yml";
const MAX_BYTES = 20_000;
const CACHE_TTL_SECONDS = 600;
const MAX_ALIAS_COUNT = 10;
const GENERIC_NOTE = "repo config could not be read";

export interface RepoConfigResult {
	config?: RepoConfig;
	note?: string;
}

export interface RepoConfigOctokit {
	rest: {
		repos: {
			get(args: {
				owner: string;
				repo: string;
			}): Promise<{ data: { default_branch: string } }>;
			getBranch(args: {
				owner: string;
				repo: string;
				branch: string;
			}): Promise<{ data: { commit: { sha: string } } }>;
			getContent(args: {
				owner: string;
				repo: string;
				path: string;
				ref: string;
			}): Promise<{ data: unknown }>;
		};
	};
}

type RepoConfigKv = Pick<KvClient, "get" | "set">;

const NOTE_LIMIT = 200;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

const note = (text: string): RepoConfigResult => ({
	note: text.slice(0, NOTE_LIMIT),
});

function cleanNote(text: string): string {
	return text.replace(/[^\w .,()/-]/g, "?").slice(0, NOTE_LIMIT);
}

function safeToken(value: unknown): string {
	return String(value)
		.replace(/[^\w-]/g, (c) => (c === "." ? "_" : "?"))
		.slice(0, 120);
}

function fieldPath(path: ReadonlyArray<PropertyKey>): string {
	const joined = path.map(safeToken).join("/") || "(root)";
	return joined.slice(0, 120);
}

function decode(content: string): string | null {
	if (!/^[A-Za-z0-9+/=\s]*$/.test(content)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.from(content, "base64"),
		);
	} catch {
		return null;
	}
}

function interpret(data: unknown): RepoConfigResult {
	if (
		typeof data !== "object" ||
		data === null ||
		Array.isArray(data) ||
		(data as { type?: unknown }).type !== "file" ||
		typeof (data as { content?: unknown }).content !== "string"
	) {
		return note(`${REPO_CONFIG_PATH} is not a regular file`);
	}
	const { content, size } = data as { content: string; size?: unknown };
	if (typeof size === "number" && size > MAX_BYTES) {
		return note(`${REPO_CONFIG_PATH} is larger than ${MAX_BYTES} bytes`);
	}
	const text = decode(content);
	if (text === null) return note(`${REPO_CONFIG_PATH} is not valid UTF-8`);
	if (Buffer.byteLength(text) > MAX_BYTES) {
		return note(`${REPO_CONFIG_PATH} is larger than ${MAX_BYTES} bytes`);
	}
	let raw: unknown;
	try {
		raw = parse(text, { maxAliasCount: MAX_ALIAS_COUNT, customTags: [] });
	} catch {
		return note(`${REPO_CONFIG_PATH} is not valid YAML`);
	}
	const parsed = RepoConfigSchema.safeParse(raw);
	if (parsed.success) return { config: parsed.data };
	const issue = parsed.error.issues[0];
	if (issue?.code === "unrecognized_keys") {
		const key = (issue as { keys?: unknown[] }).keys?.[0];
		return note(
			`${REPO_CONFIG_PATH} is invalid at ${fieldPath(issue.path)} (unrecognized_keys: ${safeToken(key)})`,
		);
	}
	return note(
		`${REPO_CONFIG_PATH} is invalid at ${fieldPath(issue?.path ?? [])} (${issue?.code ?? "invalid"})`,
	);
}

async function readThrough(
	kv: RepoConfigKv | null,
	key: string | null,
	where: { owner: string; repo: string },
): Promise<RepoConfigResult | null> {
	if (!kv || !key) return null;
	try {
		const hit = await kv.get(key);
		if (!hit) return null;
		const value: unknown = JSON.parse(hit);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return null;
		}
		const { config, note: cachedNote } = value as {
			config?: unknown;
			note?: unknown;
		};
		if (config !== undefined) {
			const parsed = RepoConfigSchema.safeParse(config);
			return parsed.success ? { config: parsed.data } : null;
		}
		if (typeof cachedNote === "string") return { note: cleanNote(cachedNote) };
		return Object.keys(value).length === 0 ? {} : null;
	} catch {
		console.warn("repo config cache read failed", where);
		return null;
	}
}

async function writeThrough(
	kv: RepoConfigKv | null,
	key: string | null,
	result: RepoConfigResult,
	where: { owner: string; repo: string },
): Promise<void> {
	if (!kv || !key) return;
	try {
		await kv.set(key, JSON.stringify(result), CACHE_TTL_SECONDS);
	} catch {
		console.warn("repo config cache write failed", where);
	}
}

export async function fetchRepoConfig(args: {
	octokit: RepoConfigOctokit;
	owner: string;
	repo: string;
	kv: RepoConfigKv | null;
}): Promise<RepoConfigResult> {
	const { octokit, owner, repo, kv } = args;
	try {
		const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
		const branch = repoData.default_branch;
		const { data: branchData } = await octokit.rest.repos.getBranch({
			owner,
			repo,
			branch,
		});
		const sha = branchData.commit.sha;
		const validSha = SHA_PATTERN.test(sha);
		const key = validSha ? `repo-config:${owner}/${repo}@${sha}` : null;
		const cached = await readThrough(kv, key, { owner, repo });
		if (cached) return cached;

		let result: RepoConfigResult;
		try {
			const { data } = await octokit.rest.repos.getContent({
				owner,
				repo,
				path: REPO_CONFIG_PATH,
				ref: validSha ? sha : branch,
			});
			result = interpret(data);
		} catch (err) {
			if ((err as { status?: number }).status !== 404) throw err;
			result = {};
		}
		await writeThrough(kv, key, result, { owner, repo });
		return result;
	} catch (err) {
		const status = (err as { status?: unknown } | null)?.status;
		console.warn("repo config fetch failed", {
			owner,
			repo,
			status: typeof status === "number" ? status : undefined,
		});
		return { note: GENERIC_NOTE };
	}
}
