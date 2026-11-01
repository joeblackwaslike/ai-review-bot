import { createHash } from "node:crypto";
import { ledgerEntryFinding } from "./baseline.js";
import type { LedgerEntry } from "./ledger/types.js";

export const RELATION_KINDS = ["repeats", "caused_by"] as const;

export interface FindingRelation {
	kind: (typeof RELATION_KINDS)[number];
	entry_id: string;
}

/** The short id a prior finding is listed under in the prompt, derived from its `findingId`. */
export function shortFindingId(id: string): string {
	return createHash("sha1").update(id).digest("hex").slice(0, 6);
}

/** Keeps a model-declared relation only when its entry id was one of the ids shown in the prompt. */
export function parseRelation(
	raw: { kind: string; entry_id: string } | null | undefined,
	shownIds: ReadonlySet<string>,
): FindingRelation | undefined {
	if (!raw) return undefined;
	const id = raw.entry_id.replace(/^#/, "").trim();
	const kind = RELATION_KINDS.find((k) => k === raw.kind);
	return kind && shownIds.has(id) ? { kind, entry_id: id } : undefined;
}

/** The ledger entry behind a shown short id: the latest round, an inline comment over a body row. */
export function entryForShortId(
	ledger: readonly LedgerEntry[],
	shortId: string,
): LedgerEntry | undefined {
	const isBody = (e: LedgerEntry) => e.id.includes(":body:");
	let best: LedgerEntry | undefined;
	for (const e of ledger) {
		if (shortFindingId(ledgerEntryFinding(e).id) !== shortId) continue;
		const better =
			!best ||
			(isBody(best) && !isBody(e)) ||
			(isBody(best) === isBody(e) && e.round > best.round);
		if (better) best = e;
	}
	return best;
}

/** The line a `caused_by` comment opens with: a link to the earlier thread when the entry came from an inline comment, else its title. */
export function causedByLine(
	entry: LedgerEntry,
	pr: { owner: string; repo: string; pullNumber: number },
): string {
	const commentId = entry.id.match(/^r\d+:c(\d+):/)?.[1];
	return commentId
		? `Caused by an earlier finding: https://github.com/${pr.owner}/${pr.repo}/pull/${pr.pullNumber}#discussion_r${commentId}`
		: `Caused by an earlier finding: "${entry.title}"`;
}

interface Related {
	relation?: { kind: string; entry_id: string } | null;
	causedBy?: string;
}

/** Validates each finding's declared relation against the shown ids and, for `caused_by`, attaches the link line. */
export function resolveRelations<T extends Related>(
	findings: readonly T[],
	shownIds: ReadonlySet<string>,
	ledger: readonly LedgerEntry[],
	pr: { owner: string; repo: string; pullNumber: number },
): T[] {
	return findings.map((f) => {
		const relation = parseRelation(f.relation, shownIds);
		const entry =
			relation?.kind === "caused_by"
				? entryForShortId(ledger, relation.entry_id)
				: undefined;
		const { causedBy: _drop, ...rest } = f;
		return {
			...rest,
			relation: relation ?? null,
			...(entry ? { causedBy: causedByLine(entry, pr) } : {}),
		} as T;
	});
}

/** Finds the entry a `repeats` finding declared, among the entries suppression may match. */
export function declaredRepeat(
	ledger: readonly LedgerEntry[],
): (f: Related) => LedgerEntry | undefined {
	return (f) =>
		f.relation?.kind === "repeats"
			? entryForShortId(ledger, f.relation.entry_id)
			: undefined;
}
