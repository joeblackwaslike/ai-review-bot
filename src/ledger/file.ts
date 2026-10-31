import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Ledger, LedgerStatus } from "./types.js";

const STATUSES: readonly LedgerStatus[] = [
	"open",
	"fixed",
	"rejected",
	"deferred",
	"resolved",
];

export function ledgerFilePath(
	root: string,
	owner: string,
	repo: string,
	pull: number,
): string {
	return join(root, ".ai-review", "ledger", `${owner}__${repo}__${pull}.json`);
}

export const isEntry = (v: unknown): boolean => {
	if (typeof v !== "object" || v === null) return false;
	const e = v as Record<string, unknown>;
	return (
		typeof e.id === "string" &&
		typeof e.round === "number" &&
		typeof e.severity === "string" &&
		typeof e.title === "string" &&
		STATUSES.includes(e.status as LedgerStatus)
	);
};

export async function loadLedgerFile(path: string): Promise<Ledger> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Malformed ledger file ${path}: ${(err as Error).message}`);
	}
	if (!Array.isArray(parsed) || !parsed.every(isEntry)) {
		throw new Error(
			`Invalid ledger file ${path}: expected an array of ledger entries`,
		);
	}
	return parsed as Ledger;
}

export async function saveLedgerFile(
	path: string,
	ledger: Ledger,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
	await rename(tmp, path);
}
