import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "../auth.js";
import { isEntry } from "../ledger/file.js";
import type { Ledger } from "../ledger/types.js";
import type { GitRunner } from "../sources.js";

export type GateStore = {
	version: 1;
	providers: Provider[];
	lastHead: string | null;
	entries: Ledger;
};

export function emptyStore(): GateStore {
	return { version: 1, providers: [], lastHead: null, entries: [] };
}

export function storeKey(
	runGit: GitRunner,
	owner: string,
	repo: string,
	mergeBase: string,
): string {
	const branches = runGit([
		"for-each-ref",
		"--points-at",
		"HEAD",
		"--format=%(refname:short)",
		"refs/heads/",
	])
		.split("\n")
		.map((b) => b.trim())
		.filter(Boolean);
	const ref = branches.length === 1 ? (branches[0] as string) : mergeBase;
	const repoHash = createHash("sha256")
		.update(`${owner}/${repo}`)
		.digest("hex")
		.slice(0, 16);
	return `${repoHash}__${encodeURIComponent(ref)}`;
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
		(s.lastHead === null || typeof s.lastHead === "string") &&
		Array.isArray(s.entries) &&
		s.entries.every(isEntry)
	);
};

export async function loadStore(
	path: string,
): Promise<{ store: GateStore; warning: string | null }> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { store: emptyStore(), warning: null };
		}
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	if (isStore(parsed)) return { store: parsed, warning: null };
	const aside = `${path}.corrupt-${Date.now()}`;
	await rename(path, aside);
	return {
		store: emptyStore(),
		warning: `Gate history at ${path} was unreadable; history was reset (old file kept at ${aside}).`,
	};
}

export async function saveStore(path: string, store: GateStore): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`);
	await rename(tmp, path);
}
