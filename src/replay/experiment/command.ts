import { join } from "node:path";
import { VerdictCache } from "../adjudication/cache.js";
import { type GhClient, ghCli } from "../gh.js";
import { buildLiveWiring } from "../live-wiring.js";
import { runStrategy } from "../run-strategy.js";
import { registerBuiltinStrategies } from "../strategies/index.js";
import { getStrategy } from "../strategy.js";
import type { LabelFile, ReplayFixture } from "../types.js";
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
		const grid = await planGrid(
			plan,
			runnerDeps({
				append: () => {},
				hasCell: () => false,
				readAll: () => ({ records: [], skipped: 0 }),
			}),
		);
		out(
			[
				`experiment plan ${hash}${plan.draft ? " (draft)" : ""}: ${grid.cells.length} cells`,
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
		const report = await runGrid(plan, runnerDeps(store), hash);
		out(
			[
				`ran ${report.ran} cell(s), ${report.skippedExisting} already stored`,
				`spent: anthropic $${report.spentUsd.anthropic.toFixed(2)}, openai $${report.spentUsd.openai.toFixed(2)}`,
				report.partial
					? `PARTIAL: ${report.missing.length} missing, ${report.overCellCap.length} over the cell cap, ${report.unavailable.length} without a checkout, ${report.failed.length} failed`
					: "complete",
				...report.failed.map(
					(f) => `failed ${f.strategy} ${f.fixtureId} r${f.round}: ${f.error}`,
				),
			].join("\n"),
		);
		return report.failed.length > 0 ? 1 : 0;
	}

	const testIds = plan.fixtures
		.filter((f) => f.split === "test")
		.map((f) => f.id);
	const baseline = "a";
	let seedGates: ReturnType<typeof readSeedGates>;
	try {
		seedGates = readSeedGates(deps.root, hash);
	} catch (err) {
		out(
			`cannot read seed-gates.json: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
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
	const report = formatScoreReport(
		scoreExperiment({
			plan,
			records,
			fixtures,
			cache: deps.cache,
			final: args.final,
			baseline,
			seedGates,
			exploratory,
		}),
		{ planHash: hash },
	);
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
					const labels = JSON.parse(
						await readFile(`${stem}.labels.json`, "utf8"),
					) as LabelFile;
					let wiring: ReturnType<typeof buildLiveWiring> | undefined;
					const entry: LoadedFixture & ScoredFixture = {
						fixture,
						labels,
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
