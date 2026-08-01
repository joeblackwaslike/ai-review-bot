import type { ModelSelection } from "./router.js";

/** Behaviour changes aimed at the signal quality of a reviewer's output.
 *
 * Scoped per provider on purpose. These land in response to `anthropicreviewbot`
 * filing rounds of non-defect findings on PRs it had already reviewed — measured
 * across #43 and #45: restatements of one claim 4-8x, findings whose body states
 * the code is correct, and claims resting on facts checkable in the repo.
 *
 * `codexreviewbot` was not doing that. On the same PRs it duplicated far less,
 * found a real bug nobody else did, and approved once its findings were
 * addressed. Turning these on for it would be changing a reviewer that works on
 * the evidence of one that does not, so it keeps today's behaviour until this is
 * validated against its own output. */
export interface ReviewerTuning {
	/** Collapse several agents' restatements of one claim into a single finding. */
	dedupeNearDuplicateClaims: boolean;
	/** Show each agent every finding this reviewer already filed on this PR. */
	showPriorOwnFindings: boolean;
	/** Require a finding to name a defect and rest on the diff. */
	strictEvidenceRules: boolean;
}

const TUNED: ReviewerTuning = {
	dedupeNearDuplicateClaims: true,
	showPriorOwnFindings: true,
	strictEvidenceRules: true,
};

const LEGACY: ReviewerTuning = {
	dedupeNearDuplicateClaims: false,
	showPriorOwnFindings: false,
	strictEvidenceRules: false,
};

/** Smoke test: verifying review rendering in production.
 *
 * One switch. Flip `openai` to TUNED once the corpus replay covers its output
 * too, rather than growing a second set of per-flag conditions. */
export function tuningFor(
	provider: ModelSelection["provider"],
): ReviewerTuning {
	return provider === "anthropic" ? TUNED : LEGACY;
}
