import {
	applyLimits,
	resolveLimits,
	supportCounts,
} from "../adaptive-limits.js";
import { commentKey } from "../comment-key.js";
import type { Verdict } from "../feedback/types.js";
import { blocksVerdict, suppressInReview } from "../ledger/suppress.js";
import type { Ledger, LedgerEntry } from "../ledger/types.js";
import type { PushFile } from "../moved-blocks.js";
import { declaredRepeat, resolveRelations } from "../relation.js";
import { dropRetractions } from "../retraction.js";
import {
	buildReviewComments,
	buildValidLinesByPath,
	capInlineComments,
	type ModelFinding,
	type ModelInlineComment,
	type ModelReview,
	mergeReviewsDetailed,
	type PullFile,
	postedCommentKey,
	routeDroppedComments,
	sanitizeInlineComments,
} from "../review.js";
import type { ReviewerTuning } from "../reviewer-tuning.js";
import { joinsClaim } from "./metrics.js";
import { holdable, ledgerFromView } from "./pipeline.js";
import { roundCutoff, visibleLabels } from "./replay.js";
import type {
	CandidateRecord,
	ClaimLabel,
	LabelFile,
	PostedClaim,
	ReplayFixture,
	Round,
} from "./types.js";

type Item = ModelFinding | ModelInlineComment;

/** Replay shows the agents no prior-finding ids, so every declared relation
 * resolves to none, as production resolves an id it did not show. */
const NO_SHOWN_IDS: ReadonlySet<string> = new Set();
const NO_PR = { owner: "", repo: "", pullNumber: 0 };

/** The suppression ledger a review of `round` would see: every claim of the
 * fixture's earlier rounds, settled by the labels visible before the round,
 * kept to the settled entries and the open ones the baseline carries. */
export function ledgerForRound(
	fixture: ReplayFixture,
	labels: LabelFile,
	round: Round,
): Ledger {
	return holdable(
		ledgerFromView({
			priorClaims: fixture.rounds
				.filter((r) => r.index < round.index)
				.flatMap((r) => r.claims),
			labels: visibleLabels(fixture, labels, roundCutoff(round)),
		}),
	);
}

/** The ledger a review of `round` would see when the reviewer's own earlier
 * posted findings replace the recorded claims. The author's behaviour is held
 * fixed: an own finding that joins a recorded claim inherits its label and
 * text, any other stays open. */
export function ledgerFromPosted(
	fixture: ReplayFixture,
	labels: LabelFile,
	round: Round,
	ownPosted: { roundIndex: number; posted: CandidateRecord[] }[],
): Ledger {
	const recorded = fixture.rounds.flatMap((r) => r.claims);
	const visible = visibleLabels(fixture, labels, roundCutoff(round));
	const claims = new Map<string, PostedClaim>();
	const ownLabels = new Map<string, ClaimLabel>();
	for (const { roundIndex, posted } of ownPosted) {
		if (roundIndex >= round.index) continue;
		for (const cand of posted) {
			const id = `own:r${roundIndex}:${cand.path}:${cand.line}:${cand.title}`;
			if (claims.has(id)) continue;
			const match = recorded.find((c) => joinsClaim(cand, c));
			claims.set(id, {
				id,
				roundIndex,
				reviewId: match?.reviewId ?? -1,
				source: match?.source ?? "inline",
				commentId: null,
				path: cand.path,
				line: cand.line,
				severity: cand.severity ?? match?.severity ?? "P2",
				title: cand.title,
				text: match?.text ?? cand.title,
			});
			const label = match && visible.get(match.id);
			if (label) ownLabels.set(id, { ...label, claimId: id });
		}
	}
	return holdable(
		ledgerFromView({ priorClaims: [...claims.values()], labels: ownLabels }),
	);
}

const VERDICT_BY_REACTION: ReadonlyMap<string, Verdict> = new Map([
	["+1", "up"],
	["-1", "down"],
	["confused", "confused"],
]);

/**
 * The adaptive-limits input a review of `round` would have, from the fixture's
 * earlier rounds only. `entries` is every earlier claim as a ledger entry
 * (settled by the labels visible before the round, open otherwise), not only
 * the holdable ones. `currentRound` is `round.index`, which is what
 * `ledgerFromView` stamps on entries (the claim's `roundIndex`). `reactionsFor`
 * reads the recorded reactions on the entry's claim that predate the round,
 * one verdict per reactor (the latest verdict-bearing reaction); an entry
 * without a comment id has none. `delta` is always null: fixtures carry no patch
 * text, so the push-shape factor is not modeled offline and the replay applies
 * the band budget unscaled. That under-counts removal for small pushes. Off-diff
 * drops are not modeled either, which can over-count it, so the trace is not a strict bound.
 */
export function adaptiveInputForRound(
	fixture: ReplayFixture,
	labels: LabelFile,
	round: Round,
): NonNullable<Parameters<typeof postFilterTrace>[0]["adaptive"]> {
	const earlier = fixture.rounds.filter((r) => r.index < round.index);
	const cutoff = roundCutoff(round).getTime();
	const priorClaims = earlier.flatMap((r) => r.claims);
	const entries = ledgerFromView({
		priorClaims,
		labels: visibleLabels(fixture, labels, roundCutoff(round)),
	});
	const commentOf = new Map(priorClaims.map((c) => [c.id, c.commentId]));
	const reactions = fixture.reactions.filter(
		(r) => new Date(r.createdAt).getTime() < cutoff,
	);
	const reactionsFor = (e: LedgerEntry): Verdict[] => {
		const commentId = commentOf.get(e.id);
		if (commentId === null || commentId === undefined) return [];
		const latest = new Map<string, { verdict: Verdict; at: number }>();
		for (const r of reactions) {
			const verdict = VERDICT_BY_REACTION.get(r.content);
			if (r.commentId !== commentId || !verdict) continue;
			const at = new Date(r.createdAt).getTime();
			if (at >= (latest.get(r.user)?.at ?? -Infinity))
				latest.set(r.user, { verdict, at });
		}
		return [...latest.values()].map((v) => v.verdict);
	};
	return { entries, reactionsFor, currentRound: round.index, delta: null };
}

/**
 * What the posting path would post from these agent reviews, built from the
 * same functions in the same order: per agent `resolveRelations` (against no
 * shown ids), `suppressInReview` and, when
 * `tuning.dropRetractions`, `dropRetractions`; then `mergeReviewsDetailed`,
 * `sanitizeInlineComments`, `capInlineComments`, `buildReviewComments` and
 * `routeDroppedComments`. With `adaptive` and `tuning.adaptiveLimits`,
 * `resolveLimits` and `applyLimits` run after `sanitizeInlineComments` and
 * before `capInlineComments`, as in production; what they remove lands in
 * `adaptiveRemoved` and in neither `posted` nor `dropped`, and the key is
 * absent otherwise so the plain output is unchanged. `carriedBlocks` is true
 * when `ledger` holds an open or acknowledged entry that blocks the verdict.
 * `posted` holds the inline comments that anchor and
 * the general findings, including P0/P1 comments promoted off the diff;
 * `dropped` holds every finding a step removed. Skill names carry `.md`.
 */
export function postFilterTrace(input: {
	agentReviews: { skill: string; review: ModelReview }[];
	ledger: Ledger;
	files: PullFile[];
	tuning: ReviewerTuning;
	adaptive?: {
		entries: Ledger;
		reactionsFor: (e: LedgerEntry) => Verdict[];
		currentRound: number;
		delta: PushFile[] | null;
	};
}): {
	posted: CandidateRecord[];
	dropped: CandidateRecord[];
	adaptiveRemoved?: CandidateRecord[];
} {
	const { ledger, files, tuning } = input;
	const skillOf = new Map<object, string>();
	const toRecord = (
		f: Item,
		at: { path: string | null; line: number | null } = {
			path: "path" in f ? f.path : null,
			line: "line" in f ? f.line : null,
		},
	): CandidateRecord => ({
		skill: skillOf.get(f) ?? null,
		title: f.title,
		path: at.path,
		line: at.line,
		severity: f.severity ?? null,
	});
	const dropped: CandidateRecord[] = [];
	const drop = (f: object) => dropped.push(toRecord(f as Item));

	const filtered = input.agentReviews.map(({ skill, review }) => {
		const own = <T extends Item>(findings: T[]): T[] =>
			resolveRelations(findings, NO_SHOWN_IDS, ledger, NO_PR).map((f) => {
				skillOf.set(f, `${skill}.md`);
				return f;
			});
		const outcome = suppressInReview(
			{
				...review,
				general_findings: own(review.general_findings),
				inline_comments: own(review.inline_comments),
			},
			ledger,
			declaredRepeat(ledger),
		);
		for (const s of [...outcome.suppressed, ...outcome.restatedOpen])
			drop(s.finding);
		if (!tuning.dropRetractions) return outcome.review;
		const retractions = dropRetractions(outcome.review);
		for (const f of retractions.dropped) drop(f);
		return retractions.review;
	});

	const mergeOutcome = mergeReviewsDetailed(filtered, new Set(), {
		dedupeNearDuplicateClaims: tuning.dedupeNearDuplicateClaims,
	});
	const merged = mergeOutcome.review;
	const survivors = new Set<object>([
		...merged.general_findings,
		...merged.inline_comments,
	]);
	for (const r of filtered)
		for (const f of [...r.general_findings, ...r.inline_comments])
			if (!survivors.has(f)) drop(f);

	const sanitized = sanitizeInlineComments(
		merged.inline_comments,
		buildValidLinesByPath(files),
	);
	sanitized.forEach((c, i) => {
		const skill = skillOf.get(merged.inline_comments[i] as object);
		if (skill) skillOf.set(c, skill);
	});

	let generalKept = merged.general_findings;
	let inlineCandidates = sanitized;
	let adaptiveRemoved: CandidateRecord[] | undefined;
	if (input.adaptive && tuning.adaptiveLimits) {
		const limits = resolveLimits(input.adaptive);
		const support = supportCounts({
			inlineByAgent: filtered.map((r) => r.inline_comments),
			generalByAgent: filtered.map((r) => r.general_findings),
			inlineKey: commentKey,
			aliases: mergeOutcome.inlineAliases,
		});
		const limited = applyLimits(
			{
				event: merged.event,
				general_findings: generalKept,
				inline_comments: sanitized,
			},
			limits,
			(f) => ("path" in f ? support.inline(f) : support.general(f.title)),
			ledger.some(
				(e) =>
					(e.status === "open" || e.status === "acknowledged") &&
					blocksVerdict(e),
			),
		);
		generalKept = limited.review.general_findings;
		inlineCandidates = limited.review.inline_comments;
		adaptiveRemoved = limited.removed.map((f) => toRecord(f));
	}

	const { kept, overflow } = capInlineComments(inlineCandidates);
	for (const c of overflow) drop(c);

	const reviewComments = buildReviewComments(files, kept);
	const routing = routeDroppedComments(kept, reviewComments);
	for (const c of routing.dropped) drop(c);

	const byKey = new Map(kept.map((c) => [commentKey(c), c]));
	const postedInline = reviewComments.map((rc) => {
		const source = byKey.get(postedCommentKey(rc));
		if (!source) throw new Error(`posted comment has no source: ${rc.path}`);
		return toRecord(source, { path: rc.path, line: rc.line });
	});
	const routedSources = kept.filter((c) =>
		routing.routedKeys.has(commentKey(c)),
	);
	const routed = routing.routed.map((f, i) => ({
		...toRecord(f),
		skill: skillOf.get(routedSources[i] as object) ?? null,
	}));

	return {
		posted: [
			...postedInline,
			...generalKept.map((f) => toRecord(f)),
			...routed,
		],
		dropped,
		...(adaptiveRemoved ? { adaptiveRemoved } : {}),
	};
}
