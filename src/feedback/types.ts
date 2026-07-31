export type Provider = "anthropic" | "openai";
/** `confused` (😕) means the finding did not land — it is not a synonym for `down`. It always
 * arrives with a reply on the same thread explaining why, and that reply is what carries the
 * intent; a `confused` verdict read without its reply is not interpretable. */
export type Verdict = "up" | "down" | "confused";

/** A posted inline comment we are tracking for reactions. */
/** Which GitHub comment surface this record refers to. Reactions live at a
 * different route for each, and PR *reviews* are not reactable at all — which
 * is why the review-level verdict needs a carrier issue comment. */
export type CommentSurface = "inline" | "carrier";

export interface PostedCommentRecord {
	commentId: number;
	/** Absent on records written before carriers existed; treated as "inline",
	 * which is what they were. */
	surface?: CommentSurface;
	provider: Provider;
	installationId: number;
	owner: string;
	repo: string;
	pr: number;
	headSha: string;
	path: string;
	line: number;
	/** Skills (skill file names) that raised a finding at this path:line. */
	skills: string[];
	/** Title of the displayed inline comment. */
	title: string;
	/** `body`/`headSha`/`postedAtMs` are captured for the future refinement system's context;
	 * they are stored but not read within this feature. */
	body: string;
	postedAtMs: number;
	expiresAtMs: number;
	/** Latest verdict we have already recorded per reactor login — for idempotent diffs. */
	lastSeenReactions: Record<string, Verdict>;
}

/** An append-only verdict observation, denormalized so the events log is self-contained. */
export interface FeedbackEvent {
	commentId: number;
	/** Which surface the reaction was left on; absent means inline. */
	surface?: CommentSurface;
	provider: Provider;
	owner: string;
	repo: string;
	pr: number;
	path: string;
	line: number;
	skills: string[];
	title: string;
	verdict: Verdict;
	reactor: string;
	reactedAtMs: number;
	capturedAtMs: number;
}
