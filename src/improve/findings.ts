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
const BADGE_PATTERN = /^(?:🔴|🟠|🟡|🟢|⚪)\s+\*\*([A-Za-z0-9]+)\*\*\s*\n+/;
const TITLE_PATTERN = /^\*\*(.+?)\*\*\s*\n+/s;

/** Pure: recover the structured finding from a posted inline comment body.
 * Returns null when the body does not match the bot's rendering — a comment we
 * cannot parse is skipped rather than guessed at, so the corpus never carries
 * a fabricated title. */
export function parseFindingComment(body: string): ParsedFinding | null {
	let rest = body.trimStart();

	const badge = BADGE_PATTERN.exec(rest);
	const severity = badge ? badge[1] : null;
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
 * historical backfill so both converge on one row instead of duplicating.
 *
 * A row in this table is one *posted comment*, so the comment id is the key
 * whenever there is one. It is stable in both directions that matter: GitHub
 * re-anchors a comment to a new `line` as later commits move the code around it
 * (keying on `line` forked one finding into two rows sharing a comment_id, which
 * fanned out every join), and two distinct comments in one file can carry the
 * same title (keying on title alone collapsed them, so feedback on the second
 * could not be matched).
 *
 * Recognising that the same claim recurs — across rounds, files or PRs — is a
 * trend question, not an identity one, and belongs in the trend layer where it
 * can be counted rather than silently merged away.
 *
 * Because the comment id alone determines the key, `path` and `title` are
 * ignored on that branch — a comment keeps its identity when it is re-anchored
 * or its text is edited, which is the point.
 *
 * General findings have no comment, so they fall back to path + hashed title. */
export function findingNaturalKey(parts: {
	provider: string;
	owner: string;
	repo: string;
	pr: number;
	commentId: number | null;
	path: string | null;
	title: string;
}): string {
	const prefix = `${parts.provider}:${parts.owner}/${parts.repo}#${parts.pr}`;
	if (parts.commentId !== null) return `${prefix}:comment:${parts.commentId}`;
	const titleHash = createHash("sha256")
		.update(parts.title)
		.digest("hex")
		.slice(0, 12);
	return `${prefix}:${parts.path ?? ""}:${titleHash}`;
}
