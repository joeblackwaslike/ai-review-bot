import type { LedgerEntry } from "../ledger/types.js";
import type { KvClient } from "./kv.js";
import { listActiveComments } from "./store.js";
import type { PostedCommentRecord, Verdict } from "./types.js";

function joinKey(path: string, line: number, title: string): string {
	return `${path}|${line}|${title.toLowerCase().trim()}`;
}

/**
 * Builds a lookup from ledger entry to the reaction verdicts recorded for the
 * posted comment at the same path, line and normalized title. Unmatched
 * entries, and entries without a path or line, have no reactions.
 */
export function reactionsFor(
	records: readonly PostedCommentRecord[],
): (e: LedgerEntry) => Verdict[] {
	const byKey = new Map<string, Verdict[]>();
	for (const r of records) {
		const key = joinKey(r.path, r.line, r.title);
		byKey.set(key, [
			...(byKey.get(key) ?? []),
			...Object.values(r.lastSeenReactions),
		]);
	}
	return (e) =>
		e.path === null || e.line === null
			? []
			: (byKey.get(joinKey(e.path, e.line, e.title)) ?? []);
}

const REACTIONS_TIMEOUT_MS = 3_000;

/**
 * Reads this provider's tracked comments on this PR from KV and returns the reaction lookup.
 * Any failure (KV unset, throws, or slower than the timeout) logs one warning
 * and yields a lookup with no reactions, so a review never depends on KV.
 */
export async function loadReactionsFor(
	getKv: (() => KvClient | null) | undefined,
	pr: {
		owner: string;
		repo: string;
		pullNumber: number;
		reviewer: PostedCommentRecord["reviewer"];
	},
): Promise<(e: LedgerEntry) => Verdict[]> {
	try {
		const kv = getKv?.();
		if (!kv) return reactionsFor([]);
		let timer: NodeJS.Timeout | undefined;
		let stopped = false;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				stopped = true;
				reject(new Error("reaction lookup timed out"));
			}, REACTIONS_TIMEOUT_MS);
		});
		try {
			const all = await Promise.race([
				listActiveComments(kv, Date.now(), () => stopped),
				timeout,
			]);
			return reactionsFor(
				all.filter(
					(r) =>
						r.reviewer === pr.reviewer &&
						r.owner === pr.owner &&
						r.repo === pr.repo &&
						r.pr === pr.pullNumber,
				),
			);
		} finally {
			stopped = true;
			clearTimeout(timer);
		}
	} catch (err) {
		console.warn("reaction lookup failed; scoring on ledger statuses", err);
		return reactionsFor([]);
	}
}
