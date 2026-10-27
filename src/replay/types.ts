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
