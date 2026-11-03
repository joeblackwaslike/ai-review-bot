import type { ReplayFixture } from "./types.js";

const MERGE_SEPARATOR = "\n\n---\n\n";
/** `P1` in current reviews; `High`/`Medium`/`Low` in older ones. */
const SEVERITY_BADGE_TEXT = /^(P\d|Critical|High|Medium|Low)$/;
const BADGE_LINE = /^\S*\s*\*\*(P[0-3]|Critical|High|Medium|Low)\*\*\s*$/;
const MAX_FALLBACK_TITLE = 100;
const ABBREVIATION_END = /(?<![a-z])(?:e\.g|i\.e|etc|vs|cf)\.$/i;

function firstSentence(line: string): string {
	const re = /[.!?]["'”’)\]]*(?=\s|$)/g;
	for (const m of line.matchAll(re)) {
		if (ABBREVIATION_END.test(line.slice(0, m.index + 1))) continue;
		return line.slice(0, m.index + m[0].length);
	}
	return line;
}

/** The finding's bold title, skipping the severity badge. Without one: the
 * first line, or for a badged finding with no title the first sentence of
 * its body, cut to 100 characters. Also used by the ledger rebuild and the
 * posted-comment key, not only by replay. */
export function claimTitle(part: string): string {
	for (const m of part.matchAll(/\*\*(.+?)\*\*/g)) {
		const span = m[1].trim();
		if (span && !SEVERITY_BADGE_TEXT.test(span)) return span;
	}
	const lines = part
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (!lines.some((l) => BADGE_LINE.test(l))) return lines[0] ?? "";
	const line = lines.find((l) => !BADGE_LINE.test(l)) ?? "";
	const sentence = firstSentence(line);
	return sentence.length > MAX_FALLBACK_TITLE
		? `${sentence.slice(0, MAX_FALLBACK_TITLE - 1).trimEnd()}…`
		: sentence;
}

const WORD_SEVERITY: Record<string, string> = {
	Critical: "P0",
	High: "P1",
	Medium: "P2",
	Low: "P3",
};

/** The finding's severity on the P0-P3 scale. A leading badge decides: a
 * `P1` badge as written, an older word badge mapped (Critical P0, High P1,
 * Medium P2, Low P3). Without a badge, the first P0-P3 in the text, else P3.
 * Also used by the ledger rebuild, so old-format findings rebuild as P1/P2
 * entries, not only by replay. An inline `🔴 **High**` maps to P1 here, while
 * `parseBodyFindings` (`src/review-state.ts`) maps a 🔴 body row to P0 on
 * purpose; the verdict is the same either way. */
export function claimSeverity(part: string): string {
	const first = part
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);
	const badge = first?.match(BADGE_LINE)?.[1];
	if (badge) return WORD_SEVERITY[badge] ?? badge;
	return part.match(/\bP[0-3]\b/)?.[0] ?? "P3";
}

/** One claim per finding in a posted comment body, split on the merge
 * separator. Also used by the ledger rebuild, not only by replay. */
export function splitInlineClaims(
	body: string,
): { title: string; text: string; severity: string }[] {
	return body
		.split(MERGE_SEPARATOR)
		.map((text) => text.trim())
		.filter(Boolean)
		.map((text) => ({
			title: claimTitle(text),
			text,
			severity: claimSeverity(text),
		}));
}

export function fixtureId(
	f: Pick<ReplayFixture, "owner" | "repo" | "pull" | "provider">,
): string {
	return `${f.owner}__${f.repo}__${f.pull}__${f.provider}`;
}
