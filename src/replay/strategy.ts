import type { Ledger } from "../ledger/types.js";
import type { PullFile } from "../review.js";
import type { LiveFinding } from "./live.js";
import type {
	CandidateRecord,
	ReplayFixture,
	Round,
	RoundUsage,
} from "./types.js";

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
	fixture: ReplayFixture;
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
	posted: CandidateRecord[];
	usage: RoundUsage;
	toolCalls: ToolCallRecord[];
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
