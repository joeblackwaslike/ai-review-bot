import { isSameClaim } from "../claim-dedupe.js";
import type { Ledger, LedgerEntry } from "../ledger/types.js";
import { type AuthorResponse, classifyFinding } from "../trajectory.js";
import type { CatalogFinding } from "./catalog-finding.js";

export type { CatalogFinding } from "./catalog-finding.js";

/** What happened to the findings one skill raised. `accepted` is the ledger's "fixed or resolved by the author". */
export interface SkillOutcomeRow {
	skill: string;
	posted: number;
	accepted: number;
	rejected: number;
	deferred: number;
	unanswered: number;
	/** Posted findings with no ledger entry to read an outcome from. Counted in `posted` only. */
	unmatched: number;
	/** Findings that restate an earlier finding by the same reviewer on the same PR. */
	restated: number;
}

/** Key of the ledger a finding's outcome is read from: one per PR and reviewer. */
export function ledgerKey(
	f: Pick<CatalogFinding, "owner" | "repo" | "pr" | "reviewer">,
): string {
	return `${f.owner}/${f.repo}#${f.pr}:${f.reviewer}`;
}

/** Review headings a reviewer may post under, most likely first. Production sets the prefix by env var, so it can differ from the YAML (the hosted Claude bot posts "### ai-review"). */
export function prefixCandidates(
	reviewer: string,
	configured: string | undefined,
): string[] {
	return [
		...new Set([
			...(configured ? [configured] : []),
			`${reviewer}-review-bot`,
			"ai-review",
		]),
	];
}

/** The ledger entry for a finding's claim. A comment that carries several claims, in the corpus or in the ledger, is matched by title only: taking its sole remaining entry would hand one claim another's outcome. */
function entryFor(
	f: CatalogFinding,
	ledger: Ledger,
	findingsOnComment: number,
): LedgerEntry | undefined {
	if (f.commentId === null) return undefined;
	const marker = `:c${f.commentId}:`;
	const candidates = ledger.filter((e) => e.id.includes(marker));
	if (candidates.length === 1 && findingsOnComment === 1) return candidates[0];
	const title = f.title.trim().toLowerCase();
	const exact = candidates.filter(
		(e) => e.title.trim().toLowerCase() === title,
	);
	return exact.length === 1 ? exact[0] : undefined;
}

function restatesEarlier(f: CatalogFinding, all: CatalogFinding[]): boolean {
	const claim = { title: f.title, path: f.path, line: f.line };
	return all.some(
		(g) =>
			g.id !== f.id &&
			ledgerKey(g) === ledgerKey(f) &&
			(g.postedAt < f.postedAt || (g.postedAt === f.postedAt && g.id < f.id)) &&
			isSameClaim(claim, { title: g.title, path: g.path, line: g.line }),
	);
}

const emptyRow = (skill: string): SkillOutcomeRow => ({
	skill,
	posted: 0,
	accepted: 0,
	rejected: 0,
	deferred: 0,
	unanswered: 0,
	unmatched: 0,
	restated: 0,
});

const OUTCOME_FIELD: Record<
	AuthorResponse,
	"accepted" | "rejected" | "deferred" | "unanswered"
> = {
	accepted: "accepted",
	rejected: "rejected",
	deferred: "deferred",
	unanswered: "unanswered",
};

/** True for a finding that counts in a report: attributed to a skill and posted in the window. */
export function inReportingWindow(f: CatalogFinding, since?: Date): boolean {
	return f.skills.length > 0 && (!since || new Date(f.postedAt) >= since);
}

/**
 * Per-skill counts of posted findings by author outcome, read from the live
 * ledger the way adaptive limits read it (`classifyFinding`). A finding that
 * several skills raised counts under each of them. Most posted skill first.
 *
 * `findings` is every live corpus row, not only the reported ones: rows before
 * `since` and rows without a skill are never counted, but they are the history
 * a restatement is checked against and the siblings a merged comment is
 * matched among.
 */
export function summarizeSkillOutcomes(
	findings: CatalogFinding[],
	ledgerFor: (f: CatalogFinding) => Ledger | undefined,
	options: { since?: Date } = {},
): SkillOutcomeRow[] {
	const rows = new Map<string, SkillOutcomeRow>();
	const perComment = new Map<number, number>();
	for (const f of findings)
		if (f.commentId !== null)
			perComment.set(f.commentId, (perComment.get(f.commentId) ?? 0) + 1);
	for (const f of findings) {
		if (!inReportingWindow(f, options.since)) continue;
		const e = entryFor(
			f,
			ledgerFor(f) ?? [],
			f.commentId === null ? 0 : (perComment.get(f.commentId) ?? 0),
		);
		const outcome = e ? classifyFinding(e, e.reactions ?? []) : undefined;
		const restated = restatesEarlier(f, findings);
		for (const skill of f.skills) {
			const row = rows.get(skill) ?? emptyRow(skill);
			row.posted += 1;
			if (outcome) row[OUTCOME_FIELD[outcome]] += 1;
			else row.unmatched += 1;
			if (restated) row.restated += 1;
			rows.set(skill, row);
		}
	}
	return [...rows.values()].sort(
		(a, b) => b.posted - a.posted || a.skill.localeCompare(b.skill),
	);
}

/** A `YYYY-MM-DD` date as midnight UTC, or null when the text is not a real calendar date (`2026-02-30` is not, though `new Date` would roll it into March). */
export function parseSinceDate(input: string): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
	const date = new Date(`${input}T00:00:00Z`);
	return Number.isNaN(date.getTime()) ||
		date.toISOString().slice(0, 10) !== input
		? null
		: date;
}

/**
 * One ledger per PR and reviewer, loaded through `fetchLedger` for the
 * reviewed findings. Tries each candidate heading prefix until a ledger has
 * entries; a ledger empty under every prefix is kept as empty, and a fetch that
 * throws marks the key failed even when an earlier prefix returned empty.
 */
export async function loadLedgers(
	findings: CatalogFinding[],
	fetchLedger: (f: CatalogFinding, prefix: string) => Promise<Ledger>,
	configuredPrefix: (reviewer: string) => string | undefined,
): Promise<{ ledgers: Map<string, Ledger>; failed: Map<string, string> }> {
	const ledgers = new Map<string, Ledger>();
	const failed = new Map<string, string>();
	for (const f of findings) {
		const key = ledgerKey(f);
		if (ledgers.has(key) || failed.has(key)) continue;
		let loaded: Ledger | undefined;
		for (const prefix of prefixCandidates(
			f.reviewer,
			configuredPrefix(f.reviewer),
		)) {
			try {
				loaded = await fetchLedger(f, prefix);
			} catch (err) {
				loaded = undefined;
				failed.set(key, err instanceof Error ? err.message : String(err));
				break;
			}
			if (loaded.length > 0) break;
		}
		if (loaded) ledgers.set(key, loaded);
	}
	return { ledgers, failed };
}

/** Markdown table; the last column is rejected over answered (fixed, rejected, deferred). */
export function formatSkillOutcomes(rows: SkillOutcomeRow[]): string {
	const lines = [
		"| Skill | Posted | Fixed | Rejected | Deferred | Unanswered | Restated | Unmatched | Rejected share |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const r of rows) {
		const answered = r.accepted + r.rejected + r.deferred;
		const share =
			answered === 0 ? "-" : `${Math.round((r.rejected / answered) * 100)}%`;
		lines.push(
			`| ${r.skill} | ${r.posted} | ${r.accepted} | ${r.rejected} | ${r.deferred} | ${r.unanswered} | ${r.restated} | ${r.unmatched} | ${share} |`,
		);
	}
	return lines.join("\n");
}
