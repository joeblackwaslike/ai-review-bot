import type { PullFile } from "../../review.js";
import { routeModel } from "../../router.js";
import {
	isCheckoutUnavailable,
	withCheckout as realWithCheckout,
} from "../checkout.js";
import { roundCostUsd } from "../cost.js";
import { freezeFixture } from "../frozen.js";
import { routerContext } from "../live-wiring.js";
import type { runStrategy as runStrategyFn } from "../run-strategy.js";
import type { ReviewStrategy, StrategyInput } from "../strategy.js";
import { ledgerForRound } from "../trace.js";
import type { LabelFile, Provider, ReplayFixture, Round } from "../types.js";
import { mulberry32 } from "./bootstrap.js";
import type { ExperimentPlan } from "./plan.js";
import type { CellKey, CellRecord, ResultsStore } from "./store.js";

export interface LoadedFixture {
	fixture: ReplayFixture;
	labels: LabelFile;
	fetchDiff: (
		round: Round,
	) => Promise<{ diff: string; files: PullFile[]; approximate: boolean }>;
}

export interface RunnerDeps {
	registry: (name: string) => ReviewStrategy;
	fixtures: Record<string, LoadedFixture>;
	runStrategy: typeof runStrategyFn;
	store: Pick<ResultsStore, "append" | "hasCell" | "readAll">;
	now: () => Date;
	withCheckout?: typeof realWithCheckout;
	modelFor?: (input: StrategyInput) => string;
	out?: (s: string) => void;
}

export interface PlannedCell {
	strategy: string;
	fixtureId: string;
	round: number;
	trial: number;
}

export interface GridPlan {
	cells: PlannedCell[];
	estimate: Record<Provider, number>;
	caps: { maxAnthropicUsd: number; maxOpenAiUsd: number; perCellUsd: number };
}

export interface GridReport {
	ran: number;
	skippedExisting: number;
	missing: PlannedCell[];
	overCellCap: PlannedCell[];
	refused: PlannedCell[];
	unavailable: PlannedCell[];
	failed: (PlannedCell & { error: string })[];
	spentUsd: Record<Provider, number>;
	partial: boolean;
}

const A = "a";
const A0 = "a0";

function shuffled<T>(items: T[], seed: string): T[] {
	const out = [...items];
	const rand = mulberry32(seed);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

function resolveStrategies(
	plan: ExperimentPlan,
	deps: RunnerDeps,
): ReviewStrategy[] {
	const resolved = plan.strategies.map((p) => {
		const s = deps.registry(p.name);
		if (s.version !== p.version)
			throw new Error(
				`strategy ${p.name} version ${s.version} differs from the plan's ${p.version}`,
			);
		return s;
	});
	if (
		resolved.some((s) => s.name === A0) &&
		!resolved.some((s) => s.name === A)
	)
		throw new Error(`strategy "${A0}" requires "${A}" in the same plan`);
	const rank = (s: ReviewStrategy) => (s.name === A0 ? 1 : 0);
	return [...resolved].sort((x, y) => rank(x) - rank(y));
}

const unitKey = (u: Omit<PlannedCell, "strategy">) =>
	`${u.fixtureId}\u0000${u.round}\u0000${u.trial}`;

function unitsOf(plan: ExperimentPlan, deps: RunnerDeps) {
	const units: Omit<PlannedCell, "strategy">[] = [];
	for (const f of [...plan.fixtures].sort((a, b) => (a.id < b.id ? -1 : 1))) {
		const loaded = deps.fixtures[f.id];
		if (!loaded) throw new Error(`fixture not loaded: ${f.id}`);
		for (const r of loaded.fixture.rounds)
			for (let trial = 0; trial < plan.trials; trial++)
				units.push({ fixtureId: f.id, round: r.index, trial });
	}
	return shuffled(units, plan.seed);
}

class InputBuilder {
	private readonly diffs = new Map<
		string,
		Promise<Awaited<ReturnType<LoadedFixture["fetchDiff"]>>>
	>();

	constructor(private readonly deps: RunnerDeps) {}

	async build(
		fixtureId: string,
		roundIndex: number,
		plan: ExperimentPlan,
		extra: { spendTargetUsd?: number },
	): Promise<{ input: StrategyInput; round: Round; loaded: LoadedFixture }> {
		const loaded = this.deps.fixtures[fixtureId] as LoadedFixture;
		const round = loaded.fixture.rounds.find(
			(r) => r.index === roundIndex,
		) as Round;
		const id = `${fixtureId}\u0000${roundIndex}`;
		let pending = this.diffs.get(id);
		if (!pending) {
			pending = loaded.fetchDiff(round);
			this.diffs.set(id, pending);
		}
		const d = await pending;
		const input: StrategyInput = {
			fixture: freezeFixture(loaded.fixture, roundIndex),
			round: { ...round, claims: [], trace: undefined },
			diff: d.diff,
			files: d.files,
			approximateDiff: d.approximate,
			checkout: null,
			history: { ledger: ledgerForRound(loaded.fixture, loaded.labels, round) },
			budget: {
				maxUsd: plan.budgets.perCellUsd,
				maxWallMs: plan.budgets.perCellWallMs,
			},
			signal: AbortSignal.timeout(plan.budgets.perCellWallMs),
			...(extra.spendTargetUsd !== undefined
				? {
						spendTargetUsd: extra.spendTargetUsd,
						tolerance: plan.a0Tolerance,
					}
				: {}),
		};
		return { input, round, loaded };
	}
}

const capFor = (plan: ExperimentPlan, p: Provider): number =>
	p === "anthropic" ? plan.budgets.maxAnthropicUsd : plan.budgets.maxOpenAiUsd;

const splitOfFixture = (plan: ExperimentPlan, id: string) =>
	plan.fixtures.find((f) => f.id === id)?.split;

const refusedOpenAi = (plan: ExperimentPlan, id: string, p: Provider) =>
	p === "openai" && splitOfFixture(plan, id) !== "test";

export async function planGrid(
	plan: ExperimentPlan,
	deps: RunnerDeps,
): Promise<GridPlan> {
	const strategies = resolveStrategies(plan, deps);
	const builder = new InputBuilder(deps);
	const cells: PlannedCell[] = [];
	const estimate: Record<Provider, number> = { anthropic: 0, openai: 0 };
	for (const u of unitsOf(plan, deps)) {
		const provider = (deps.fixtures[u.fixtureId] as LoadedFixture).fixture
			.provider;
		if (!plan.providers.includes(provider)) continue;
		if (refusedOpenAi(plan, u.fixtureId, provider)) continue;
		let aEstimate: number | undefined;
		for (const s of strategies) {
			const { input } = await builder.build(u.fixtureId, u.round, plan, {
				spendTargetUsd: s.name === A0 ? aEstimate : undefined,
			});
			const e = s.estimateCost(input);
			if (s.name === A) aEstimate = e;
			estimate[provider] += e;
			cells.push({ strategy: s.name, ...u });
		}
	}
	return {
		cells,
		estimate,
		caps: {
			maxAnthropicUsd: plan.budgets.maxAnthropicUsd,
			maxOpenAiUsd: plan.budgets.maxOpenAiUsd,
			perCellUsd: plan.budgets.perCellUsd,
		},
	};
}

export async function runGrid(
	plan: ExperimentPlan,
	deps: RunnerDeps,
	planHashValue = "",
): Promise<GridReport> {
	const out = deps.out ?? ((s: string) => console.log(s));
	const strategies = resolveStrategies(plan, deps);
	const builder = new InputBuilder(deps);
	const checkoutFor = deps.withCheckout ?? realWithCheckout;
	const modelFor =
		deps.modelFor ??
		((i: StrategyInput) =>
			routeModel(routerContext(i.files), i.fixture.provider).model);

	const stored = deps.store.readAll().records;
	const spentUsd: Record<Provider, number> = { anthropic: 0, openai: 0 };
	for (const r of stored) spentUsd[r.provider] += r.costUsd;
	const report: GridReport = {
		ran: 0,
		skippedExisting: 0,
		missing: [],
		overCellCap: [],
		refused: [],
		unavailable: [],
		failed: [],
		spentUsd,
		partial: false,
	};
	let stopped = false;

	for (const u of unitsOf(plan, deps)) {
		const loaded = deps.fixtures[u.fixtureId] as LoadedFixture;
		const provider = loaded.fixture.provider;
		if (!plan.providers.includes(provider)) continue;
		let aCost: number | undefined;

		for (const s of strategies) {
			const cell: PlannedCell = { strategy: s.name, ...u };
			const key: CellKey = {
				strategy: s.name,
				version: s.version,
				fixtureId: u.fixtureId,
				round: u.round,
				trial: u.trial,
			};
			if (refusedOpenAi(plan, u.fixtureId, provider)) {
				report.refused.push(cell);
				continue;
			}
			if (deps.store.hasCell(key)) {
				report.skippedExisting++;
				if (s.name === A)
					aCost = stored.find(
						(r) => unitKey({ ...r.key }) === unitKey(u) && r.key.strategy === A,
					)?.costUsd;
				continue;
			}
			if (stopped || (s.name === A0 && aCost === undefined)) {
				report.missing.push(cell);
				continue;
			}

			const { input, round } = await builder.build(u.fixtureId, u.round, plan, {
				spendTargetUsd: s.name === A0 ? aCost : undefined,
			});
			const estimate = s.estimateCost(input);
			if (!Number.isFinite(estimate) || estimate < 0)
				throw new Error(`invalid cost estimate ${estimate} for ${s.name}`);
			if (estimate > plan.budgets.perCellUsd) {
				report.overCellCap.push(cell);
				continue;
			}
			if (spentUsd[provider] + estimate > capFor(plan, provider)) {
				stopped = true;
				out(
					`experiment: ${provider} cap $${capFor(plan, provider).toFixed(2)} reached; stopping`,
				);
				report.missing.push(cell);
				continue;
			}

			try {
				const run = (i: StrategyInput) => deps.runStrategy(s, i);
				const ran = s.needsCheckout
					? await checkoutFor(
							{
								owner: loaded.fixture.owner,
								repo: loaded.fixture.repo,
								baseSha: round.mergeBase ?? round.baseSha,
								headSha: round.headSha,
							},
							(handle) => run({ ...input, checkout: handle }),
						)
					: await run(input);
				if (isCheckoutUnavailable(ran)) {
					report.unavailable.push(cell);
					continue;
				}
				const costUsd = roundCostUsd(ran.usage, modelFor(input));
				spentUsd[provider] += costUsd;
				if (s.name === A) aCost = costUsd;
				const record: CellRecord = {
					key,
					provider,
					planHash: planHashValue,
					at: deps.now().toISOString(),
					costUsd,
					fitIn210s: ran.wallMs <= plan.thresholds.hostedFitSeconds * 1000,
					failedAttempts: ran.spend?.failedAttempts ?? 0,
					cacheTemperature: "unknown",
					result: {
						findings: ran.findings,
						candidates: ran.candidates,
						posted: ran.posted,
						agentReviews: ran.agentReviews,
						usage: ran.usage,
						toolCalls: ran.toolCalls,
						wallMs: ran.wallMs,
						spend: ran.spend,
					},
				};
				deps.store.append(record);
				report.ran++;
			} catch (err) {
				report.failed.push({
					...cell,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	report.partial =
		report.missing.length > 0 ||
		report.overCellCap.length > 0 ||
		report.unavailable.length > 0 ||
		report.failed.length > 0;
	return report;
}
