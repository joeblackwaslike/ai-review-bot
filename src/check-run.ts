import type { ReviewDecision } from "./review.js";

interface CheckRunOctokit {
	request: <T>(
		route: string,
		params: Record<string, unknown>,
	) => Promise<{ data: T }>;
}

interface Annotation {
	path: string;
	start_line: number;
	end_line: number;
	annotation_level: "notice" | "warning" | "failure";
	message: string;
	title: string;
}

export function buildAnnotations(review: ReviewDecision): Annotation[] {
	return review.comments.map((comment) => ({
		path: comment.path,
		start_line: comment.start_line ?? comment.line,
		end_line: comment.line,
		annotation_level: review.event === "REQUEST_CHANGES" ? "warning" : "notice",
		message: comment.body.replace(/\*\*/g, "").slice(0, 500),
		title: comment.body.match(/\*\*(.+?)\*\*/)?.[1] ?? "Review finding",
	}));
}

export async function createCheckRun(
	octokit: CheckRunOctokit,
	owner: string,
	repo: string,
	headSha: string,
	review: ReviewDecision,
	commentPrefix: string,
): Promise<void> {
	const annotations = buildAnnotations(review);
	if (annotations.length === 0) return;

	const conclusion =
		review.event === "REQUEST_CHANGES"
			? "action_required"
			: review.event === "APPROVE"
				? "success"
				: "neutral";

	await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
		owner,
		repo,
		name: commentPrefix,
		head_sha: headSha,
		status: "completed",
		conclusion,
		output: {
			title: `${annotations.length} finding(s)`,
			summary: `${commentPrefix} found ${annotations.length} inline finding(s) in this PR.`,
			annotations: annotations.slice(0, 50),
		},
	});
}
