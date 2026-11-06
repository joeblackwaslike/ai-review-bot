import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { numberPatchLines } from "../../diff-lines.js";
import { routeModel } from "../../router.js";
import type { GhClient } from "../gh.js";
import { buildLiveWiring, routerContext } from "../live-wiring.js";
import { joinsClaim, labelledClaims } from "../metrics.js";
import type { LabelFile, Provider, ReplayFixture } from "../types.js";
import {
	type AdjCandidate,
	type AdjudicationCounts,
	adjudicate,
	isCurrentVerdict,
	JudgeUnavailableError,
	MAX_ERROR_SAMPLES,
	type NamedJudge,
} from "./adjudicate.js";
import { type AuditJudge, type AuditStored, auditFixture } from "./audit.js";
import { VerdictCache } from "./cache.js";
import type { JudgeInput } from "./judge.js";
import { EVIDENCE_CHARS, possibleFirstModels, routeJudges } from "./judge.js";
import { claimKey, snapshotId } from "./snapshot.js";
import type { VerdictRecord } from "./types.js";

export const DEFAULT_MAX_ANTHROPIC = 40;
export const DEFAULT_MAX_OPENAI = 0;

export interface AdjudicationJudges {
	verdictJudges(
		producer: Provider,
		producerModel: string,
		wantSecond: boolean,
	): Promise<{ first: NamedJudge; second: NamedJudge | null }>;
	auditJudges(
		producer: Provider,
		producerModel: string,
		wantSecond: boolean,
	): Promise<{ judge: AuditJudge; second: AuditJudge | null }>;
}

export interface AdjudicationRun {
	id: string;
	dir: string;
	caps: { anthropic: number; openai: number };
	plan: boolean;
	audit: boolean;
	client: GhClient;
	out: (s: string) => void;
	cacheDir?: string;
	judges: AdjudicationJudges | (() => Promise<AdjudicationJudges>);
}

interface Located extends AdjCandidate {
	roundIndex: number;
}

interface ModelInfo {
	model: string;
	note: string;
}

type Cache = VerdictCache<VerdictRecord | AuditStored>;

const unavailableError = (err: unknown): never => {
	throw new JudgeUnavailableError(
		err instanceof Error ? err.message : String(err),
	);
};

/** Whether the candidate's line is within the part of the numbered patch the judge is shown. */
function lineShown(numbered: string, line: number | null): boolean {
	if (numbered.length <= EVIDENCE_CHARS || line === null) return true;
	let lastShown = 0;
	for (const m of numbered.slice(0, EVIDENCE_CHARS).matchAll(/^\s*(\d+)\|/gm))
		lastShown = Math.max(lastShown, Number(m[1]));
	return line <= lastShown;
}

const SINGLE_FAMILY_NOTE = "single-family verdicts have no second-model check";

const zero = (): AdjudicationCounts => ({
	real: 0,
	notReal: 0,
	unclear: 0,
	unresolved: 0,
	singleFamily: 0,
	cached: 0,
	deferred: 0,
	errors: 0,
});

const add = (
	a: AdjudicationCounts,
	b: AdjudicationCounts,
): AdjudicationCounts => ({
	real: a.real + b.real,
	notReal: a.notReal + b.notReal,
	unclear: a.unclear + b.unclear,
	unresolved: a.unresolved + b.unresolved,
	singleFamily: a.singleFamily + b.singleFamily,
	cached: a.cached + b.cached,
	deferred: a.deferred + b.deferred,
	errors: a.errors + b.errors,
});

function unmatchedCandidates(
	fixture: ReplayFixture,
	labels: LabelFile,
): Located[] {
	const claims = labelledClaims(fixture, labels);
	const seen = new Map<string, Located>();
	for (const round of fixture.rounds)
		for (const c of round.trace?.candidates ?? []) {
			const key = `${c.path}\0${c.line}\0${c.title}`;
			if (seen.has(key) || claims.some((k) => joinsClaim(c, k))) continue;
			seen.set(key, {
				path: c.path,
				line: c.line,
				title: c.title,
				roundIndex: round.index,
			});
		}
	return [...seen.values()];
}

function planLines(
	candidates: Located[],
	cache: Cache,
	snapshot: string,
	producer: Provider,
	caps: AdjudicationRun["caps"],
): string[] {
	const distinct = new Map(candidates.map((c) => [claimKey(c), c]));
	let cached = 0;
	let upgradable = 0;
	for (const key of distinct.keys()) {
		const hit = cache.get(snapshot, key) as VerdictRecord | undefined;
		if (!isCurrentVerdict(hit, possibleFirstModels(producer))) continue;
		cached++;
		if (
			producer === "anthropic" &&
			hit.status === "single-family" &&
			hit.verdict !== "not-real"
		)
			upgradable++;
	}
	const fresh = distinct.size - cached;
	const anthropic = Math.min(fresh, caps.anthropic);
	const crossChecks = producer === "anthropic" ? caps.openai : 0;
	return [
		`plan for ${snapshot}: no model is called`,
		`distinct unmatched candidates: ${distinct.size}`,
		`cached: ${cached}`,
		`candidates to judge: ${fresh}`,
		`anthropic calls allowed: ${anthropic} of ${caps.anthropic}`,
		`deferred past the anthropic cap: ${fresh - anthropic}`,
		`openai calls allowed: ${crossChecks} (cap ${caps.openai}); cached single-family verdicts that could be upgraded: ${upgradable}`,
	];
}

export async function runAdjudication(run: AdjudicationRun): Promise<number> {
	const { out, caps } = run;
	const fixturePath = join(run.dir, `${run.id}.json`);
	const labelsPath = join(run.dir, `${run.id}.labels.json`);
	if (!existsSync(fixturePath) || !existsSync(labelsPath)) {
		out(`no fixture or labels for ${run.id} in ${run.dir}`);
		return 1;
	}
	const fixture = JSON.parse(
		await readFile(fixturePath, "utf8"),
	) as ReplayFixture;
	const labelsText = await readFile(labelsPath, "utf8");
	const labels = JSON.parse(labelsText) as LabelFile;
	const labelsHash = createHash("sha256")
		.update(labelsText)
		.digest("hex")
		.slice(0, 16);
	const snapshot = snapshotId(fixture);
	const cache: Cache = new VerdictCache(run.cacheDir);
	const candidates = unmatchedCandidates(fixture, labels);

	if (run.plan) {
		for (const line of planLines(
			candidates,
			cache,
			snapshot,
			fixture.provider,
			caps,
		))
			out(line);
		return 0;
	}

	const { fetchDiff } = buildLiveWiring(fixture, run.client);
	const modelOf = new Map<number, ModelInfo>();
	const patches = new Map<number, Map<string, string>>();
	const unavailable = new Map<number, string>();
	let lastDiff = "";
	const lastRound = fixture.rounds[fixture.rounds.length - 1];
	for (const round of fixture.rounds) {
		try {
			const { files, diff } = await fetchDiff(round);
			if (round === lastRound) lastDiff = diff;
			patches.set(
				round.index,
				new Map(files.map((f) => [f.filename, f.patch ?? ""])),
			);
			modelOf.set(round.index, {
				model: routeModel(routerContext(files), fixture.provider).model,
				note: "routed from the round's compare files",
			});
		} catch (err) {
			unavailable.set(
				round.index,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	const evidenceOf = (c: Located): { text: string } | { reason: string } => {
		const failure = unavailable.get(c.roundIndex);
		if (failure !== undefined)
			return {
				reason: `evidence unavailable, round ${c.roundIndex} diff could not be fetched: ${failure}`,
			};
		if (!c.path) return { reason: "unanchored finding, no evidence" };
		const patch = patches.get(c.roundIndex)?.get(c.path);
		if (!patch) return { reason: `no patch evidence for ${c.path}` };
		const numbered = numberPatchLines(patch);
		if (!lineShown(numbered, c.line))
			return {
				reason: `line outside the shown patch (${c.path}:${c.line}; the judge sees ${EVIDENCE_CHARS} of ${numbered.length} chars)`,
			};
		return { text: numbered };
	};
	const evidenceByKey = new Map<string, string>();
	const judgeable: Located[] = [];
	const skipped = new Map<string, { c: Located; reason: string }>();
	for (const c of candidates) {
		const key = claimKey(c);
		if (evidenceByKey.has(key)) continue;
		const ev = evidenceOf(c);
		if ("text" in ev) {
			evidenceByKey.set(key, ev.text);
			judgeable.push(c);
			skipped.delete(key);
		} else if (!skipped.has(key)) skipped.set(key, { c, reason: ev.reason });
	}

	try {
		let factory: Promise<AdjudicationJudges> | undefined;
		const getFactory = () => {
			factory ??= Promise.resolve(
				typeof run.judges === "function" ? run.judges() : run.judges,
			);
			return factory;
		};
		const wantSecond = caps.openai > 0;

		if (run.audit) {
			const info = lastRound ? modelOf.get(lastRound.index) : undefined;
			if (!lastRound || !info) {
				out(
					lastRound
						? `audit aborted, evidence unavailable: the last round's diff could not be fetched (${unavailable.get(lastRound.index)}); no audit was recorded`
						: "audit aborted: the fixture has no rounds",
				);
				return 1;
			}
			const lastPatches = patches.get(lastRound.index);
			if (!lastPatches || ![...lastPatches.values()].some(Boolean)) {
				out(
					"audit aborted, evidence unavailable: the last round's diff has no patch text; no audit was recorded",
				);
				return 1;
			}
			out(`producer model: ${info.model} (${info.note})`);
			const route = routeJudges(fixture.provider, info.model);
			let built:
				| Promise<Awaited<ReturnType<AdjudicationJudges["auditJudges"]>>>
				| undefined;
			const build = () => {
				built ??= Promise.resolve()
					.then(() => getFactory())
					.then((f) => f.auditJudges(fixture.provider, info.model, wantSecond))
					.catch(unavailableError);
				return built;
			};
			const judge: AuditJudge = {
				family: route.first.provider,
				model: route.first.model,
				run: async (input) => (await build()).judge.run(input),
			};
			const second: AuditJudge | null =
				wantSecond && route.second
					? {
							family: route.second.provider,
							model: route.second.model,
							run: async (input) => {
								const other = (await build()).second;
								if (!other) throw new Error("no second audit judge");
								return other.run(input);
							},
						}
					: null;
			const result = await auditFixture({
				snapshot,
				fixture,
				labels,
				diff: lastDiff,
				labelsHash,
				judge,
				second,
				cache: cache as VerdictCache<AuditStored>,
				caps,
			});
			out(
				`audit: added=${result.added.length} unresolved=${result.unresolved} single-family=${result.singleFamily}${result.deferred ? " deferred=1" : ""}`,
			);
			out(
				`judge spend (calls, outside strategy cost): anthropic=${result.calls.anthropic} openai=${result.calls.openai}`,
			);
			if (result.crossCheckFailed !== null)
				out(
					`cross-check failed: ${result.crossCheckFailed}; the findings are single-family and the audit was not recorded`,
				);
			if (result.singleFamily > 0) out(SINGLE_FAMILY_NOTE);
			return 0;
		}

		const groups = new Map<string, Located[]>();
		const notes = new Map<string, string>();
		for (const c of judgeable) {
			const info = modelOf.get(c.roundIndex) as ModelInfo;
			groups.set(info.model, [...(groups.get(info.model) ?? []), c]);
			notes.set(info.model, info.note);
		}
		let counts = zero();
		for (const { c, reason } of skipped.values()) {
			counts.deferred++;
			out(`not judged, ${reason}: ${c.title}`);
		}
		const spend = { anthropic: 0, openai: 0 };
		const errorSamples: string[] = [];
		let unavailableMessage: string | null = null;
		for (const [model, group] of groups) {
			out(`producer model: ${model} (${notes.get(model)})`);
			const route = routeJudges(fixture.provider, model);
			let built:
				| Promise<Awaited<ReturnType<AdjudicationJudges["verdictJudges"]>>>
				| undefined;
			const build = () => {
				built ??= Promise.resolve()
					.then(() => getFactory())
					.then((f) => f.verdictJudges(fixture.provider, model, wantSecond))
					.catch(unavailableError);
				return built;
			};
			const pair = {
				first: {
					family: route.first.provider,
					model: route.first.model,
					run: async (input: JudgeInput) => (await build()).first.run(input),
				},
				second:
					wantSecond && route.second
						? {
								family: route.second.provider,
								model: route.second.model,
								run: async (input: JudgeInput) => {
									const other = (await build()).second;
									if (!other) throw new Error("no second verdict judge");
									return other.run(input);
								},
							}
						: null,
			};
			const result = await adjudicate({
				snapshot,
				candidates: group,
				producer: fixture.provider,
				judges: pair,
				cache: cache as VerdictCache<VerdictRecord>,
				caps: {
					anthropic: caps.anthropic - spend.anthropic,
					openai: caps.openai - spend.openai,
				},
				evidence: async (c) => evidenceByKey.get(claimKey(c)) ?? "",
			});
			counts = add(counts, result.counts);
			for (const m of result.errorSamples)
				if (
					errorSamples.length < MAX_ERROR_SAMPLES &&
					!errorSamples.includes(m)
				)
					errorSamples.push(m);
			spend.anthropic += result.spend.anthropic;
			spend.openai += result.spend.openai;
			if (result.unavailable !== null) {
				unavailableMessage = result.unavailable;
				break;
			}
		}
		out(
			`verdicts: real=${counts.real} not-real=${counts.notReal} unclear=${counts.unclear} unresolved=${counts.unresolved} single-family=${counts.singleFamily} cached=${counts.cached} deferred=${counts.deferred} errors=${counts.errors}`,
		);
		if (errorSamples.length > 0)
			out(`error samples: ${errorSamples.join(" | ")}`);
		out(
			`judge spend (calls, outside strategy cost): anthropic=${spend.anthropic} openai=${spend.openai}`,
		);
		if (unavailableMessage !== null) {
			out(`judge unavailable: ${unavailableMessage}`);
			return 1;
		}
		if (counts.singleFamily > 0) out(SINGLE_FAMILY_NOTE);
		return 0;
	} catch (err) {
		if (err instanceof JudgeUnavailableError) {
			out(`judge unavailable: ${err.message}`);
			return 1;
		}
		out(
			`adjudication failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
}
