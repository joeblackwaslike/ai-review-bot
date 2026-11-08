import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditStored } from "../adjudication/audit.js";
import {
	auditDefectsFor,
	labelsHashOf,
} from "../adjudication/audit-defects.js";
import { VerdictCache } from "../adjudication/cache.js";
import { snapshotId } from "../adjudication/snapshot.js";
import { type GhClient, ghCli } from "../gh.js";
import { buildLiveWiring } from "../live-wiring.js";
import { runStrategy } from "../run-strategy.js";
import { registerBuiltinStrategies } from "../strategies/index.js";
import { getStrategy } from "../strategy.js";
import type { LabelFile, ReplayFixture } from "../types.js";
import { planChains, runChains } from "./chained.js";
import {
	exploratoryReason,
	FinalAlreadyScoredError,
	finalScored,
	writeFinalMarker,
} from "./final-guard.js";
import {
	assertCommittedPlan,
	type ExperimentPlan,
	loadPlan,
	planHash,
} from "./plan.js";
import { formatScoreReport } from "./report.js";
import {
	type LoadedFixture,
	type PlannedCell,
	planGrid,
	type RunnerDeps,
	runGrid,
} from "./runner.js";
import {
	type ScoredFixture,
	scoreExperiment,
	type VerdictLookup,
} from "./score.js";
import { readSeedGates } from "./seed-gates.js";
import { isDirectional } from "./splits.js";
import { defaultExperimentsDir, ResultsStore } from "./store.js";

/** The committed plan, found from the package root so a built `dist/` copy still resolves. */
export function defaultPlanFile(fromUrl: string): string {
	let dir = dirname(fileURLToPath(fromUrl));
	for (;;) {
		if (existsSync(join(dir, "package.json")))
			return join(dir, "docs", "review-experiments", "plan.json");
		const parent = dirname(dir);
		if (parent === dir)
			return join(process.cwd(), "docs", "review-experiments", "plan.json");
		dir = parent;
	}
}

export type ExperimentMode = "plan" | "run" | "score";

export interface ExperimentDeps {
	out: (s: string) => void;
	root: string;
	loadFixtures: (
		plan: ExperimentPlan,
	) => Promise<Record<string, LoadedFixture & ScoredFixture>>;
	registry: RunnerDeps["registry"];
	runStrategy: RunnerDeps["runStrategy"];
	cache: VerdictLookup;
	now: () => Date;
	withCheckout?: RunnerDeps["withCheckout"];
	modelFor?: RunnerDeps["modelFor"];
}

const cellLines = (label: string, cells: PlannedCell[]): string[] =>
	cells.map(
		(c) =>
			`${label} ${c.strategy} ${c.fixtureId} round ${c.round} trial ${c.trial}`,
	);

export async function runExperiment(
	args: { mode: ExperimentMode; planFile: string; final: boolean },
	deps: ExperimentDeps,
): Promise<number> {
	const { out } = deps;
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
	const hash = planHash(plan);

	if (args.mode !== "plan" || lockedHash !== null) {
		try {
			assertCommittedPlan(plan, lockedHash);
		} catch (err) {
			out(err instanceof Error ? err.message : String(err));
			return 1;
		}
	}
	if (args.mode !== "plan" && plan.draft) {
		out(
			"the plan is marked draft; nothing runs or scores until it is final and locked",
		);
		return 1;
	}

	const fixtures = await deps.loadFixtures(plan);
	const runnerDeps = (store: RunnerDeps["store"]): RunnerDeps => ({
		registry: deps.registry,
		fixtures,
		runStrategy: deps.runStrategy,
		store,
		now: deps.now,
		withCheckout: deps.withCheckout,
		modelFor: deps.modelFor,
		out,
	});

	if (args.mode === "plan") {
		const dry = runnerDeps({
			append: () => {},
			hasCell: () => false,
			readAll: () => ({ records: [], skipped: 0 }),
		});
		const isChained = plan.mode === "chained";
		const grid = isChained
			? await planChains(plan, dry)
			: await planGrid(plan, dry);
		const count = isChained
			? `${(grid as Awaited<ReturnType<typeof planChains>>).chains.length} chains`
			: `${(grid as Awaited<ReturnType<typeof planGrid>>).cells.length} cells`;
		out(
			[
				`experiment plan ${hash}${plan.draft ? " (draft)" : ""}: ${count}`,
				`estimated spend: anthropic $${grid.estimate.anthropic.toFixed(2)}, openai $${grid.estimate.openai.toFixed(2)}`,
				`caps: anthropic $${grid.caps.maxAnthropicUsd.toFixed(2)}, openai $${grid.caps.maxOpenAiUsd.toFixed(2)}, per cell $${grid.caps.perCellUsd.toFixed(2)}`,
				isDirectional(plan)
					? "directional: below 30 PRs, 10 per split or 5 repositories"
					: "meets the 30 PR, 10 per split, 5 repository minimum",
				"nothing was run",
			].join("\n"),
		);
		return 0;
	}

	const store = new ResultsStore(deps.root, hash);
	if (args.mode === "run") {
		const run = plan.mode === "chained" ? runChains : runGrid;
		const report = await run(plan, runnerDeps(store), hash);
		out(
			[
				`ran ${report.ran} cell(s), ${report.skippedExisting} already stored`,
				`spent: anthropic $${report.spentUsd.anthropic.toFixed(2)}, openai $${report.spentUsd.openai.toFixed(2)}`,
				report.partial
					? `PARTIAL: ${report.missing.length} missing, ${report.overCellCap.length} over the cell cap, ${report.overCap.length} overspent, ${report.unavailable.length} without a checkout, ${report.failed.length} failed`
					: "complete",
				...report.failed.map(
					(f) =>
						`failed ${f.strategy} ${f.fixtureId} round ${f.round} trial ${f.trial} (reserved $${f.reservedUsd.toFixed(2)}): ${f.error}`,
				),
				...cellLines("missing", report.missing),
				...cellLines("over the cell cap", report.overCellCap),
				...cellLines("no checkout", report.unavailable),
				...report.overCap.map(
					(c) =>
						`over cap ${c.strategy} ${c.fixtureId} round ${c.round} trial ${c.trial}: spent $${c.actualUsd.toFixed(2)} of $${c.allowedUsd.toFixed(2)} allowed`,
				),
			].join("\n"),
		);
		if (report.failed.length > 0) return 1;
		return report.partial ? 3 : 0;
	}

	const testIds = plan.fixtures
		.filter((f) => f.split === "test")
		.map((f) => f.id);
	const baseline = "a";
	if (!plan.strategies.some((s) => s.name === baseline)) {
		out(`the plan has no baseline strategy "${baseline}"; nothing was scored`);
		return 1;
	}
	let seedGates: ReturnType<typeof readSeedGates> = {};
	if (args.final) {
		try {
			seedGates = readSeedGates(deps.root, hash);
		} catch (err) {
			out(
				`cannot read seed-gates.json: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 1;
		}
	}
	if (args.final) {
		if (finalScored(deps.root, hash)) {
			out(
				`plan ${hash} already had its final scoring; revise the plan with fresh test PRs`,
			);
			return 1;
		}
		const lacking = plan.strategies
			.map((s) => s.name)
			.filter((n) => n !== baseline && !seedGates[n]);
		if (!isDirectional(plan) && lacking.length > 0) {
			out(
				`no seed gate result for ${lacking.join(", ")}; a final verdict needs one per candidate in ${join(deps.root, hash, "seed-gates.json")} (storing \`replay --seeds\` results there is phase 6). Nothing was scored and the one-shot final is still available`,
			);
			return 1;
		}
	}
	const exploratory = args.final
		? exploratoryReason(deps.root, hash, testIds)
		: null;
	const { records, skipped } = store.readAll(
		Object.fromEntries(
			plan.strategies.map((s) => [s.name, deps.registry(s.name).version]),
		),
	);
	if (skipped > 0) out(`${skipped} unreadable result line(s) skipped`);
	const scored = scoreExperiment({
		plan,
		records,
		fixtures,
		cache: deps.cache,
		final: args.final,
		baseline,
		seedGates,
		exploratory,
	});
	if (args.final && scored.partial) {
		out(
			scored.overCapCells > 0
				? `${scored.overCapCells} test cell(s) went over budget (overCap); a final verdict needs every cell inside its budget. Nothing was scored and the one-shot final is still available`
				: "the test grid is partial: planned test cells have no result. Run the grid to completion first; nothing was scored and the one-shot final is still available",
		);
		return 1;
	}
	const report = formatScoreReport(scored, {
		planHash: hash,
		hostedFitSeconds: plan.thresholds.hostedFitSeconds,
	});
	if (args.final) {
		try {
			writeFinalMarker(deps.root, hash, testIds, deps.now);
		} catch (err) {
			if (err instanceof FinalAlreadyScoredError) {
				out(err.message);
				return 1;
			}
			throw err;
		}
	}
	out(report);
	return 0;
}

export function realExperimentDeps(opts: {
	fixturesDir: string;
	out: (s: string) => void;
	client?: GhClient;
	adjudicationDir?: string;
}): ExperimentDeps {
	registerBuiltinStrategies();
	let client: GhClient | undefined = opts.client;
	const auditCache = new VerdictCache<AuditStored>(opts.adjudicationDir);
	return {
		out: opts.out,
		root: defaultExperimentsDir(),
		registry: getStrategy,
		runStrategy,
		cache: new VerdictCache(opts.adjudicationDir),
		now: () => new Date(),
		loadFixtures: async (plan) => {
			const { readFile } = await import("node:fs/promises");
			const entries = await Promise.all(
				plan.fixtures.map(async (f) => {
					const m = f.id.match(/^([^/]+)\/([^#]+)#(\d+)(?:@\w+)?$/);
					if (!m) throw new Error(`bad fixture id ${f.id}`);
					const stem = join(
						opts.fixturesDir,
						`${m[1]}__${m[2]}__${m[3]}__${f.provider}`,
					);
					const fixture = JSON.parse(
						await readFile(`${stem}.json`, "utf8"),
					) as ReplayFixture;
					const labelsText = await readFile(`${stem}.labels.json`, "utf8");
					const labels = JSON.parse(labelsText) as LabelFile;
					let wiring: ReturnType<typeof buildLiveWiring> | undefined;
					const entry: LoadedFixture & ScoredFixture = {
						fixture,
						labels,
						extraDefects: auditDefectsFor(
							auditCache,
							snapshotId(fixture),
							labelsHashOf(labelsText),
						),
						fetchDiff: (round) => {
							client ??= ghCli();
							wiring ??= buildLiveWiring(fixture, client);
							return wiring.fetchDiff(round);
						},
					};
					return [f.id, entry] as const;
				}),
			);
			return Object.fromEntries(entries);
		},
	};
}
