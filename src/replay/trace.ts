import { commentKey } from "../comment-key.js";
import { suppressInReview } from "../ledger/suppress.js";
import type { Ledger } from "../ledger/types.js";
import { declaredRepeat } from "../relation.js";
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
import { holdable, ledgerFromView } from "./pipeline.js";
import { roundCutoff, visibleLabels } from "./replay.js";
import type {
	CandidateRecord,
	LabelFile,
	ReplayFixture,
	Round,
} from "./types.js";

type Item = ModelFinding | ModelInlineComment;

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

/**
 * What the posting path would post from these agent reviews, built from the
 * same functions in the same order: per agent `suppressInReview` and, when
 * `tuning.dropRetractions`, `dropRetractions`; then `mergeReviewsDetailed`,
 * `sanitizeInlineComments`, `capInlineComments`, `buildReviewComments` and
 * `routeDroppedComments`. `posted` holds the inline comments that anchor and
 * the general findings, including P0/P1 comments promoted off the diff;
 * `dropped` holds every finding a step removed. Skill names carry `.md`.
 */
export function postFilterTrace(input: {
	agentReviews: { skill: string; review: ModelReview }[];
	ledger: Ledger;
	files: PullFile[];
	tuning: ReviewerTuning;
}): { posted: CandidateRecord[]; dropped: CandidateRecord[] } {
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
		const own = <T extends Item>(f: T): T => {
			const copy = { ...f };
			skillOf.set(copy, `${skill}.md`);
			return copy;
		};
		const outcome = suppressInReview(
			{
				...review,
				general_findings: review.general_findings.map(own),
				inline_comments: review.inline_comments.map(own),
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

	const merged = mergeReviewsDetailed(filtered, new Set(), {
		dedupeNearDuplicateClaims: tuning.dedupeNearDuplicateClaims,
	}).review;
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

	const { kept, overflow } = capInlineComments(sanitized);
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
			...merged.general_findings.map((f) => toRecord(f)),
			...routed,
		],
		dropped,
	};
}
