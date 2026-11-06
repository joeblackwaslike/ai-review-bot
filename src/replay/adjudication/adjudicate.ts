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

export interface AdjudicationResult {
	verdicts: Map<string, VerdictRecord>;
	counts: AdjudicationCounts;
	spend: { anthropic: number; openai: number };
}

export interface AdjudicateOptions {
	snapshot: string;
	candidates: AdjCandidate[];
	producer: JudgeFamily;
	judges: { first: NamedJudge; second: NamedJudge | null };
	cache: VerdictCache;
	caps: { anthropic: number; openai: number };
	evidence: (candidate: AdjCandidate) => Promise<string>;
}

const judgeRecord = (j: NamedJudge): JudgeRecord => ({
	family: j.family,
	model: j.model,
	promptHash: PROMPT_HASH,
});

const errorReason = (err: unknown) =>
	`judge error: ${err instanceof Error ? err.message : String(err)}`;

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
		const hit = cache.get(snapshot, key);
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
			} catch {
				counts.errors++;
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
			counts.errors++;
			const record: VerdictRecord = {
				verdict: "unclear",
				scope: null,
				reason: errorReason(err),
				first: judgeRecord(judges.first),
				second: null,
				secondVerdict: null,
				status: "single-family",
			};
			verdicts.set(key, record);
			tally(record);
			continue;
		}

		const record: VerdictRecord = {
			...first,
			first: judgeRecord(judges.first),
			second: null,
			secondVerdict: null,
			status: "single-family",
		};
		let cacheable = true;
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
				counts.errors++;
				cacheable = false;
				record.reason = `${record.reason} (${errorReason(err)})`;
			}
		}
		verdicts.set(key, record);
		tally(record);
		if (cacheable) cache.put(snapshot, key, record);
	}

	return { verdicts, counts, spend };
}
