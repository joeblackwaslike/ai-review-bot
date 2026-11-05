export type Provider = "anthropic" | "openai";
export type Label = "fixed" | "rejected" | "deferred" | "unadjudicated";

export interface PostedClaim {
	id: string;
	roundIndex: number;
	reviewId: number;
	source: "inline" | "body";
	commentId: number | null;
	path: string | null;
	line: number | null;
	severity: string;
	title: string;
	text: string;
}

export interface CommitMeta {
	sha: string;
	committedAt: string;
	files: { path: string; ranges: [number, number][] }[];
}

/** One finding a review skill produced, before or after the posting filters. */
export interface CandidateRecord {
	/** Skill file name with the .md suffix, as the hosted corpus uses. */
	skill: string | null;
	title: string;
	path: string | null;
	line: number | null;
	severity: string | null;
}

/**
 * Token usage per skill file name, with the .md suffix, as the hosted corpus uses.
 * `promptTokens` is the provider's total input including cache reads, uncached input is
 * `promptTokens - cachedInputTokens`, and cache writes are not recorded.
 */
export type RoundUsage = Record<
	string,
	{
		promptTokens: number;
		completionTokens: number;
		cachedInputTokens?: number;
		reasoningTokens?: number;
	}
>;

/** What a live round produced: all candidates, the post-filter posted set, and usage. */
export interface RoundTrace {
	candidates: CandidateRecord[];
	posted: CandidateRecord[];
	usage: RoundUsage;
}

export interface Round {
	index: number;
	reviewId: number;
	provider: Provider;
	submittedAt: string;
	headSha: string;
	baseSha: string;
	mergeBase: string | null;
	triggerAt: string | null;
	approximate: boolean;
	commitsSince: CommitMeta[];
	claims: PostedClaim[];
	trace?: RoundTrace;
}

export interface Reply {
	id: number;
	author: string;
	createdAt: string;
	editedAt: string | null;
	body: string;
}

export interface ThreadEvidence {
	threadId: string;
	commentId: number;
	isResolved: boolean;
	isOutdated: boolean;
	resolvedBy: string | null;
	replies: Reply[];
}

export interface ReactionEvidence {
	commentId: number;
	user: string;
	content: string;
	createdAt: string;
}

export interface ReplayFixture {
	schemaVersion: 1;
	owner: string;
	repo: string;
	pull: number;
	provider: Provider;
	author: string;
	recordedAt: string;
	rounds: Round[];
	threads: ThreadEvidence[];
	reactions: ReactionEvidence[];
	expect?: { clean: true };
	heldOut?: true;
}

export interface ClaimLabel {
	claimId: string;
	label: Label;
	confidence: "high" | "low";
	/** Each entry is `<ISO timestamp>|<text>`, or `unknown|<text>` when the source has no timestamp. */
	evidence: string[];
	confirmed: boolean;
}

export interface RepeatPair {
	later: string;
	earlier: string;
	confirmed: boolean;
}

export interface NegativePair {
	a: string;
	b: string;
}

export interface LabelFile {
	fixtureId: string;
	provisional: boolean;
	labels: ClaimLabel[];
	repeatPairs: RepeatPair[];
	negativePairs: NegativePair[];
	allowedSuppression: string[];
}
