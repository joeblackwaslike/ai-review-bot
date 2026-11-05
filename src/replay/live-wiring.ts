import { numberPatchLines } from "../diff-lines.js";
import type { ModelReview, PullFile } from "../review.js";
import type { RouterContext } from "../router.js";
import type { GhClient } from "./gh.js";
import type { LiveFinding, LiveOptions, LiveReviewOutput } from "./live.js";
import type {
	CandidateRecord,
	ReplayFixture,
	Round,
	RoundUsage,
} from "./types.js";

interface CompareResponse {
	files?: { filename: string; status?: string; patch?: string }[];
}

export function toLiveFindings(review: ModelReview): LiveFinding[] {
	return [
		...review.inline_comments.map((c) => ({
			title: c.title,
			path: c.path,
			line: c.line,
			body: c.body,
			severity: c.severity,
			suppressible: c.suppressible,
		})),
		...review.general_findings.map((g) => ({
			title: g.title,
			path: null,
			line: null,
			body: g.body,
			severity: g.severity,
			suppressible: g.suppressible,
		})),
	];
}

/** One candidate per inline comment and general finding of every agent review, in agent order. */
export function toCandidates(
	agentReviews: { skill: string; review: ModelReview }[],
): CandidateRecord[] {
	return agentReviews.flatMap(({ skill, review }) =>
		toLiveFindings(review).map((f) => ({
			skill: `${skill}.md`,
			title: f.title,
			path: f.path,
			line: f.line,
			severity: f.severity ?? null,
		})),
	);
}

/** Shape a `runAuditPass` result into the live tier's review output, less the post-filter trace. */
export function toLiveReviewOutput(result: {
	review: ModelReview;
	agentReviews: { skill: string; review: ModelReview }[];
	usageBySkill: RoundUsage;
}): Omit<LiveReviewOutput, "posted"> {
	return {
		findings: toLiveFindings(result.review),
		candidates: toCandidates(result.agentReviews),
		usage: Object.fromEntries(
			Object.entries(result.usageBySkill).map(([k, v]) => [`${k}.md`, v]),
		),
	};
}

/** The router input production derives from a PR, taken from a round's compare files. */
export function routerContext(files: PullFile[]): RouterContext {
	let additions = 0;
	let deletions = 0;
	for (const f of files)
		for (const line of (f.patch ?? "").split("\n")) {
			if (line.startsWith("+")) additions++;
			else if (line.startsWith("-")) deletions++;
		}
	return {
		additions,
		deletions,
		filePaths: files.map((f) => f.filename),
		labels: [],
	};
}

/** Fetches each round's compare files once and turns them into the numbered
 * diff the strategies review. */
export function buildLiveWiring(
	fixture: ReplayFixture,
	client: GhClient,
): Pick<LiveOptions, "fetchDiff"> {
	const compared = new Map<number, Promise<PullFile[]>>();
	const compareFiles = (round: Round): Promise<PullFile[]> => {
		const cached = compared.get(round.index);
		if (cached) return cached;
		const base = round.mergeBase ?? round.baseSha;
		const files = client
			.rest<CompareResponse>(
				`repos/${fixture.owner}/${fixture.repo}/compare/${base}...${round.headSha}`,
			)
			.then((cmp) =>
				(cmp.files ?? []).map((f) => ({
					filename: f.filename,
					status: f.status ?? "modified",
					patch: f.patch ?? "",
				})),
			);
		compared.set(round.index, files);
		return files;
	};
	return {
		fetchDiff: async (round) => {
			const files = await compareFiles(round);
			const diff = files
				.map(
					(f) =>
						`--- ${f.filename}\n${f.patch ? numberPatchLines(f.patch) : ""}`,
				)
				.join("\n");
			return {
				diff,
				files,
				approximate: round.approximate || round.mergeBase === null,
			};
		},
	};
}
