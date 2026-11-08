import { routeReviewerModel } from "../../router.js";
import { withCheckout as realWithCheckout } from "../checkout.js";
import { requireCost } from "../cost.js";
import { routerContext } from "../live-wiring.js";
import type { StrategyInput } from "../strategy.js";
import { ledgerFromPosted } from "../trace.js";
import {
	type CandidateRecord,
	fixtureFamily,
	fixtureReviewer,
	type Provider,
} from "../types.js";
import type { ExperimentPlan } from "./plan.js";
import {
	capFor,
	executeCell,
	type GridReport,
	InputBuilder,
	type LoadedFixture,
	type PlannedCell,
	type RunnerDeps,
	refusedOpenAi,
	resolveStrategies,
	shuffled,
} from "./runner.js";
import type { CellKey } from "./store.js";

const A = "a";
const A0 = "a0";

export interface PlannedChain {
	strategy: string;
	fixtureId: string;
	trial: number;
	rounds: number;
}

export interface ChainPlan {
	chains: PlannedChain[];
	estimate: Record<Provider, number>;
	caps: { maxAnthropicUsd: number; maxOpenAiUsd: number; perCellUsd: number };
}

function chainUnits(plan: ExperimentPlan, deps: RunnerDeps) {
	const units: { fixtureId: string; trial: number }[] = [];
	for (const f of [...plan.fixtures].sort((a, b) => (a.id < b.id ? -1 : 1))) {
		if (!deps.fixtures[f.id]) throw new Error(`fixture not loaded: ${f.id}`);
		for (let trial = 0; trial < plan.trials; trial++)
			units.push({ fixtureId: f.id, trial });
	}
	return shuffled(units, plan.seed);
}

const roundIndexes = (l: LoadedFixture) =>
	l.fixture.rounds.map((r) => r.index).sort((a, b) => a - b);

export async function planChains(
	plan: ExperimentPlan,
	deps: RunnerDeps,
): Promise<ChainPlan> {
	const strategies = resolveStrategies(plan, deps);
	const builder = new InputBuilder(deps);
	const chains: PlannedChain[] = [];
	const estimate: Record<Provider, number> = { anthropic: 0, openai: 0 };
	for (const u of chainUnits(plan, deps)) {
		const loaded = deps.fixtures[u.fixtureId] as LoadedFixture;
		const provider = fixtureFamily(loaded.fixture);
		if (!plan.providers.includes(provider)) continue;
		if (refusedOpenAi(plan, u.fixtureId, provider)) continue;
		const rounds = roundIndexes(loaded);
		const aEstimates = new Map<number, number>();
		for (const s of strategies) {
			for (const r of rounds) {
				const { input } = await builder.build(u.fixtureId, r, plan, {
					spendTargetUsd: s.name === A0 ? aEstimates.get(r) : undefined,
				});
				const e = requireCost(s.estimateCost(input), `strategy ${s.name}`);
				if (s.name === A) aEstimates.set(r, e);
				estimate[provider] += e;
			}
			chains.push({
				strategy: s.name,
				fixtureId: u.fixtureId,
				trial: u.trial,
				rounds: rounds.length,
			});
		}
	}
	return {
		chains,
		estimate,
		caps: {
			maxAnthropicUsd: plan.budgets.maxAnthropicUsd,
			maxOpenAiUsd: plan.budgets.maxOpenAiUsd,
			perCellUsd: plan.budgets.perCellUsd,
		},
	};
}

export async function runChains(
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
			routeReviewerModel(routerContext(i.files), fixtureReviewer(i.fixture))
				.selection.model);

	const stored = deps.store.readAll().records;
	const spentUsd: Record<Provider, number> = { anthropic: 0, openai: 0 };
	for (const r of stored) spentUsd[r.provider] += r.costUsd;
	const report: GridReport = {
		ran: 0,
		skippedExisting: 0,
		missing: [],
		overCellCap: [],
		overCap: [],
		refused: [],
		unavailable: [],
		failed: [],
		spentUsd,
		partial: false,
	};
	for (const r of stored)
		if (r.overCap)
			report.overCap.push({
				strategy: r.key.strategy,
				fixtureId: r.key.fixtureId,
				round: r.key.round,
				trial: r.key.trial,
				...r.overCap,
			});
	const stoppedProviders = new Set<Provider>();

	for (const u of chainUnits(plan, deps)) {
		const loaded = deps.fixtures[u.fixtureId] as LoadedFixture;
		const provider = fixtureFamily(loaded.fixture);
		if (!plan.providers.includes(provider)) continue;
		const rounds = roundIndexes(loaded);
		const refused = refusedOpenAi(plan, u.fixtureId, provider);
		const stoppedStrategies = new Set<string>();
		const own = new Map<
			string,
			{ roundIndex: number; posted: CandidateRecord[] }[]
		>();
		const aCosts = new Map<number, number>();

		for (const roundIndex of rounds) {
			for (const s of strategies) {
				const cell: PlannedCell = {
					strategy: s.name,
					fixtureId: u.fixtureId,
					round: roundIndex,
					trial: u.trial,
				};
				const key: CellKey = {
					strategy: s.name,
					version: s.version,
					fixtureId: u.fixtureId,
					round: roundIndex,
					trial: u.trial,
				};
				if (refused) {
					report.refused.push(cell);
					continue;
				}
				const history = own.get(s.name) ?? [];
				own.set(s.name, history);
				const prior = stored.find(
					(r) =>
						r.key.strategy === s.name &&
						r.key.version === s.version &&
						r.key.fixtureId === u.fixtureId &&
						r.key.round === roundIndex &&
						r.key.trial === u.trial,
				);
				if (prior) {
					report.skippedExisting++;
					history.push({ roundIndex, posted: prior.result.posted });
					if (s.name === A) aCosts.set(roundIndex, prior.costUsd);
					continue;
				}
				if (
					stoppedProviders.has(provider) ||
					stoppedStrategies.has(s.name) ||
					(s.name === A0 && !aCosts.has(roundIndex))
				) {
					report.missing.push(cell);
					continue;
				}

				const round = loaded.fixture.rounds.find(
					(r) => r.index === roundIndex,
				) as (typeof loaded.fixture.rounds)[number];
				const { input } = await builder.build(u.fixtureId, roundIndex, plan, {
					spendTargetUsd: s.name === A0 ? aCosts.get(roundIndex) : undefined,
					ledger: ledgerFromPosted(
						loaded.fixture,
						loaded.labels,
						round,
						history,
					),
				});
				const estimate = requireCost(
					s.estimateCost(input),
					`strategy ${s.name}`,
				);
				if (!Number.isFinite(estimate) || estimate < 0)
					throw new Error(`invalid cost estimate ${estimate} for ${s.name}`);
				if (estimate > plan.budgets.perCellUsd) {
					report.overCellCap.push(cell);
					stoppedStrategies.add(s.name);
					continue;
				}
				if (spentUsd[provider] + estimate > capFor(plan, provider)) {
					stoppedProviders.add(provider);
					out(
						`experiment: ${provider} cap $${capFor(plan, provider).toFixed(2)} reached; stopping`,
					);
					report.missing.push(cell);
					continue;
				}

				const allowedUsd = Math.min(
					plan.budgets.perCellUsd,
					capFor(plan, provider) - spentUsd[provider],
				);
				input.budget = { ...input.budget, maxUsd: allowedUsd };
				try {
					const done = await executeCell({
						strategy: s,
						input,
						loaded,
						round,
						provider,
						key,
						allowedUsd,
						plan,
						deps,
						planHashValue,
						modelFor,
						checkoutFor,
					});
					if (done === "unavailable") {
						report.unavailable.push(cell);
						stoppedStrategies.add(s.name);
						continue;
					}
					spentUsd[provider] += done.record.costUsd;
					if (s.name === A) aCosts.set(roundIndex, done.record.costUsd);
					if (done.record.overCap) {
						report.overCap.push({ ...cell, ...done.record.overCap });
						stoppedStrategies.add(s.name);
					}
					deps.store.append(done.record);
					history.push({ roundIndex, posted: done.result.posted });
					report.ran++;
				} catch (err) {
					spentUsd[provider] += estimate;
					stoppedStrategies.add(s.name);
					report.failed.push({
						...cell,
						reservedUsd: estimate,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}
	}

	report.partial =
		report.missing.length > 0 ||
		report.overCellCap.length > 0 ||
		report.overCap.length > 0 ||
		report.unavailable.length > 0 ||
		report.failed.length > 0;
	return report;
}
