import { generateObject } from "ai";
import { z } from "zod";
import type { ResolvedAuth } from "../auth.js";
import { createAIModel } from "../models.js";
import {
	type ModelSelection,
	outputBudget,
	reasoningProviderOptions,
} from "../router.js";
import { joinsClaim, labelledClaims } from "./metrics.js";
import type {
	CandidateRecord,
	LabelFile,
	PostedClaim,
	Provider,
	ReplayFixture,
} from "./types.js";

export const MAX_CLAIMS_PER_CANDIDATE = 3;
export const DEFAULT_MAX_CALLS = 20;
const EVIDENCE_CHARS = 4000;

export type JoinVerdict = "same" | "different" | "unclear";

export interface JoinJudgement {
	verdict: JoinVerdict;
	reason: string;
}

export type JoinJudge = (input: {
	candidate: CandidateRecord;
	claim: PostedClaim;
	evidence: string;
}) => Promise<JoinJudgement>;

export interface JoinPair {
	candidate: CandidateRecord;
	claim: PostedClaim;
	verdict: JoinVerdict;
	reason: string;
	matcherJoined: boolean;
}

export interface JoinInvestigation {
	pairs: JoinPair[];
	judgeFoundMatcherMissed: number;
	matcherJoined: number;
	/** Pairs not judged because `maxCalls` was reached. */
	skipped: number;
	candidates: number;
}

export class JoinFamilyError extends Error {}

export interface InvestigateOptions {
	fixture: ReplayFixture;
	labels: LabelFile;
	judge: JoinJudge;
	/** Model family of the judge; must differ from the fixture's provider. */
	judgeFamily: Provider;
	maxCalls?: number;
	/** Diff or code evidence for a candidate's path. */
	evidenceFor?: (path: string, roundIndex: number) => Promise<string>;
}

function distinctCandidates(
	f: ReplayFixture,
): { candidate: CandidateRecord; roundIndex: number }[] {
	const seen = new Map<
		string,
		{ candidate: CandidateRecord; roundIndex: number }
	>();
	for (const r of f.rounds)
		for (const c of r.trace?.candidates ?? [])
			seen.set(`${c.path}\0${c.line}\0${c.title}`, {
				candidate: c,
				roundIndex: r.index,
			});
	return [...seen.values()];
}

function nearestClaims(c: CandidateRecord, claims: PostedClaim[]) {
	const rank = (k: PostedClaim) =>
		(k.path === c.path ? 0 : 1_000_000) +
		(c.line !== null && k.line !== null ? Math.abs(c.line - k.line) : 100_000);
	return [...claims]
		.sort((a, b) => rank(a) - rank(b))
		.slice(0, MAX_CLAIMS_PER_CANDIDATE);
}

export async function investigateJoin(
	opts: InvestigateOptions,
): Promise<JoinInvestigation> {
	const { fixture, labels, judge } = opts;
	if (opts.judgeFamily === undefined)
		throw new JoinFamilyError("judgeFamily is required");
	if (opts.judgeFamily === fixture.provider)
		throw new JoinFamilyError(
			`judge family ${opts.judgeFamily} produced these candidates; use the other family`,
		);
	const claims = labelledClaims(fixture, labels);
	const candidates = distinctCandidates(fixture);
	const maxCalls =
		opts.maxCalls ?? Math.min(DEFAULT_MAX_CALLS, candidates.length);
	const nearest = candidates.map((c) => nearestClaims(c.candidate, claims));
	const pairs: JoinPair[] = [];
	let skipped = 0;
	for (let k = 0; k < MAX_CLAIMS_PER_CANDIDATE; k++) {
		for (const [i, entry] of candidates.entries()) {
			const claim = nearest[i]?.[k];
			if (!claim) continue;
			if (pairs.length >= maxCalls) {
				skipped++;
				continue;
			}
			const { candidate, roundIndex } = entry;
			const evidence =
				candidate.path && opts.evidenceFor
					? (await opts.evidenceFor(candidate.path, roundIndex)).slice(
							0,
							EVIDENCE_CHARS,
						)
					: "";
			const { verdict, reason } = await judge({ candidate, claim, evidence });
			pairs.push({
				candidate,
				claim,
				verdict,
				reason,
				matcherJoined: joinsClaim(candidate, claim),
			});
		}
	}
	return {
		pairs,
		candidates: candidates.length,
		skipped,
		matcherJoined: pairs.filter((p) => p.matcherJoined).length,
		judgeFoundMatcherMissed: pairs.filter(
			(p) => p.verdict === "same" && !p.matcherJoined,
		).length,
	};
}

const JudgementSchema = z.object({
	verdict: z.enum(["same", "different", "unclear"]),
	reason: z.string(),
});

const SYSTEM =
	"You compare a code review finding (candidate) with a labelled review claim. Decide whether they describe the same underlying problem in the code, even if worded or anchored differently. Answer same, different or unclear, with a one-line reason. Use unclear only when the evidence cannot settle it.";

export function modelJudge(
	selection: ModelSelection,
	auth: ResolvedAuth,
): JoinJudge {
	return async ({ candidate, claim, evidence }) => {
		const { object } = await generateObject({
			model: createAIModel(selection, auth),
			schema: JudgementSchema,
			maxOutputTokens: outputBudget(selection, 512),
			maxRetries: 2,
			providerOptions: reasoningProviderOptions(selection),
			system: SYSTEM,
			prompt: [
				`Candidate: ${candidate.title}`,
				`Candidate location: ${candidate.path ?? "(none)"}:${candidate.line ?? "?"}`,
				`Labelled claim: ${claim.title}`,
				`Claim location: ${claim.path ?? "(none)"}:${claim.line ?? "?"}`,
				`Claim text:\n${claim.text}`,
				`Diff evidence for the candidate's file:\n${evidence || "(none available)"}`,
			].join("\n\n"),
		});
		return object;
	};
}

export function formatInvestigation(id: string, r: JoinInvestigation): string {
	const rows = r.pairs.map(
		(p) =>
			`${p.verdict.padEnd(9)} matcher=${p.matcherJoined ? "yes" : "no "} ${p.candidate.path}:${p.candidate.line} "${p.candidate.title}" <-> ${p.claim.path}:${p.claim.line} "${p.claim.title}" | ${p.reason}`,
	);
	return [
		`join investigation ${id}`,
		...rows,
		`candidates=${r.candidates} judged=${r.pairs.length} skipped=${r.skipped} matcherJoined=${r.matcherJoined} judgeFoundMatcherMissed=${r.judgeFoundMatcherMissed}`,
	].join("\n");
}
