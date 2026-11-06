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
	/** Tighten the severity floor and findings budget from earlier rounds' outcomes. */
	adaptiveLimits: boolean;
	/** Collapse several agents' restatements of one claim into a single finding. */
	dedupeNearDuplicateClaims: boolean;
	/** Drop P2/P3 suppressible findings whose own closing sentence retracts them.
	 * Off by default: the phrase rule keeps meeting new false-drop shapes. */
	dropRetractions: boolean;
	/** Show each agent every finding this reviewer already filed on this PR. */
	showPriorOwnFindings: boolean;
	/** Require a finding to name a defect and rest on the diff. */
	strictEvidenceRules: boolean;
}

export const REVIEWER_TUNING: ReviewerTuning = {
	adaptiveLimits: false,
	dedupeNearDuplicateClaims: true,
	dropRetractions: false,
	showPriorOwnFindings: true,
	strictEvidenceRules: true,
};

/** Score bands for adaptive review limits. A score below `edges[0]` applies no
 * limit; each later band index selects the matching `budgets` and `floors` entry. */
export const ADAPTIVE_LIMIT_BANDS = {
	edges: [0.35, 0.6],
	budgets: [null, 10, 5],
	floors: [null, null, "P2"],
	decay: 0.5,
	deferredWeight: 0.5,
} as const;
