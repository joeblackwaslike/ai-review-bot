import type { Ledger } from "../ledger/types.js";
import type { ModelReview, PullFile } from "../review.js";
import type { FrozenFixture } from "./frozen.js";
import type { LiveFinding } from "./live.js";
import type { CandidateRecord, Round, RoundUsage } from "./types.js";

export interface CheckoutHandle {
	path: string;
	baseSha: string;
	headSha: string;
}

export interface FrozenHistory {
	ledger: Ledger;
}

export interface ToolCallRecord {
	name: string;
	wallMs: number;
	costUsd: number;
}

export interface StrategyInput {
	fixture: FrozenFixture;
	round: Round;
	diff: string;
	files: PullFile[];
	approximateDiff: boolean;
	checkout: CheckoutHandle | null;
	history: FrozenHistory;
	budget: { maxUsd: number; maxWallMs: number };
	signal: AbortSignal;
}

export interface StrategyResult {
	findings: LiveFinding[];
	candidates: CandidateRecord[];
	/** Overwritten by `runStrategy`; strategies may leave it empty. */
	posted: CandidateRecord[];
	/** Candidates grouped by producing agent; the harness filters these into `posted`. */
	agentReviews: { skill: string; review: ModelReview }[];
	usage: RoundUsage;
	toolCalls: ToolCallRecord[];
	/** Set by spend-matched strategies (a0): what they aimed for and hit. */
	spend?: { targetUsd: number; achievedUsd: number; withinTolerance: boolean };
	wallMs: number;
}

export interface ReviewStrategy {
	name: string;
	version: string;
	needsCheckout: boolean;
	estimateCost(input: StrategyInput): number;
	run(input: StrategyInput): Promise<StrategyResult>;
}

export class UnknownStrategyError extends Error {}

const registry = new Map<string, ReviewStrategy>();

export function registerStrategy(s: ReviewStrategy): void {
	if (registry.has(s.name)) {
		throw new Error(`strategy already registered: ${s.name}`);
	}
	registry.set(s.name, s);
}

export function strategyNames(): string[] {
	return [...registry.keys()].sort();
}

export function getStrategy(name: string): ReviewStrategy {
	const s = registry.get(name);
	if (!s) {
		throw new UnknownStrategyError(
			`unknown strategy "${name}"; registered: ${strategyNames().join(", ")}`,
		);
	}
	return s;
}

export function resetStrategiesForTest(): void {
	registry.clear();
}
