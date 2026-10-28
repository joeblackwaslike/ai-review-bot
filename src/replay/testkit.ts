import type { ReplayResult } from "./replay.js";
import type {
	ClaimLabel,
	Label,
	LabelFile,
	PostedClaim,
	ReplayFixture,
	Round,
} from "./types.js";

export const claim = (id: string, roundIndex: number): PostedClaim => ({
	id,
	roundIndex,
	reviewId: roundIndex,
	source: "inline",
	commentId: null,
	path: "a.ts",
	line: 1,
	severity: "high",
	title: id,
	text: id,
});

export const makeRound = (index: number, ids: string[]): Round => ({
	index,
	reviewId: index,
	provider: "anthropic",
	submittedAt: `2026-01-0${index + 1}T12:00:00Z`,
	headSha: "h",
	baseSha: "b",
	mergeBase: null,
	triggerAt: `2026-01-0${index + 1}T10:00:00Z`,
	approximate: false,
	commitsSince: [],
	claims: ids.map((id) => claim(id, index)),
});

export const makeFixture = (rounds: string[][]): ReplayFixture => ({
	schemaVersion: 1,
	owner: "o",
	repo: "r",
	pull: 1,
	provider: "anthropic",
	author: "me",
	recordedAt: "2026-02-01T00:00:00Z",
	rounds: rounds.map((ids, i) => makeRound(i, ids)),
	threads: [],
	reactions: [],
});

export const makeLabel = (
	claimId: string,
	label: Label,
	over: Partial<ClaimLabel> = {},
): ClaimLabel => ({
	claimId,
	label,
	confidence: "high",
	evidence: ["2026-01-01T11:00:00Z|x"],
	confirmed: true,
	...over,
});

export const makeLabels = (over: Partial<LabelFile> = {}): LabelFile => ({
	fixtureId: "fx",
	provisional: false,
	labels: [],
	repeatPairs: [],
	negativePairs: [],
	allowedSuppression: [],
	...over,
});

export const makeResult = (
	rounds: {
		posted: string[];
		suppressed?: string[];
		matchedTo?: Record<string, string>;
	}[],
): ReplayResult => ({
	fixtureId: "fx",
	rounds: rounds.map((r, index) => ({
		index,
		posted: r.posted,
		suppressed: r.suppressed ?? [],
		...(r.matchedTo ? { matchedTo: r.matchedTo } : {}),
	})),
});
