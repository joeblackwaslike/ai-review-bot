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
	advisory?: true;
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

type Finding<R extends LimitableReview<Limitable, Limitable>> =
	| R["general_findings"][number]
	| R["inline_comments"][number];

interface Slot<T> {
	item: T;
	general: boolean;
	index: number;
}

/** Removes new findings under the severity floor and past the budget. P0 and P1 are never
 * removed but do count toward the budget (a budget of 2 with two P1 leaves no room for any
 * P2). Findings rank by severity, non-advisory before advisory, confidence, `supportOf`, then original position, and kept
 * findings keep their input order. A REQUEST_CHANGES review whose kept findings are all advisory (or none)
 * becomes COMMENT unless `carriedBlocks`. Inputs are not mutated. */
export function applyLimits<R extends LimitableReview<Limitable, Limitable>>(
	review: R,
	limits: { floor: Sev | null; budget: number | null },
	supportOf: (f: Finding<R>) => number,
	carriedBlocks: boolean,
): { review: R; removed: Finding<R>[] } {
	type G = R["general_findings"][number];
	type I = R["inline_comments"][number];
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
					Number(!b.item.advisory) - Number(!a.item.advisory) ||
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
		removed.length > 0 &&
		![...general_findings, ...inline_comments].some((x) => !x.advisory) &&
		!carriedBlocks
			? "COMMENT"
			: review.event;
	return {
		review: { ...review, event, general_findings, inline_comments },
		removed,
	};
}

/** One plain sentence for the review body naming the limits that removed findings, or
 * null when nothing was removed. It carries no bullet and no marker, so the next round's
 * baseline cannot read it back as a finding. */
export function limitNotice(
	limits: Pick<ResolvedLimits, "floor" | "budget">,
	removedCount: number,
): string | null {
	if (removedCount === 0) return null;
	const { floor, budget } = limits;
	const why = "because most findings in earlier rounds were declined";
	if (budget !== null) {
		const floorPart = floor !== null ? ` (${floor} and up)` : "";
		return `Showing the ${budget} highest-severity findings this round${floorPart}, ${why}.`;
	}
	if (floor !== null) {
		return `Showing findings of ${floor} and up this round, ${why}.`;
	}
	return null;
}

/** How many agents support each finding, for the limits' tie-break. Inline comments are
 * counted per `inlineKey` resolved through `aliases` (collapsed restatements count for the
 * survivor); general findings per case-insensitive title. A finding no agent lists counts 1. */
export function supportCounts<
	I,
	G extends { title: string } = { title: string },
>(input: {
	inlineByAgent: I[][];
	generalByAgent: G[][];
	inlineKey: (c: I) => string;
	aliases: ReadonlyMap<string, string>;
}): { inline: (c: I) => number; general: (title: string) => number } {
	const resolve = (c: I) => {
		const own = input.inlineKey(c);
		return input.aliases.get(own) ?? own;
	};
	const inlineAgents = new Map<string, Set<number>>();
	input.inlineByAgent.forEach((comments, agent) => {
		for (const c of comments) {
			const key = resolve(c);
			const set = inlineAgents.get(key) ?? new Set<number>();
			set.add(agent);
			inlineAgents.set(key, set);
		}
	});
	return {
		inline: (c) => Math.max(1, inlineAgents.get(resolve(c))?.size ?? 0),
		general: (title) => {
			const t = title.toLowerCase();
			return Math.max(
				1,
				input.generalByAgent.filter((g) =>
					g.some((f) => f.title.toLowerCase() === t),
				).length,
			);
		},
	};
}
