import type { Provider } from "../types.js";

export type Tier = "cheap" | "mid";

/** One labelled finding the verifier is asked to try to refute. */
export interface SpikeItem {
	/** `<fixture id>:<claim id>`, unique across fixtures. */
	id: string;
	fixtureId: string;
	/** The family that wrote the finding; the judge is always the other one. */
	producer: Provider;
	/** False when the fixture's label is still provisional. */
	confirmed: boolean;
	label: "fixed" | "rejected";
	owner: string;
	repo: string;
	headSha: string;
	path: string;
	line: number | null;
	severity: string;
	title: string;
	text: string;
}

export interface SpikeJudge {
	id: string;
	tier: Tier;
	vendor: Provider;
	model: string;
	effort: string;
}

export const REFUTATION_REASONS = [
	"wrong_root_cause",
	"impossible_path",
	"pure_style",
	"generic_missing",
] as const;
export type RefutationReason = (typeof REFUTATION_REASONS)[number];

export type SpikeOutcome =
	| {
			kind: "verdict";
			refuted: boolean;
			reason: RefutationReason | null;
			rationale: string;
			costUsd: number;
	  }
	| { kind: "unverified"; why: string; costUsd: number };

export interface SpikeResult {
	itemId: string;
	judgeId: string;
	outcome: SpikeOutcome;
}

/** A model call that was paid for but gave no usable verdict, such as an invalid object. Its cost still counts toward the spend. */
export class PaidCallError extends Error {
	constructor(
		message: string,
		readonly costUsd: number,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "PaidCallError";
	}
}
