import type { ReplayFixture } from "./types.js";

const MERGE_SEPARATOR = "\n\n---\n\n";
/** `P1` in current reviews; `High`/`Medium`/`Low` in older ones. */
const SEVERITY_BADGE_TEXT = /^(P\d|Critical|High|Medium|Low)$/;
const BADGE_LINE = /^\S*\s*\*\*(P\d|Critical|High|Medium|Low)\*\*\s*$/;
const MAX_FALLBACK_TITLE = 100;
const ABBREVIATION_END = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf)\.$/i;

function firstSentence(line: string): string {
	const re = /[.!?](?=\s|$)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line))) {
		const prefix = line.slice(0, m.index + 1);
		if (!ABBREVIATION_END.test(prefix)) return prefix;
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

/** One claim per finding in a posted comment body, split on the merge
 * separator. Also used by the ledger rebuild, not only by replay. */
export function splitInlineClaims(
	body: string,
): { title: string; text: string }[] {
	return body
		.split(MERGE_SEPARATOR)
		.map((text) => text.trim())
		.filter(Boolean)
		.map((text) => ({ title: claimTitle(text), text }));
}

export function fixtureId(
	f: Pick<ReplayFixture, "owner" | "repo" | "pull" | "provider">,
): string {
	return `${f.owner}__${f.repo}__${f.pull}__${f.provider}`;
}
