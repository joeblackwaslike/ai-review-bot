import { runAuditPass } from "../audit.js";
import { resolveAnthropicAuth, resolveOpenAIAuth } from "../auth.js";
import { computeCost } from "../models.js";
import type { ModelReview, PullFile } from "../review.js";
import { REVIEWER_TUNING } from "../reviewer-tuning.js";
import { routeModel } from "../router.js";
import type { GhClient } from "./gh.js";
import type { LiveFinding, LiveOptions, LiveReviewOutput } from "./live.js";
import { ledgerForRound, postFilterTrace } from "./trace.js";
import type {
	CandidateRecord,
	LabelFile,
	ReplayFixture,
	Round,
	RoundUsage,
} from "./types.js";

const AGENTS_PER_REVIEW = 5;
const CHARS_PER_TOKEN = 4;
const EXPECTED_COMPLETION_TOKENS = 2000;

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

type LiveWiring = Pick<LiveOptions, "review" | "estimateCost" | "fetchDiff">;

/** Real review, cost estimate, and diff fetch for `replay --live`. Needs local
 * auth. The review also traces what would post, against a ledger of the
 * fixture's earlier rounds and the round's compare files. */
export function buildLiveWiring(
	fixture: ReplayFixture,
	client: GhClient,
	labels: LabelFile,
): LiveWiring {
	const provider = fixture.provider;
	const meta = { owner: fixture.owner, repo: fixture.repo, ref: "replay" };
	const selection = routeModel(
		{ additions: 0, deletions: 0, filePaths: [], labels: [] },
		provider,
	);
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
			return {
				diff: files.map((f) => `--- ${f.filename}\n${f.patch}`).join("\n"),
				approximate: round.approximate || round.mergeBase === null,
			};
		},
		estimateCost: (diff) =>
			computeCost(
				{
					promptTokens: (diff.length / CHARS_PER_TOKEN) * AGENTS_PER_REVIEW,
					completionTokens: EXPECTED_COMPLETION_TOKENS * AGENTS_PER_REVIEW,
				},
				selection.model,
			),
		review: async (diff, round): Promise<LiveReviewOutput> => {
			const auth =
				provider === "anthropic"
					? await resolveAnthropicAuth()
					: await resolveOpenAIAuth();
			const result = await runAuditPass({
				files: [{ path: "replay.diff", content: diff }],
				selection,
				extraInstructions: "",
				meta,
				auth,
			});
			const { posted } = postFilterTrace({
				agentReviews: result.agentReviews,
				ledger: ledgerForRound(fixture, labels, round),
				files: await compareFiles(round),
				tuning: REVIEWER_TUNING,
			});
			return { ...toLiveReviewOutput(result), posted };
		},
	};
}
