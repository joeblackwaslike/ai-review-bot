/** Behaviour changes aimed at the signal quality of a reviewer's output.
 *
 * Landed anthropic-only in response to `anthropicreviewbot` filing rounds of
 * non-defect findings on PRs it had already reviewed — measured across #43
 * and #45: restatements of one claim 4-8x, findings whose body states the
 * code is correct, and claims resting on facts checkable in the repo.
 * `codexreviewbot` was not doing that at the time, so it kept the
 * pre-existing (looser) behaviour rather than risk regressing a reviewer
 * that worked.
 *
 * Unified for both providers as of the ai-review-bot-5zu root-cause pass
 * (2026-08-09): PR #44 showed `codexreviewbot` independently producing the
 * same class of unfounded, confidently-false findings (a fabricated
 * compilation-break claim on `peers.ts`, a fabricated invalid-JSON claim on
 * `vercel.json` — both verified false against the actual code and CI). None
 * of these settings are anthropic-specific mechanics — they're
 * provider-agnostic prompt/merge behavior — so there was no remaining reason
 * to withhold them from a reviewer now shown to need the same protection. */
export interface ReviewerTuning {
	/** Collapse several agents' restatements of one claim into a single finding. */
	dedupeNearDuplicateClaims: boolean;
	/** Show each agent every finding this reviewer already filed on this PR. */
	showPriorOwnFindings: boolean;
	/** Require a finding to name a defect and rest on the diff. */
	strictEvidenceRules: boolean;
}

export const REVIEWER_TUNING: ReviewerTuning = {
	dedupeNearDuplicateClaims: true,
	showPriorOwnFindings: true,
	strictEvidenceRules: true,
};
