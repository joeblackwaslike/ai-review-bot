import { numberPatchLines } from "../diff-lines.js";
import type { ModelReview, PullFile } from "../review.js";
import type { RouterContext } from "../router.js";
import type { GhClient } from "./gh.js";
import type { LiveFinding, LiveOptions, LiveReviewOutput } from "./live.js";
import { strategyA } from "./strategies/a.js";
import type { StrategyInput } from "./strategy.js";
import { ledgerForRound } from "./trace.js";
import type {
	CandidateRecord,
	LabelFile,
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

type LiveWiring = Pick<LiveOptions, "review" | "estimateCost" | "fetchDiff">;

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

/** Adapter over strategy a for `replay --live`: fetches the round's diff and
 * compare files, then delegates review and cost estimate to the strategy. */
export function buildLiveWiring(
	fixture: ReplayFixture,
	client: GhClient,
	labels: LabelFile,
): LiveWiring {
	const compared = new Map<number, Promise<PullFile[]>>();
	const fetched = new Map<number, StrategyInput>();
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
	const inputFor = (diff: string, round: Round): StrategyInput => {
		const fetchedInput = fetched.get(round.index);
		if (!fetchedInput)
			throw new Error(`round ${round.index}: fetchDiff must run first`);
		return { ...fetchedInput, diff };
	};
	return {
		fetchDiff: async (round) => {
			const files = await compareFiles(round);
			const approximate = round.approximate || round.mergeBase === null;
			const diff = files
				.map(
					(f) =>
						`--- ${f.filename}\n${f.patch ? numberPatchLines(f.patch) : ""}`,
				)
				.join("\n");
			fetched.set(round.index, {
				fixture,
				round,
				labels,
				diff,
				files,
				approximateDiff: approximate,
				checkout: null,
				history: { ledger: ledgerForRound(fixture, labels, round) },
				budget: {
					maxUsd: Number.POSITIVE_INFINITY,
					maxWallMs: Number.POSITIVE_INFINITY,
				},
				signal: new AbortController().signal,
			});
			return { diff, approximate };
		},
		estimateCost: (diff, round) =>
			strategyA.estimateCost(inputFor(diff, round)),
		review: async (diff, round): Promise<LiveReviewOutput> => {
			const { findings, candidates, posted, usage } = await strategyA.run(
				inputFor(diff, round),
			);
			return { findings, candidates, posted, usage };
		},
	};
}
