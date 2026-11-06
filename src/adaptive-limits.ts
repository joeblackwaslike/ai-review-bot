import type { Verdict } from "./feedback/types.js";
import type { Ledger, LedgerEntry } from "./ledger/types.js";
import type { PushFile } from "./moved-blocks.js";
import { classifyPush, type PushShape, shapedBudget } from "./push-shape.js";
import {
	limitsForScore,
	type RoundFriction,
	SEV_RANK,
	type Sev,
	scoreTrajectory,
} from "./trajectory.js";

/** The fields a finding needs for the limits to rank it. */
export interface Limitable {
	severity: Sev;
	confidence: number;
	path?: string | null;
	line?: number | null;
}

/** The parts of a review the limits read and rewrite. */
export interface LimitableReview<G extends Limitable, I extends Limitable> {
	event: string;
	general_findings: G[];
	inline_comments: I[];
}

/** Limits for one review, with the inputs that produced them. */
export interface ResolvedLimits {
	floor: Sev | null;
	budget: number | null;
	score: number | null;
	rounds: RoundFriction[];
	shape: PushShape | null;
}

/** Computes the severity floor and findings budget from ledger history and the last push.
 * `delta` is null for a non-incremental review, which leaves the band budget unscaled. */
export function resolveLimits(input: {
	entries: Ledger;
	reactionsFor: (e: LedgerEntry) => Verdict[];
	currentRound: number;
	delta: PushFile[] | null;
}): ResolvedLimits {
	const { score, rounds } = scoreTrajectory(
		input.entries,
		input.reactionsFor,
		input.currentRound,
	);
	const { floor, budget } = limitsForScore(score);
	if (budget === null || input.delta === null) {
		return { floor, budget, score, rounds, shape: null };
	}
	const shape = classifyPush(input.delta);
	return { floor, budget: shapedBudget(shape, budget), score, rounds, shape };
}

interface Slot<T> {
	item: T;
	general: boolean;
	index: number;
}

/** Removes new findings under the severity floor and past the budget. P0 and P1 are never
 * removed. Findings rank by severity, confidence, `supportOf`, then original position.
 * A REQUEST_CHANGES review whose findings are all removed becomes COMMENT unless
 * `carriedBlocks`. Inputs are not mutated. */
export function applyLimits<
	G extends Limitable,
	I extends Limitable,
	R extends LimitableReview<G, I>,
>(
	review: R,
	limits: { floor: Sev | null; budget: number | null },
	supportOf: (f: G | I) => number,
	carriedBlocks: boolean,
): { review: R; removed: (G | I)[] } {
	const slots: Slot<G | I>[] = [
		...review.general_findings.map((item, index) => ({
			item,
			general: true,
			index,
		})),
		...review.inline_comments.map((item, index) => ({
			item,
			general: false,
			index,
		})),
	];
	const protectedRank = SEV_RANK.P1;
	const dropped = new Set<Slot<G | I>>();

	if (limits.floor !== null) {
		const min = SEV_RANK[limits.floor];
		for (const s of slots) {
			const rank = SEV_RANK[s.item.severity];
			if (rank < protectedRank && rank < min) dropped.add(s);
		}
	}

	if (limits.budget !== null) {
		const ranked = slots
			.filter((s) => !dropped.has(s))
			.sort(
				(a, b) =>
					SEV_RANK[b.item.severity] - SEV_RANK[a.item.severity] ||
					b.item.confidence - a.item.confidence ||
					supportOf(b.item) - supportOf(a.item) ||
					Number(b.general) - Number(a.general) ||
					a.index - b.index,
			);
		const budget = limits.budget;
		ranked.forEach((s, i) => {
			if (i >= budget && SEV_RANK[s.item.severity] < protectedRank) {
				dropped.add(s);
			}
		});
	}

	const keepOf = <T extends G | I>(general: boolean): T[] =>
		slots
			.filter((s) => s.general === general && !dropped.has(s))
			.map((s) => s.item as T);
	const general_findings = keepOf<G>(true);
	const inline_comments = keepOf<I>(false);
	const removed = slots.filter((s) => dropped.has(s)).map((s) => s.item);
	const event =
		review.event === "REQUEST_CHANGES" &&
		general_findings.length + inline_comments.length === 0 &&
		removed.length > 0 &&
		!carriedBlocks
			? "COMMENT"
			: review.event;
	return {
		review: { ...review, event, general_findings, inline_comments },
		removed,
	};
}
