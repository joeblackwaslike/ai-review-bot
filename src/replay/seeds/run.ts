import { runStrategy } from "../run-strategy.js";
import type { ReviewStrategy, StrategyInput } from "../strategy.js";
import { type SeedReviewInput, seedReviewInput, truthInDiff } from "./input.js";
import { DEFAULT_SEEDS_ROOT, listSeeds, type Seed } from "./schema.js";
import { type SeedOutcome, scoreSeed, seedGate } from "./score.js";

const SEED_WALL_MS = 210_000;

export interface SeedRunOptions {
	root?: string;
	out: (s: string) => void;
}

export interface SeedStrategyOptions extends SeedRunOptions {
	maxCostUsd: number;
}

const message = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

function strategyInput(
	input: SeedReviewInput,
	maxUsd: number,
	checkout: boolean,
): StrategyInput {
	return {
		fixture: input.fixture,
		round: input.round,
		diff: input.diff,
		files: input.files,
		approximateDiff: false,
		checkout: checkout ? input.checkout : null,
		history: { ledger: [] },
		budget: { maxUsd, maxWallMs: SEED_WALL_MS },
		signal: AbortSignal.timeout(SEED_WALL_MS),
	};
}

async function withInput<T>(
	seed: Seed,
	fn: (input: SeedReviewInput) => Promise<T>,
): Promise<T> {
	const input = await seedReviewInput(seed);
	try {
		return await fn(input);
	} finally {
		await input.cleanup();
	}
}

/** Loads every seed, or prints why not and returns null (also when there are none). */
async function loadAll(opts: SeedRunOptions): Promise<Seed[] | null> {
	let seeds: Seed[];
	try {
		seeds = await listSeeds(opts.root);
	} catch (err) {
		opts.out(`seed load failed: ${message(err)}`);
		return null;
	}
	if (seeds.length === 0) {
		opts.out(`no seeds found under ${opts.root ?? DEFAULT_SEEDS_ROOT}`);
		return null;
	}
	return seeds;
}

/** Validates every seed offline: it loads, materialises and its defect is inside the diff. */
export async function checkSeeds(opts: SeedRunOptions): Promise<number> {
	const seeds = await loadAll(opts);
	if (!seeds) return 1;
	let failed = 0;
	for (const seed of seeds) {
		try {
			await withInput(seed, async (input) => {
				if (!truthInDiff(seed, input.files))
					throw new Error("defect range is not on lines the diff shows");
			});
		} catch (err) {
			failed++;
			opts.out(`FAIL ${seed.id}: ${message(err)}`);
		}
	}
	const clean = seeds.filter((s) => s.truth.clean).length;
	opts.out(
		`${seeds.length} seeds (${seeds.length - clean} defect, ${clean} clean), ${failed} failed`,
	);
	return failed === 0 ? 0 : 1;
}

/** Prints the seed count, the strategy and the estimated cost. Never runs the strategy. */
export async function planSeeds(
	strategy: ReviewStrategy,
	opts: SeedRunOptions,
): Promise<number> {
	const seeds = await loadAll(opts);
	if (!seeds) return 1;
	let total = 0;
	try {
		for (const seed of seeds) {
			total += await withInput(seed, async (input) =>
				strategy.estimateCost(
					strategyInput(input, Number.POSITIVE_INFINITY, false),
				),
			);
		}
	} catch (err) {
		opts.out(`seed plan failed: ${message(err)}`);
		return 1;
	}
	opts.out(
		`${seeds.length} seeds, strategy ${strategy.name}@${strategy.version}, estimated cost $${total.toFixed(2)}`,
	);
	return 0;
}

/**
 * Runs the strategy over every seed through the live-tier input shape, scores the posted
 * findings exactly, prints the table and the gate. Exits 1 when the gate fails or the cost
 * cap stops the run before every seed ran.
 */
export async function runSeedsWithStrategy(
	strategy: ReviewStrategy,
	opts: SeedStrategyOptions,
): Promise<number> {
	const seeds = await loadAll(opts);
	if (!seeds) return 1;
	const results: { seed: Seed; outcome: SeedOutcome }[] = [];
	let spent = 0;
	let stopped = false;
	for (const seed of seeds) {
		try {
			const outcome = await withInput(seed, async (input) => {
				const remaining = opts.maxCostUsd - spent;
				const estimate = strategy.estimateCost(
					strategyInput(input, remaining, false),
				);
				if (!Number.isFinite(estimate) || estimate < 0)
					throw new Error(`invalid cost estimate ${estimate}`);
				if (spent + estimate > opts.maxCostUsd) return null;
				spent += estimate;
				const result = await runStrategy(
					strategy,
					strategyInput(input, remaining, strategy.needsCheckout),
				);
				return scoreSeed(seed, result.posted);
			});
			if (outcome === null) {
				stopped = true;
				opts.out(
					`stopping before ${seed.id}: ${results.length} of ${seeds.length} seeds run (cost cap $${opts.maxCostUsd.toFixed(2)})`,
				);
				break;
			}
			results.push({ seed, outcome });
			opts.out(
				`${seed.id.padEnd(16)} ${outcome.outcome.padEnd(15)} extra findings: ${outcome.extraFindings}`,
			);
		} catch (err) {
			opts.out(`seed run failed for ${seed.id}: ${message(err)}`);
			return 1;
		}
	}
	const gate = seedGate(results);
	opts.out(
		`gate: ${gate.pass ? "pass" : "fail"} (originals missed ${gate.originalsMissed}, clean control findings ${gate.cleanFindings})`,
	);
	for (const reason of gate.reasons) opts.out(`  ${reason}`);
	return gate.pass && !stopped ? 0 : 1;
}
