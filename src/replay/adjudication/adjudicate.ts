import type { VerdictCache } from "./cache.js";
import { type Judge, PROMPT_HASH } from "./judge.js";
import { claimKey } from "./snapshot.js";
import type { JudgeFamily, JudgeRecord, VerdictRecord } from "./types.js";

export interface AdjCandidate {
	path: string | null;
	line: number | null;
	title: string;
	body?: string;
}

export interface NamedJudge {
	family: JudgeFamily;
	model: string;
	run: Judge;
}

export interface AdjudicationCounts {
	real: number;
	notReal: number;
	unclear: number;
	unresolved: number;
	singleFamily: number;
	cached: number;
	deferred: number;
	errors: number;
}

/** Thrown by a judge wrapper when no judge can be built (expired session, missing key); it stops the run. */
export class JudgeUnavailableError extends Error {}

export interface AdjudicationResult {
	verdicts: Map<string, VerdictRecord>;
	counts: AdjudicationCounts;
	spend: { anthropic: number; openai: number };
	/** Distinct error messages from judge calls, at most MAX_ERROR_SAMPLES. */
	errorSamples: string[];
	/** Set when the judges could not be built; the run stopped there. */
	unavailable: string | null;
}

export const MAX_ERROR_SAMPLES = 5;

export interface AdjudicateOptions {
	snapshot: string;
	candidates: AdjCandidate[];
	producer: JudgeFamily;
	judges: { first: NamedJudge; second: NamedJudge | null };
	cache: VerdictCache;
	caps: { anthropic: number; openai: number };
	evidence: (candidate: AdjCandidate) => Promise<string>;
}

/** A cached verdict counts only if it was made with the current prompt and a current first-judge model. */
export function isCurrentVerdict(
	record: VerdictRecord | undefined,
	firstModels: readonly string[],
): record is VerdictRecord {
	return (
		record !== undefined &&
		record.first.promptHash === PROMPT_HASH &&
		firstModels.includes(record.first.model)
	);
}

const judgeRecord = (j: NamedJudge): JudgeRecord => ({
	family: j.family,
	model: j.model,
	promptHash: PROMPT_HASH,
});

export async function adjudicate(
	opts: AdjudicateOptions,
): Promise<AdjudicationResult> {
	const { judges, caps, cache, snapshot } = opts;
	const verdicts = new Map<string, VerdictRecord>();
	const counts: AdjudicationCounts = {
		real: 0,
		notReal: 0,
		unclear: 0,
		unresolved: 0,
		singleFamily: 0,
		cached: 0,
		deferred: 0,
		errors: 0,
	};
	const spend = { anthropic: 0, openai: 0 };
	const errorSamples: string[] = [];
	let unavailable: string | null = null;
	const noteError = (err: unknown) => {
		counts.errors++;
		const message = err instanceof Error ? err.message : String(err);
		if (
			errorSamples.length < MAX_ERROR_SAMPLES &&
			!errorSamples.includes(message)
		)
			errorSamples.push(message);
	};
	const callsMade = (family: JudgeFamily) => spend[family];

	const tally = (record: VerdictRecord) => {
		if (record.status === "unresolved") {
			counts.unresolved++;
			return;
		}
		if (record.status === "single-family") counts.singleFamily++;
		if (record.verdict === "real") counts.real++;
		else if (record.verdict === "not-real") counts.notReal++;
		else counts.unclear++;
	};

	const distinct = new Map<string, AdjCandidate>();
	for (const c of opts.candidates) {
		const key = claimKey(c);
		if (!distinct.has(key)) distinct.set(key, c);
	}

	for (const [key, candidate] of distinct) {
		const stored = cache.get(snapshot, key);
		const hit = isCurrentVerdict(stored, [judges.first.model])
			? stored
			: undefined;
		const second = judges.second;
		const upgradable =
			hit?.status === "single-family" &&
			hit.second === null &&
			hit.verdict !== "not-real" &&
			opts.producer === "anthropic" &&
			second !== null &&
			callsMade(second.family) < caps[second.family];
		if (hit && upgradable && second) {
			const upgraded = { ...hit };
			spend[second.family]++;
			try {
				const check = await second.run({
					claim: candidate,
					diffEvidence: await opts.evidence(candidate),
				});
				upgraded.second = judgeRecord(second);
				upgraded.secondVerdict = check.verdict;
				upgraded.status =
					check.verdict === hit.verdict ? "agreed" : "unresolved";
				cache.put(snapshot, key, upgraded);
			} catch (err) {
				if (err instanceof JudgeUnavailableError) {
					unavailable = err.message;
					break;
				}
				noteError(err);
				counts.cached++;
				verdicts.set(key, hit);
				tally(hit);
				continue;
			}
			verdicts.set(key, upgraded);
			tally(upgraded);
			continue;
		}
		if (hit) {
			counts.cached++;
			verdicts.set(key, hit);
			tally(hit);
			continue;
		}
		if (callsMade(judges.first.family) >= caps[judges.first.family]) {
			counts.deferred++;
			continue;
		}
		const input = {
			claim: candidate,
			diffEvidence: await opts.evidence(candidate),
		};
		spend[judges.first.family]++;
		let first: Awaited<ReturnType<Judge>>;
		try {
			first = await judges.first.run(input);
		} catch (err) {
			if (err instanceof JudgeUnavailableError) {
				unavailable = err.message;
				break;
			}
			noteError(err);
			continue;
		}

		const record: VerdictRecord = {
			...first,
			first: judgeRecord(judges.first),
			second: null,
			secondVerdict: null,
			status: "single-family",
		};
		const wantsSecond =
			opts.producer === "anthropic" &&
			second !== null &&
			first.verdict !== "not-real";
		if (
			wantsSecond &&
			second &&
			callsMade(second.family) < caps[second.family]
		) {
			spend[second.family]++;
			try {
				const check = await second.run(input);
				record.second = judgeRecord(second);
				record.secondVerdict = check.verdict;
				record.status =
					check.verdict === first.verdict ? "agreed" : "unresolved";
			} catch (err) {
				if (err instanceof JudgeUnavailableError) {
					unavailable = err.message;
					break;
				}
				noteError(err);
				cache.put(snapshot, key, {
					...record,
					second: null,
					secondVerdict: null,
					status: "single-family",
				});
				continue;
			}
		}
		verdicts.set(key, record);
		tally(record);
		cache.put(snapshot, key, record);
	}

	return { verdicts, counts, spend, errorSamples, unavailable };
}
