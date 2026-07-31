import { createHash } from "node:crypto";

export interface ParsedFinding {
	/** Lowercased severity from the rendered badge, or null for comments posted
	 * before badges existed (the badge shipped in #16). */
	severity: string | null;
	title: string;
	body: string;
}

// Mirrors buildCommentBody in review.ts: `{badge}\n\n**{title}**\n\n{body}`,
// where the badge is optional because comments predating #16 have none.
const BADGE_PATTERN = /^(?:🔴|🟡|🟢|⚪)\s+\*\*([A-Za-z]+)\*\*\s*\n+/;
const TITLE_PATTERN = /^\*\*(.+?)\*\*\s*\n+/s;

/** Pure: recover the structured finding from a posted inline comment body.
 * Returns null when the body does not match the bot's rendering — a comment we
 * cannot parse is skipped rather than guessed at, so the corpus never carries
 * a fabricated title. */
export function parseFindingComment(body: string): ParsedFinding | null {
	let rest = body.trimStart();

	const badge = BADGE_PATTERN.exec(rest);
	const severity = badge ? badge[1].toLowerCase() : null;
	if (badge) rest = rest.slice(badge[0].length);

	const title = TITLE_PATTERN.exec(rest);
	if (!title) return null;

	return {
		severity,
		title: title[1].trim(),
		body: rest.slice(title[0].length).trim(),
	};
}

/** Stable identity for a posted finding, shared by the live capture path and the
 * historical backfill so both converge on one row instead of duplicating. The
 * title is hashed to keep the key bounded regardless of title length.
 *
 * `line` is deliberately NOT part of the key. GitHub re-anchors a review comment
 * as later commits move the code around it, so the same comment reports a
 * different `line` on a later read — keying on it forked one finding into two
 * rows sharing a comment_id, which then fanned out every join against the
 * catalog. Path plus title identifies the claim; where it currently sits does
 * not. The row still stores `line` for display. */
export function findingNaturalKey(parts: {
	provider: string;
	owner: string;
	repo: string;
	pr: number;
	path: string | null;
	title: string;
}): string {
	const titleHash = createHash("sha256")
		.update(parts.title)
		.digest("hex")
		.slice(0, 12);
	return `${parts.provider}:${parts.owner}/${parts.repo}#${parts.pr}:${parts.path ?? ""}:${titleHash}`;
}
