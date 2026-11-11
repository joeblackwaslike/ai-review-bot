import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertCommittedPlan, loadPlan, planHash } from "../experiment/plan.js";
import { splitOf } from "../experiment/splits.js";
import { ResultsStore, type StoredCell } from "../experiment/store.js";
import type { GhClient } from "../gh.js";
import { joinsClaim, labelledClaims } from "../metrics.js";
import { fixtureFamily, type LabelFile, type ReplayFixture } from "../types.js";
import { isCurrentVerdict } from "./adjudicate.js";
import { VerdictCache } from "./cache.js";
import { possibleFirstModels } from "./judge.js";
import {
	type AdjudicationCandidate,
	type AdjudicationRun,
	runAdjudication,
} from "./run.js";
import { claimKey, snapshotId } from "./snapshot.js";
import type { VerdictRecord } from "./types.js";

/** Distinct (path, line, title) a strategy posted that no labelled claim covers; the earliest round wins. */
export function postedCandidates(
	cells: StoredCell[],
	fixture: ReplayFixture,
	labels: LabelFile,
): AdjudicationCandidate[] {
	const claims = labelledClaims(fixture, labels);
	const seen = new Map<string, AdjudicationCandidate>();
	const ordered = cells
		.filter((c) => !c.stale)
		.sort((a, b) => a.key.round - b.key.round);
	for (const cell of ordered)
		for (const p of cell.result.posted) {
			const key = `${p.path}\0${p.line}\0${p.title}`;
			if (seen.has(key) || claims.some((c) => joinsClaim(p, c))) continue;
			seen.set(key, {
				path: p.path,
				line: p.line,
				title: p.title,
				roundIndex: cell.key.round,
			});
		}
	return [...seen.values()];
}

export async function runResultsAdjudication(args: {
	planFile: string;
	root: string;
	fixturesDir: string;
	caps: { anthropic: number; openai: number };
	plan: boolean;
	client: GhClient;
	out: (s: string) => void;
	cacheDir?: string;
	judges: AdjudicationRun["judges"];
}): Promise<number> {
	const { out } = args;
	let loaded: ReturnType<typeof loadPlan>;
	try {
		loaded = loadPlan(args.planFile);
	} catch (err) {
		out(
			`cannot load plan ${args.planFile}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
	const { plan, lockedHash } = loaded;
	if (plan.draft) {
		out(
			"the plan is marked draft; nothing is adjudicated until it is final and locked",
		);
		return 1;
	}
	try {
		assertCommittedPlan(plan, lockedHash);
	} catch (err) {
		out(err instanceof Error ? err.message : String(err));
		return 1;
	}

	const { records, skipped } = new ResultsStore(
		args.root,
		planHash(plan),
	).readAll(
		Object.fromEntries(plan.strategies.map((s) => [s.name, s.version])),
	);
	if (skipped > 0) out(`${skipped} unreadable result line(s) skipped`);

	const cache = new VerdictCache<VerdictRecord>(args.cacheDir);
	const spent = { anthropic: 0, openai: 0 };
	let deferred = 0;
	let total = 0;
	let failed = false;
	for (const ref of plan.fixtures) {
		const m = ref.id.match(/^([^/]+)\/([^#]+)#(\d+)(?:@\w+)?$/);
		if (!m) continue;
		const stem = `${m[1]}__${m[2]}__${m[3]}__${ref.provider}`;
		const fixturePath = join(args.fixturesDir, `${stem}.json`);
		const labelsPath = join(args.fixturesDir, `${stem}.labels.json`);
		if (!existsSync(fixturePath) || !existsSync(labelsPath)) {
			out(`no fixture or labels for ${ref.id} in ${args.fixturesDir}`);
			failed = true;
			continue;
		}
		const fixture = JSON.parse(
			await readFile(fixturePath, "utf8"),
		) as ReplayFixture;
		const labels = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
		const cells = records.filter((r) => r.key.fixtureId === ref.id);
		const candidates = postedCandidates(cells, fixture, labels);
		if (candidates.length === 0) continue;
		total += candidates.length;
		const split = splitOf(ref.id, plan.seed);
		out(
			`fixture ${ref.id} (${split} split): ${candidates.length} candidate(s)`,
		);
		const code = await runAdjudication({
			id: stem,
			dir: args.fixturesDir,
			caps: {
				anthropic: Math.max(0, args.caps.anthropic - spent.anthropic),
				openai: Math.max(0, args.caps.openai - spent.openai),
			},
			plan: args.plan,
			audit: false,
			client: args.client,
			out,
			cacheDir: args.cacheDir,
			judges: args.judges,
			candidates: () => candidates,
			onSpend: (s) => {
				spent.anthropic += s.anthropic;
				spent.openai += s.openai;
			},
			quiet: split === "test",
		});
		if (args.plan) continue;
		const snapshot = snapshotId(fixture);
		const models = possibleFirstModels(fixtureFamily(fixture));
		const keys = new Set(candidates.map((c) => claimKey(c)));
		for (const key of keys)
			if (!isCurrentVerdict(cache.get(snapshot, key), models)) deferred++;
		if (code !== 0) {
			failed = true;
			break;
		}
	}
	out(
		args.plan
			? `total distinct candidates across fixtures: ${total}`
			: `total judge calls: anthropic=${spent.anthropic} openai=${spent.openai}, unjudged (deferred by cap): ${deferred}`,
	);
	return failed ? 1 : 0;
}
