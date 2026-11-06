import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_TIER_MAP, OPENAI_TIER_MAP, routeModel } from "../../router.js";
import type { GhClient } from "../gh.js";
import { buildLiveWiring, routerContext } from "../live-wiring.js";
import { joinsClaim, labelledClaims } from "../metrics.js";
import type { LabelFile, Provider, ReplayFixture } from "../types.js";
import {
	type AdjCandidate,
	type AdjudicationCounts,
	adjudicate,
	type NamedJudge,
} from "./adjudicate.js";
import { type AuditJudge, type AuditStored, auditFixture } from "./audit.js";
import { VerdictCache } from "./cache.js";
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

const tierFallback = (provider: Provider): string =>
	(provider === "anthropic" ? CLAUDE_TIER_MAP : OPENAI_TIER_MAP).normal.model;

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
		if (!hit) continue;
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
	const labels = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
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
	let lastDiff = "";
	for (const round of fixture.rounds) {
		try {
			const { files, diff } = await fetchDiff(round);
			lastDiff = diff;
			patches.set(
				round.index,
				new Map(files.map((f) => [f.filename, f.patch ?? ""])),
			);
			modelOf.set(round.index, {
				model: routeModel(routerContext(files), fixture.provider).model,
				note: "routed from the round's compare files",
			});
		} catch {
			modelOf.set(round.index, {
				model: tierFallback(fixture.provider),
				note: "tier map normal tier, because the compare files were unavailable offline",
			});
		}
	}
	const evidenceByKey = new Map<string, string>();
	for (const c of candidates)
		evidenceByKey.set(
			claimKey(c),
			(c.path && patches.get(c.roundIndex)?.get(c.path)) || "",
		);

	try {
		const judges =
			typeof run.judges === "function" ? await run.judges() : run.judges;
		const wantSecond = caps.openai > 0;
		const lastRound = fixture.rounds[fixture.rounds.length - 1];
		const lastInfo = lastRound ? modelOf.get(lastRound.index) : undefined;

		if (run.audit) {
			const info = lastInfo ?? {
				model: tierFallback(fixture.provider),
				note: "tier map normal tier, because the fixture has no rounds",
			};
			out(`producer model: ${info.model} (${info.note})`);
			const { judge, second } = await judges.auditJudges(
				fixture.provider,
				info.model,
				wantSecond,
			);
			const result = await auditFixture({
				snapshot,
				fixture,
				labels,
				diff: lastDiff,
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
			if (result.singleFamily > 0) out(SINGLE_FAMILY_NOTE);
			return 0;
		}

		const groups = new Map<string, Located[]>();
		const notes = new Map<string, string>();
		for (const c of candidates) {
			const info = modelOf.get(c.roundIndex) as ModelInfo;
			groups.set(info.model, [...(groups.get(info.model) ?? []), c]);
			notes.set(info.model, info.note);
		}
		let counts = zero();
		const spend = { anthropic: 0, openai: 0 };
		for (const [model, group] of groups) {
			out(`producer model: ${model} (${notes.get(model)})`);
			const pair = await judges.verdictJudges(
				fixture.provider,
				model,
				wantSecond,
			);
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
			spend.anthropic += result.spend.anthropic;
			spend.openai += result.spend.openai;
		}
		out(
			`verdicts: real=${counts.real} not-real=${counts.notReal} unclear=${counts.unclear} unresolved=${counts.unresolved} single-family=${counts.singleFamily} cached=${counts.cached} deferred=${counts.deferred} errors=${counts.errors}`,
		);
		out(
			`judge spend (calls, outside strategy cost): anthropic=${spend.anthropic} openai=${spend.openai}`,
		);
		if (counts.singleFamily > 0) out(SINGLE_FAMILY_NOTE);
		return 0;
	} catch (err) {
		out(
			`adjudication failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
}
