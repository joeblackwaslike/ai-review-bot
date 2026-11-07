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

const note = (text: string): RepoConfigResult => ({ note: text.slice(0, 200) });

function fieldPath(path: ReadonlyArray<PropertyKey>): string {
	const joined = path.map(String).join(".") || "(root)";
	return joined.replace(/[^\w.-]/g, "?").slice(0, 120);
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
	return note(
		`${REPO_CONFIG_PATH} is invalid at ${fieldPath(issue?.path ?? [])} (${issue?.code ?? "invalid"})`,
	);
}

async function readThrough(
	kv: RepoConfigKv | null,
	key: string | null,
): Promise<RepoConfigResult | null> {
	if (!kv || !key) return null;
	try {
		const hit = await kv.get(key);
		return hit ? (JSON.parse(hit) as RepoConfigResult) : null;
	} catch {
		return null;
	}
}

async function writeThrough(
	kv: RepoConfigKv | null,
	key: string | null,
	result: RepoConfigResult,
): Promise<void> {
	if (!kv || !key) return;
	try {
		await kv.set(key, JSON.stringify(result), CACHE_TTL_SECONDS);
	} catch {
		// cache is best-effort
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
		const key = /^[0-9a-f]{7,40}$/.test(sha)
			? `repo-config:${owner}/${repo}@${sha}`
			: null;
		const cached = await readThrough(kv, key);
		if (cached) return cached;

		let result: RepoConfigResult;
		try {
			const { data } = await octokit.rest.repos.getContent({
				owner,
				repo,
				path: REPO_CONFIG_PATH,
				ref: branch,
			});
			result = interpret(data);
		} catch (err) {
			if ((err as { status?: number }).status !== 404) throw err;
			result = {};
		}
		await writeThrough(kv, key, result);
		return result;
	} catch {
		return { note: GENERIC_NOTE };
	}
}
