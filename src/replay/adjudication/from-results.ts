import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertCommittedPlan, loadPlan, planHash } from "../experiment/plan.js";
import { splitOf } from "../experiment/splits.js";
import { ResultsStore, type StoredCell } from "../experiment/store.js";
import type { GhClient } from "../gh.js";
import { joinsClaim, labelledClaims } from "../metrics.js";
import type { ReviewStrategy } from "../strategy.js";
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
	registry: (name: string) => ReviewStrategy;
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

	const versions: Record<string, string> = {};
	try {
		for (const p of plan.strategies) {
			const { version } = args.registry(p.name);
			if (version !== p.version)
				throw new Error(
					`strategy ${p.name} version ${version} differs from the plan's ${p.version}`,
				);
			versions[p.name] = version;
		}
	} catch (err) {
		out(err instanceof Error ? err.message : String(err));
		return 1;
	}
	const { records, skipped } = new ResultsStore(
		args.root,
		planHash(plan),
	).readAll(versions);
	if (skipped > 0) out(`${skipped} unreadable result line(s) skipped`);

	const cache = new VerdictCache<VerdictRecord>(args.cacheDir);
	const spent = { anthropic: 0, openai: 0 };
	const visible = { openai: 0, deferred: 0 };
	let unjudgeable: string[] = [];
	let testRan = false;
	let total = 0;
	let failed = false;
	const splitFor = (id: string) => splitOf(id, plan.seed);
	const ordered = [
		...plan.fixtures.filter((f) => splitFor(f.id) !== "test"),
		...plan.fixtures.filter((f) => splitFor(f.id) === "test"),
	];
	for (const ref of ordered) {
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
		let fixture: ReplayFixture;
		let labels: LabelFile;
		try {
			fixture = JSON.parse(
				await readFile(fixturePath, "utf8"),
			) as ReplayFixture;
			labels = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
		} catch (err) {
			out(
				splitFor(ref.id) === "test"
					? `cannot read fixture/labels for ${ref.id}`
					: `cannot read fixture/labels for ${ref.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			failed = true;
			continue;
		}
		const cells = records.filter((r) => r.key.fixtureId === ref.id);
		const candidates = postedCandidates(cells, fixture, labels);
		if (candidates.length === 0) continue;
		total += candidates.length;
		const hidden = splitFor(ref.id) === "test";
		if (hidden) testRan = true;
		const planLines: string[] = [];
		if (args.plan && hidden)
			out(`fixture ${ref.id} (test split): ${candidates.length} candidate(s)`);
		else if (!hidden)
			out(
				`fixture ${ref.id} (${splitFor(ref.id)} split): ${candidates.length} candidate(s)`,
			);
		unjudgeable = [];
		const spend = { anthropic: 0, openai: 0 };
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
			out: hidden ? (l) => planLines.push(l) : out,
			cacheDir: args.cacheDir,
			judges: args.judges,
			candidates: () => candidates,
			onSpend: (s) => {
				spend.anthropic += s.anthropic;
				spend.openai += s.openai;
				unjudgeable = s.unjudgeable;
			},
			quiet: hidden,
		});
		if (args.plan) {
			if (hidden)
				for (const l of planLines)
					if (
						l.startsWith("distinct unmatched candidates") ||
						l.startsWith("anthropic calls allowed")
					)
						out(l);
			continue;
		}
		spent.anthropic += spend.anthropic;
		spent.openai += spend.openai;
		if (hidden) {
			out(
				code === 0
					? `fixture ${ref.id} (test split): verdicts recorded, details hidden until score --final`
					: `fixture ${ref.id} (test split): adjudication failed, details hidden until score --final`,
			);
		} else {
			visible.openai += spend.openai;
			const snapshot = snapshotId(fixture);
			const models = possibleFirstModels(fixtureFamily(fixture));
			const never = new Set(unjudgeable);
			for (const key of new Set(candidates.map((c) => claimKey(c))))
				if (
					!never.has(key) &&
					!isCurrentVerdict(cache.get(snapshot, key), models)
				)
					visible.deferred++;
		}
		if (code !== 0) {
			failed = true;
			break;
		}
	}
	out(
		args.plan
			? `total distinct candidates across fixtures: ${total}`
			: `total judge calls: anthropic=${spent.anthropic} openai=${visible.openai}, unjudged (deferred by cap): ${visible.deferred}${testRan ? " (test-split openai calls and deferred counts withheld)" : ""}`,
	);
	return failed ? 1 : 0;
}
