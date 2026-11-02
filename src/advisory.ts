import type { ModelReview } from "./review.js";

/** Skills whose findings are opinions on quality or design, not defects. */
export const ADVISORY_SKILLS: ReadonlySet<string> = new Set([
	"code-review-and-quality.md",
	"architect-review.md",
]);

const lowered = (severity: string) =>
	severity === "P0" || severity === "P1" ? "P2" : severity;

/** Caps an advisory agent's review: P0/P1 become P2, every finding is tagged
 * `advisory`, and the event is COMMENT, so it can never block the PR. */
export function capAdvisory(review: ModelReview): ModelReview {
	const cap = <
		T extends { severity: ModelReview["general_findings"][number]["severity"] },
	>(
		f: T,
	): T & { advisory: true } => ({
		...f,
		severity: lowered(f.severity) as T["severity"],
		advisory: true,
	});
	return {
		event: "COMMENT",
		general_findings: review.general_findings.map(cap),
		inline_comments: review.inline_comments.map(cap),
	};
}

/** Applies `capAdvisory` to a successful outcome of an advisory skill; every other outcome passes through. One helper so the PR and CLI paths cannot drift. */
export function capAdvisoryOutcome<
	O extends { status: string; review?: ModelReview },
>(skillPath: string, outcome: O): O {
	const name = skillPath.split("/").pop() ?? skillPath;
	if (outcome.status !== "ok" || !outcome.review || !ADVISORY_SKILLS.has(name))
		return outcome;
	return { ...outcome, review: capAdvisory(outcome.review) };
}
