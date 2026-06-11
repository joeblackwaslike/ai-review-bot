export type Provider = "anthropic" | "openai";
export type Verdict = "up" | "down";

/** A posted inline comment we are tracking for reactions. */
export interface PostedCommentRecord {
	commentId: number;
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
	body: string;
	postedAtMs: number;
	expiresAtMs: number;
	/** Latest verdict we have already recorded per reactor login — for idempotent diffs. */
	lastSeenReactions: Record<string, Verdict>;
}

/** An append-only verdict observation, denormalized so the events log is self-contained. */
export interface FeedbackEvent {
	commentId: number;
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
