import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PROVIDERS, type Provider } from "../auth.js";
import { isEntry } from "../ledger/file.js";
import type { Ledger } from "../ledger/types.js";
import type { GitRunner } from "../sources.js";

const MAX_READABLE = 60;

export type GateStore = {
	version: 1;
	providers: Provider[];
	lastHead: string | null;
	entries: Ledger;
};

export function emptyStore(): GateStore {
	return { version: 1, providers: [], lastHead: null, entries: [] };
}

function keyFor(owner: string, repo: string, identity: string): string {
	const readable = encodeURIComponent(identity.slice(2))
		.toLowerCase()
		.slice(0, MAX_READABLE);
	const suffix = createHash("sha1").update(identity).digest("hex").slice(0, 10);
	const repoHash = createHash("sha256")
		.update(`${owner}/${repo}`)
		.digest("hex")
		.slice(0, 16);
	return `${repoHash}__${readable}__${suffix}`;
}

const mtimeOf = (path: string) => {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
};

/**
 * The store key for HEAD. An existing store for a branch pointing at HEAD wins,
 * the most recently modified one when several exist, so a second branch at HEAD
 * (a backup, a stacked branch) does not orphan the history. The merge-base key
 * is never adopted that way, because every branch forked from the same base
 * shares it. With no branch store on disk: the branch key when exactly one
 * branch points at HEAD, else the merge-base key.
 */
export function storeKey(
	runGit: GitRunner,
	owner: string,
	repo: string,
	mergeBase: string,
	dir?: string,
): string {
	const branches = runGit([
		"for-each-ref",
		"--points-at",
		"HEAD",
		"--format=%(refname:lstrip=2)",
		"refs/heads/",
	])
		.split("\n")
		.map((b) => b.trim())
		.filter(Boolean);
	const baseKey = keyFor(owner, repo, `s:${mergeBase}`);
	const branchKeys = branches.map((b) => keyFor(owner, repo, `b:${b}`));
	const existing = branchKeys
		.map((key) => ({ key, mtime: mtimeOf(gateStorePath(key, dir)) }))
		.filter((c): c is { key: string; mtime: number } => c.mtime !== null)
		.sort((a, b) => b.mtime - a.mtime);
	if (existing[0]) return existing[0].key;
	return branches.length === 1 ? (branchKeys[0] ?? baseKey) : baseKey;
}

export function gateStorePath(key: string, dir?: string): string {
	const base =
		dir ??
		process.env.AI_REVIEW_GATE_DIR ??
		join(homedir(), ".ai-review", "gate");
	return join(base, `${key}.json`);
}

const isStore = (v: unknown): v is GateStore => {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	return (
		s.version === 1 &&
		Array.isArray(s.providers) &&
		s.providers.every((p) => PROVIDERS.includes(p)) &&
		(s.lastHead === null || typeof s.lastHead === "string") &&
		Array.isArray(s.entries) &&
		s.entries.every(isEntry)
	);
};

export async function loadStore(
	path: string,
): Promise<{ store: GateStore; warning: string | null }> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { store: emptyStore(), warning: null };
		}
		parsed = undefined;
	}
	if (isStore(parsed)) return { store: parsed, warning: null };
	const aside = `${path}.corrupt-${Date.now()}-${randomBytes(3).toString("hex")}`;
	try {
		await rename(path, aside);
	} catch {
		try {
			await unlink(path);
		} catch {
			return {
				store: emptyStore(),
				warning: `Gate history at ${path} was unreadable; history was reset, and the corrupt file could not be moved aside.`,
			};
		}
		return {
			store: emptyStore(),
			warning: `Gate history at ${path} was unreadable; history was reset (corrupt file deleted, it could not be moved aside).`,
		};
	}
	return {
		store: emptyStore(),
		warning: `Gate history at ${path} was unreadable; history was reset (old file kept at ${aside}).`,
	};
}

export async function saveStore(path: string, store: GateStore): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`);
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => undefined);
		throw err;
	}
}
