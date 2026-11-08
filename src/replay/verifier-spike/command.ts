import type { computeCost } from "../../models.js";
import { type FileFetcher, fetchHeadFile } from "./files.js";
import { judgesFor } from "./model.js";
import { type RunOptions, runSpike } from "./run.js";
import { formatSpikeReport, scoreSpike } from "./score.js";
import { selectItems } from "./select.js";
import type { SpikeItem, SpikeJudge, Tier } from "./types.js";

export interface SpikeArgs {
	tiers: Tier[];
	plan: boolean;
	json: boolean;
	maxCostUsd: number;
	fixtures?: string;
	cacheDir?: string;
}

const DEFAULT_MAX_COST_USD = 10;
const PLAN_INPUT_TOKENS = 12_000;
const PLAN_OUTPUT_TOKENS = 150;

export function parseSpikeArgs(args: string[]): SpikeArgs | { error: string } {
	const parsed: SpikeArgs = {
		tiers: ["cheap", "mid"],
		plan: false,
		json: false,
		maxCostUsd: DEFAULT_MAX_COST_USD,
	};
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--plan") parsed.plan = true;
		else if (flag === "--json") parsed.json = true;
		else if (
			flag === "--tier" ||
			flag === "--max-cost" ||
			flag === "--cache" ||
			flag === "--fixtures"
		) {
			const value = args[++i];
			if (value === undefined || value.startsWith("--"))
				return { error: `${flag} requires a value` };
			if (flag === "--tier") {
				if (value !== "cheap" && value !== "mid")
					return { error: "--tier must be cheap or mid" };
				parsed.tiers = [value];
			} else if (flag === "--max-cost") {
				const n = Number(value);
				if (!Number.isFinite(n) || n <= 0)
					return { error: "--max-cost must be a positive number of dollars" };
				parsed.maxCostUsd = n;
			} else if (flag === "--cache") parsed.cacheDir = value;
			else parsed.fixtures = value;
		} else return { error: `Unexpected argument: ${flag}` };
	}
	return parsed;
}

export interface SpikeDeps {
	fixturesDir: string;
	cacheDir: string;
	out: (line: string) => void;
	fetchFile: FileFetcher;
	call: RunOptions["call"];
	costOf: typeof computeCost;
	/** Calls in flight at once; the cost cap can be overshot by up to this many calls. */
	concurrency?: number;
}

const USAGE =
	"usage: ai-review verifier-spike [--tier cheap|mid] [--max-cost <usd>] [--plan] [--json] [--fixtures <dir>] [--cache <dir>]";

function uniqueJudges(items: SpikeItem[], tiers: Tier[]): SpikeJudge[] {
	const byId = new Map<string, SpikeJudge>();
	for (const item of items)
		for (const j of judgesFor(item, tiers)) byId.set(j.id, j);
	return [...byId.values()];
}

function plan(items: SpikeItem[], tiers: Tier[], deps: SpikeDeps): void {
	const calls = new Map<string, { judge: SpikeJudge; n: number }>();
	for (const item of items)
		for (const j of judgesFor(item, tiers)) {
			const entry = calls.get(j.id) ?? { judge: j, n: 0 };
			entry.n += 1;
			calls.set(j.id, entry);
		}
	const total = [...calls.values()].reduce((sum, c) => sum + c.n, 0);
	deps.out(
		`Verifier spike plan: ${items.length} findings, ${total} calls (a rough estimate assumes ${PLAN_INPUT_TOKENS} input and ${PLAN_OUTPUT_TOKENS} output tokens per call).`,
	);
	let sum = 0;
	let known = true;
	for (const { judge, n } of calls.values()) {
		const each = deps.costOf(
			{ promptTokens: PLAN_INPUT_TOKENS, completionTokens: PLAN_OUTPUT_TOKENS },
			judge.model,
		);
		if (each === undefined) known = false;
		else sum += each * n;
		deps.out(
			`  ${judge.id} (${judge.model}): ${n} calls, ${each === undefined ? "cost unknown" : `about $${(each * n).toFixed(2)}`}`,
		);
	}
	deps.out(
		known
			? `Estimated total: about $${sum.toFixed(2)}.`
			: "Estimated total: unknown, a model has no price.",
	);
}

/** Returns the exit code: 0 done, 2 bad arguments, 3 stopped early by the cost cap. */
export async function runVerifierSpike(
	args: string[],
	deps: SpikeDeps,
): Promise<number> {
	const parsed = parseSpikeArgs(args);
	if ("error" in parsed) {
		deps.out(`${parsed.error}\n${USAGE}`);
		return 2;
	}
	const { items, skipped } = selectItems(parsed.fixtures ?? deps.fixturesDir);
	if (items.length === 0) {
		deps.out("no fixed or rejected labelled findings with a file path found");
		return 1;
	}
	if (parsed.plan) {
		plan(items, parsed.tiers, deps);
		return 0;
	}
	const unpriced = uniqueJudges(items, parsed.tiers).filter(
		(j) =>
			deps.costOf({ promptTokens: 1000, completionTokens: 1 }, j.model) ===
			undefined,
	);
	if (unpriced.length > 0) {
		deps.out(
			`no price for ${unpriced.map((j) => j.model).join(", ")}; the cost cap cannot hold without one, so nothing was run`,
		);
		return 1;
	}
	const cacheDir = parsed.cacheDir ?? deps.cacheDir;
	const summary = await runSpike({
		items,
		judgesFor: (item) => judgesFor(item, parsed.tiers),
		fileFor: (item) =>
			fetchHeadFile(
				{
					owner: item.owner,
					repo: item.repo,
					path: item.path,
					sha: item.headSha,
				},
				deps.fetchFile,
				cacheDir,
			),
		call: deps.call,
		cacheDir,
		maxCostUsd: parsed.maxCostUsd,
		concurrency: deps.concurrency,
	});
	const cells = scoreSpike(
		items,
		uniqueJudges(items, parsed.tiers),
		summary.results,
	);
	if (parsed.json) {
		deps.out(
			JSON.stringify(
				{
					items: items.length,
					skipped,
					spentUsd: summary.spentUsd,
					capped: summary.capped,
					cells,
					findings: items.map((i) => ({
						id: i.id,
						producer: i.producer,
						label: i.label,
						confirmed: i.confirmed,
						severity: i.severity,
						path: i.path,
						line: i.line,
						title: i.title,
					})),
					results: summary.results,
				},
				null,
				2,
			),
		);
	} else {
		deps.out(
			`Verifier spike: ${items.length} findings, spent $${summary.spentUsd.toFixed(2)} this run.\n`,
		);
		deps.out(formatSpikeReport(cells));
		if (summary.capped)
			deps.out(
				`\nStopped at the cost cap ($${parsed.maxCostUsd}); calls already in flight can push the spend a little past it. Rerun with a higher --max-cost to continue from the cache.`,
			);
	}
	return summary.capped ? 3 : 0;
}
