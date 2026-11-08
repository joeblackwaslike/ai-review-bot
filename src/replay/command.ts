import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type LegacyProvider,
	type ReviewerId,
	reviewerFromLegacy,
} from "../reviewer-id.js";
import type { ModelSelection } from "../router.js";
import { adaptiveReport } from "./adaptive-report.js";
import { isCurrentVerdict } from "./adjudication/adjudicate.js";
import { VerdictCache } from "./adjudication/cache.js";
import { possibleFirstModels } from "./adjudication/judge.js";
import {
	type AdjudicationJudges,
	DEFAULT_MAX_ANTHROPIC,
	DEFAULT_MAX_OPENAI,
	runAdjudication,
} from "./adjudication/run.js";
import { claimKey, snapshotId } from "./adjudication/snapshot.js";
import { fixtureId } from "./claims.js";
import {
	type ClassFile,
	formatClassReport,
	summarizeClasses,
} from "./classify.js";
import {
	defaultPlanFile,
	type ExperimentDeps,
	type ExperimentMode,
	realExperimentDeps,
	runExperiment,
} from "./experiment/command.js";
import { writeSeedGate } from "./experiment/seed-gates.js";
import { defaultExperimentsDir } from "./experiment/store.js";
import { filterMargin, formatMargin } from "./filter-margin.js";
import { type GhClient, ghCli } from "./gh.js";
import { checkClean, checkRecall } from "./guard.js";
import {
	formatInvestigation,
	investigateJoin,
	type JoinJudge,
	modelJudge,
} from "./join-investigation.js";
import { labelFixture } from "./label.js";
import {
	InvalidEstimateError,
	type LiveReport,
	LiveRunError,
	runLiveTier,
} from "./live.js";
import { buildLiveWiring as defaultLiveWiring } from "./live-wiring.js";
import { computeMetrics, formatReport } from "./metrics.js";
import { type ReplayPipeline, todaysCodePipeline } from "./pipeline.js";
import { recordPr } from "./record.js";
import { replayFixture } from "./replay.js";
import { checkSeeds, planSeeds, runSeedsWithStrategy } from "./seeds/run.js";
import { registerBuiltinStrategies } from "./strategies/index.js";
import {
	getStrategy,
	type ReviewStrategy,
	UnknownStrategyError,
} from "./strategy.js";
import {
	fixtureReviewer,
	type LabelFile,
	type ReplayFixture,
} from "./types.js";

export interface ReplayDeps {
	client?: GhClient;
	fixturesDir?: string;
	out?: (s: string) => void;
	pipeline?: ReplayPipeline;
	liveWiring?: typeof defaultLiveWiring;
	/** Builds the judge for a model family; the default resolves real credentials. */
	joinJudge?: (family: LegacyProvider) => Promise<JoinJudge>;
	/** Judges for `--adjudicate`; the default builds real models only after `--plan` is ruled out. */
	adjudicationJudges?: AdjudicationJudges | (() => Promise<AdjudicationJudges>);
	adjudicationDir?: string;
	/** Seed root for `--seeds`; defaults to the committed seeds. */
	seedsRoot?: string;
	/** Experiments root for `--gate-plan`; defaults to `defaultExperimentsDir()`. */
	experimentsDir?: string;
	experiment?: ExperimentDeps;
}

interface ParsedArgs {
	record?: string;
	reviewer?: ReviewerId;
	bot?: string;
	fixtures?: string;
	live?: boolean;
	rounds?: number;
	maxCost?: number;
	saveTrace?: boolean;
	heldOut?: boolean;
	expectClean?: boolean;
	strategy?: string;
	gatePlan?: string;
	investigateJoin?: string;
	adjudicate?: string;
	maxAnthropic?: number;
	maxOpenai?: number;
	plan?: boolean;
	audit?: boolean;
	seeds?: boolean;
	check?: boolean;
	experiment?: ExperimentMode;
	planFile?: string;
	final?: boolean;
}

const USAGE = [
	"Usage:",
	"  ai-review replay [--fixtures <dir>]",
	"  ai-review replay --record <pr-url> (--reviewer <id> | --provider anthropic|openai) --bot <login> [--held-out] [--expect-clean] [--fixtures <dir>]",
	"  ai-review replay --live [--rounds <n>] [--max-cost <usd>] [--strategy <name>] [--save-trace] [--fixtures <dir>]",
	"  ai-review replay --investigate-join <fixture-id> [--fixtures <dir>]",
	"  ai-review replay --seeds [--check | --plan [--strategy <name>] | --strategy <name> --max-cost <usd> [--gate-plan <hash>]]",
	"  ai-review replay --experiment plan|run|score [--plan-file <path>] [--fixtures <dir>]  (--final is for score only)",
	"  ai-review replay --adjudicate <fixture-id> [--max-anthropic <n>] [--max-openai <n>] [--plan | --audit] [--fixtures <dir>]",
].join("\n");

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
const GH_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const FIXTURE_FILE = /^(?!.*\.(labels(\.proposed)?|classes)\.json$).+\.json$/;

export function defaultFixturesDir(fromUrl: string): string {
	let dir = dirname(fileURLToPath(fromUrl));
	for (;;) {
		if (existsSync(join(dir, "package.json")))
			return join(dir, "src", "replay", "fixtures");
		const parent = dirname(dir);
		if (parent === dir) return join(process.cwd(), "src", "replay", "fixtures");
		dir = parent;
	}
}

function parseArgs(args: string[]): ParsedArgs | null {
	const parsed: ParsedArgs = {};
	let legacy: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		const value = args[i + 1];
		if (flag === "--live") {
			parsed.live = true;
			continue;
		}
		if (flag === "--save-trace") {
			parsed.saveTrace = true;
			continue;
		}
		if (flag === "--held-out") {
			parsed.heldOut = true;
			continue;
		}
		if (flag === "--expect-clean") {
			parsed.expectClean = true;
			continue;
		}
		if (flag === "--final") {
			parsed.final = true;
			continue;
		}
		if (flag === "--experiment") {
			if (value !== "plan" && value !== "run" && value !== "score") return null;
			parsed.experiment = value;
			i++;
			continue;
		}
		if (flag === "--plan-file") {
			if (value === undefined || value.startsWith("--")) return null;
			parsed.planFile = value;
			i++;
			continue;
		}
		if (flag === "--seeds" || flag === "--check") {
			parsed[flag === "--seeds" ? "seeds" : "check"] = true;
			continue;
		}
		if (flag === "--plan" || flag === "--audit") {
			parsed[flag === "--plan" ? "plan" : "audit"] = true;
			continue;
		}
		if (flag === "--max-anthropic" || flag === "--max-openai") {
			const n = Number(value);
			if (value === undefined || !Number.isInteger(n) || n < 0) return null;
			if (flag === "--max-anthropic") parsed.maxAnthropic = n;
			else parsed.maxOpenai = n;
			i++;
			continue;
		}
		if (flag === "--rounds" || flag === "--max-cost") {
			const n = Number(value);
			if (value === undefined || !Number.isFinite(n) || n <= 0) return null;
			if (flag === "--rounds") {
				if (!Number.isInteger(n)) return null;
				parsed.rounds = n;
			} else parsed.maxCost = n;
			i++;
			continue;
		}
		if (
			(flag === "--record" ||
				flag === "--strategy" ||
				flag === "--gate-plan" ||
				flag === "--investigate-join" ||
				flag === "--adjudicate" ||
				flag === "--provider" ||
				flag === "--reviewer" ||
				flag === "--bot" ||
				flag === "--fixtures") &&
			(value === undefined || value.startsWith("--"))
		)
			return null;
		if (flag === "--record") parsed.record = value;
		else if (flag === "--strategy") parsed.strategy = value;
		else if (flag === "--gate-plan") parsed.gatePlan = value;
		else if (flag === "--investigate-join") parsed.investigateJoin = value;
		else if (flag === "--adjudicate") parsed.adjudicate = value;
		else if (flag === "--bot") parsed.bot = value;
		else if (flag === "--fixtures") parsed.fixtures = value;
		else if (flag === "--provider") {
			if (value !== "anthropic" && value !== "openai") return null;
			legacy = value;
		} else if (flag === "--reviewer") parsed.reviewer = value;
		else return null;
		i++;
	}
	if (parsed.reviewer !== undefined && legacy !== undefined) return null;
	if (legacy !== undefined) parsed.reviewer = reviewerFromLegacy(legacy);
	return parsed;
}

function hasConfirmed(labels: LabelFile): boolean {
	return (
		labels.labels.some((l) => l.confirmed) ||
		labels.repeatPairs.some((p) => p.confirmed)
	);
}

async function record(
	p: ParsedArgs,
	dir: string,
	client: GhClient,
	out: (s: string) => void,
): Promise<number> {
	const m = p.record?.match(PR_URL);
	if (!m || !p.reviewer || !p.bot) {
		out(USAGE);
		return 2;
	}
	if (!GH_NAME.test(m[1] as string) || !GH_NAME.test(m[2] as string)) {
		out("invalid owner or repo name in URL");
		return 2;
	}
	try {
		return await writeRecording(m, p, dir, client, out);
	} catch (err) {
		out(`record failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

async function writeRecording(
	m: RegExpMatchArray,
	p: ParsedArgs,
	dir: string,
	client: GhClient,
	out: (s: string) => void,
): Promise<number> {
	const fixture = await recordPr(client, {
		owner: m[1] as string,
		repo: m[2] as string,
		pull: Number(m[3]),
		reviewer: p.reviewer as string,
		botLogin: p.bot as string,
	});
	const id = fixtureId(fixture);
	const fixturePath = join(dir, `${id}.json`);
	if (existsSync(fixturePath)) {
		const prior = JSON.parse(
			await readFile(fixturePath, "utf8"),
		) as ReplayFixture;
		if (prior.heldOut) fixture.heldOut = true;
		if (prior.expect) fixture.expect = prior.expect;
		if (prior.rounds.some((r) => r.trace))
			out(
				`dropped saved traces for ${id}; rerun replay --live --save-trace to restore them`,
			);
	}
	if (p.heldOut) fixture.heldOut = true;
	if (p.expectClean) fixture.expect = { clean: true };
	const labelsPath = join(dir, `${id}.labels.json`);
	let target = labelsPath;
	if (existsSync(labelsPath)) {
		let existing: LabelFile;
		try {
			existing = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
		} catch (err) {
			throw new Error(
				`cannot read existing labels ${labelsPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (hasConfirmed(existing))
			target = join(dir, `${id}.labels.proposed.json`);
	}
	await mkdir(dir, { recursive: true });
	await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
	await writeFile(
		target,
		`${JSON.stringify(labelFixture(fixture), null, 2)}\n`,
	);
	out(`recorded ${id} (${fixture.rounds.length} rounds) -> ${target}`);
	return 0;
}

const FIXTURE_ID = /^[A-Za-z0-9._-]+$/;

const JUDGE_MODELS: Record<LegacyProvider, ModelSelection> = {
	anthropic: {
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		effort: "medium",
	},
	openai: { provider: "openai", model: "gpt-6.1-sol", effort: "low" },
};

async function realJoinJudge(family: LegacyProvider): Promise<JoinJudge> {
	const { resolveAuth } = await import("../auth.js");
	return modelJudge(JUDGE_MODELS[family], await resolveAuth(family));
}

async function investigate(
	p: ParsedArgs,
	dir: string,
	client: GhClient,
	out: (s: string) => void,
	makeJudge: (family: LegacyProvider) => Promise<JoinJudge>,
): Promise<number> {
	const id = p.investigateJoin as string;
	const fixturePath = join(dir, `${id}.json`);
	const labelsPath = join(dir, `${id}.labels.json`);
	if (!existsSync(fixturePath) || !existsSync(labelsPath)) {
		out(`no fixture or labels for ${id} in ${dir}`);
		return 1;
	}
	const fixture = JSON.parse(
		await readFile(fixturePath, "utf8"),
	) as ReplayFixture;
	const labels = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
	const family: LegacyProvider =
		fixture.provider === "anthropic" ? "openai" : "anthropic";
	const { fetchDiff } = defaultLiveWiring(fixture, client);
	const diffs = new Map<number, ReturnType<typeof fetchDiff>>();
	const diffFor = (round: (typeof fixture.rounds)[number]) => {
		let pending = diffs.get(round.index);
		if (!pending) {
			pending = fetchDiff(round);
			diffs.set(round.index, pending);
		}
		return pending;
	};
	try {
		const result = await investigateJoin({
			fixture,
			labels,
			judge: await makeJudge(family),
			judgeFamily: family,
			evidenceFor: async (path, roundIndex) => {
				const round = fixture.rounds.find((r) => r.index === roundIndex);
				if (!round) return "";
				try {
					const { files } = await diffFor(round);
					return files.find((f) => f.filename === path)?.patch ?? "";
				} catch (err) {
					return `(diff unavailable: ${err instanceof Error ? err.message : String(err)})`;
				}
			},
		});
		out(formatInvestigation(id, result));
		out(
			`judge: ${family} (${JUDGE_MODELS[family].model}); single-provider judgement, not confirmed by a second model family`,
		);
		return 0;
	} catch (err) {
		out(
			`join investigation failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
}

async function printClassReport(
	dir: string,
	out: (s: string) => void,
): Promise<ClassFile[]> {
	const names = (await readdir(dir)).filter((n) => n.endsWith(".classes.json"));
	if (names.length === 0) return [];
	const files: ClassFile[] = [];
	let rejectedTotal = 0;
	let unadjudicatedLabels = 0;
	let repeats = 0;
	for (const name of names.sort()) {
		const file = JSON.parse(
			await readFile(join(dir, name), "utf8"),
		) as ClassFile;
		const labelsPath = join(dir, `${file.fixtureId}.labels.json`);
		if (!existsSync(labelsPath)) {
			out(`${name}: skipped: no labels file (${file.fixtureId}.labels.json)`);
			continue;
		}
		files.push(file);
		const labels = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
		const later = new Set(labels.repeatPairs.map((p) => p.later));
		for (const l of labels.labels) {
			if (l.label === "rejected") {
				rejectedTotal++;
				if (later.has(l.claimId)) repeats++;
			} else if (l.label === "unadjudicated") unadjudicatedLabels++;
		}
	}
	if (files.length === 0) return files;
	out(
		formatClassReport(
			summarizeClasses(files, rejectedTotal, unadjudicatedLabels, repeats),
		),
	);
	return files;
}

async function replayAll(
	dir: string,
	pipeline: ReplayPipeline,
	out: (s: string) => void,
	adjudicationDir?: string,
): Promise<number> {
	const files = existsSync(dir)
		? (await readdir(dir)).filter((n) => FIXTURE_FILE.test(n)).sort()
		: [];
	if (files.length === 0) {
		out(`no fixtures found in ${dir}; record some with --record`);
		return 1;
	}
	const metrics = [];
	const ids: string[] = [];
	const loaded: { fixture: ReplayFixture; labels: LabelFile }[] = [];
	let failed = false;
	for (const name of files) {
		const f = JSON.parse(
			await readFile(join(dir, name), "utf8"),
		) as ReplayFixture;
		const id = fixtureId(f);
		const labelsPath = join(dir, `${id}.labels.json`);
		if (!existsSync(labelsPath)) {
			out(`${id}: missing ${id}.labels.json (run --record first)`);
			failed = true;
			continue;
		}
		const labels = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
		const result = replayFixture(f, labels, pipeline);
		const guard = checkRecall(f, labels, result);
		metrics.push(computeMetrics(f, labels, result));
		loaded.push({ fixture: f, labels });
		ids.push(id);
		for (const w of guard.warnings) out(`warning ${id}: ${w}`);
		for (const e of guard.failures) out(`FAIL ${id}: ${e}`);
		if (guard.failures.length > 0) failed = true;
	}
	const clean = checkClean(loaded.map((l) => l.fixture));
	for (const id of clean.unchecked)
		out(`warning ${id}: clean fixture has no trace`);
	for (const v of clean.violations)
		out(`FAIL ${v}: clean fixture posted findings`);
	if (clean.violations.length > 0) failed = true;
	if (metrics.length > 0) out(formatReport(metrics, ids));
	const classFiles = await printClassReport(dir, out);
	if (classFiles.length > 0) {
		const covered = loaded.filter((l) =>
			classFiles.some((c) => c.fixtureId === l.labels.fixtureId),
		);
		out(
			formatMargin(
				filterMargin(
					covered.map((l) => l.fixture),
					covered.map((l) => l.labels),
					classFiles,
				),
			),
		);
	}
	printAdaptiveReport(loaded, out, adjudicationDir);
	out(`replayed ${metrics.length} fixture${metrics.length === 1 ? "" : "s"}`);
	return failed ? 1 : 0;
}

function printAdaptiveReport(
	loaded: { fixture: ReplayFixture; labels: LabelFile }[],
	out: (s: string) => void,
	adjudicationDir?: string,
): void {
	const traced = loaded.filter((l) => l.fixture.rounds.some((r) => r.trace));
	if (traced.length === 0) return;
	const cache = new VerdictCache(adjudicationDir);
	out(
		adaptiveReport(
			traced.map(({ fixture, labels }) => {
				const snapshot = snapshotId(fixture);
				return {
					fixture,
					labels,
					verdictFor: (c) => {
						const rec = cache.get(snapshot, claimKey(c));
						return rec &&
							rec.status !== "unresolved" &&
							isCurrentVerdict(rec, possibleFirstModels(fixture.provider))
							? rec.verdict
							: undefined;
					},
				};
			}),
		).text,
	);
}

async function writeTrace(
	path: string,
	fixture: ReplayFixture,
	report: LiveReport,
): Promise<void> {
	const traces = new Map(report.rounds.map((r) => [r.index, r.trace]));
	const rounds = fixture.rounds.map((r) => {
		const t = traces.get(r.index);
		if (!t) return r;
		const { trace: _old, ...rest } = r;
		return {
			...rest,
			trace: { candidates: t.candidates, posted: t.posted, usage: t.usage },
		};
	});
	const tmp = `${path}.tmp`;
	try {
		await writeFile(
			tmp,
			`${JSON.stringify({ ...fixture, rounds }, null, 2)}\n`,
		);
		await chmod(tmp, (await stat(path)).mode & 0o7777);
		await rename(tmp, path);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

async function liveAll(
	dir: string,
	p: ParsedArgs,
	client: GhClient,
	out: (s: string) => void,
	strategy: ReviewStrategy,
	wire?: typeof defaultLiveWiring,
): Promise<number> {
	const buildLiveWiring = wire ?? defaultLiveWiring;
	const files = existsSync(dir)
		? (await readdir(dir)).filter((n) => FIXTURE_FILE.test(n)).sort()
		: [];
	if (files.length === 0) {
		out(`no fixtures found in ${dir}; record some with --record`);
		return 1;
	}
	const cap = p.maxCost ?? 5;
	let remaining = cap;
	let failed = false;
	for (const name of files) {
		const f = JSON.parse(
			await readFile(join(dir, name), "utf8"),
		) as ReplayFixture;
		if (p.reviewer !== undefined && fixtureReviewer(f) !== p.reviewer) continue;
		const id = fixtureId(f);
		const labelsPath = join(dir, `${id}.labels.json`);
		if (!existsSync(labelsPath)) {
			out(`${id}: missing ${id}.labels.json (run --record first)`);
			if (f.expect?.clean) {
				out(`FAIL ${id}: clean fixture has no labels file`);
				failed = true;
			}
			continue;
		}
		const labels = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
		const wiring = buildLiveWiring(f, client);
		const rounds = f.rounds.slice(-(p.rounds ?? 2)).map((r) => r.index);
		out(`live ${id}`);
		let report: LiveReport;
		try {
			report = await runLiveTier({
				fixture: f,
				labels,
				rounds,
				maxCostUsd: remaining,
				out,
				strategy,
				...wiring,
			});
		} catch (err) {
			if (err instanceof LiveRunError) {
				out(
					`live failed for ${id}: ${err.message} (estimated spend $${(cap - remaining + err.partial.spentUsd).toFixed(2)} across fixtures)`,
				);
				return 1;
			}
			if (!(err instanceof InvalidEstimateError)) throw err;
			out(`live failed for ${id}: ${err.message}`);
			return 1;
		}
		remaining -= report.spentUsd;
		if (p.saveTrace) await writeTrace(join(dir, name), f, report);
		if (!f.expect?.clean) continue;
		for (const r of report.rounds)
			if (r.posted > 0) {
				out(
					`FAIL ${id} round ${r.index}: clean fixture would post ${r.posted} findings`,
				);
				failed = true;
			}
		const ran = new Set(report.rounds.map((r) => r.index));
		const skipped = rounds.find((i) => !ran.has(i));
		if (skipped !== undefined)
			out(
				`UNCHECKED ${id}: cost cap stopped before round ${skipped} (${report.rounds.length} of ${rounds.length} rounds replayed)`,
			);
	}
	return failed ? 1 : 0;
}

async function runSeeds(
	p: ParsedArgs,
	deps: ReplayDeps,
	out: (s: string) => void,
): Promise<number> {
	const misuse =
		((p.live ||
			p.record !== undefined ||
			p.adjudicate !== undefined ||
			p.investigateJoin !== undefined ||
			p.saveTrace ||
			p.heldOut ||
			p.expectClean ||
			p.reviewer !== undefined ||
			p.bot !== undefined ||
			p.rounds !== undefined ||
			p.audit ||
			p.fixtures !== undefined ||
			p.maxAnthropic !== undefined ||
			p.maxOpenai !== undefined) &&
			"--seeds takes only --check, --plan, --strategy and --max-cost (no --fixtures)") ||
		(p.check &&
			(p.plan || p.strategy !== undefined || p.maxCost !== undefined) &&
			"--check takes no other seed flags") ||
		(p.maxCost !== undefined &&
			p.strategy === undefined &&
			"--max-cost requires --strategy") ||
		(p.gatePlan !== undefined &&
			(p.strategy === undefined || p.plan) &&
			"--gate-plan requires --strategy and does not apply to --plan") ||
		(p.maxCost !== undefined &&
			p.plan &&
			"--max-cost does not apply to --plan");
	if (misuse) {
		out(`${misuse}\n${USAGE}`);
		return 2;
	}
	const opts = { root: deps.seedsRoot, out };
	if (p.strategy === undefined && !p.plan) return checkSeeds(opts);
	registerBuiltinStrategies();
	let strategy: ReviewStrategy;
	try {
		strategy = getStrategy(p.strategy ?? "a");
	} catch (err) {
		if (!(err instanceof UnknownStrategyError)) throw err;
		out(err.message);
		return 2;
	}
	if (p.plan) return planSeeds(strategy, opts);
	const { gatePlan } = p;
	return runSeedsWithStrategy(strategy, {
		...opts,
		maxCostUsd: p.maxCost ?? 5,
		onGate:
			gatePlan === undefined
				? undefined
				: (gate) =>
						writeSeedGate(
							deps.experimentsDir ?? defaultExperimentsDir(),
							gatePlan,
							strategy.name,
							gate,
						),
	});
}

function checkExperimentFlags(p: ParsedArgs): string | null {
	if (p.experiment === undefined)
		return p.final || p.planFile !== undefined
			? "--final and --plan-file require --experiment"
			: null;
	const others = [
		p.live,
		p.record,
		p.strategy,
		p.gatePlan,
		p.investigateJoin,
		p.adjudicate,
		p.seeds,
		p.check,
		p.plan,
		p.audit,
		p.rounds,
		p.maxCost,
		p.saveTrace,
		p.heldOut,
		p.expectClean,
		p.maxAnthropic,
		p.maxOpenai,
		p.reviewer,
		p.bot,
	];
	if (others.some((v) => v !== undefined && v !== false))
		return "--experiment takes only --plan-file, --final (score) and --fixtures";
	if (p.final && p.experiment !== "score")
		return "--final applies only to --experiment score";
	return null;
}

export async function runReplay(
	args: string[],
	deps: ReplayDeps = {},
): Promise<number> {
	const out = deps.out ?? ((s: string) => console.log(s));
	const parsed = parseArgs(args);
	if (!parsed) {
		out(USAGE);
		return 2;
	}
	const experimentMisuse = checkExperimentFlags(parsed);
	if (experimentMisuse) {
		out(`${experimentMisuse}\n${USAGE}`);
		return 2;
	}
	if (parsed.experiment) {
		const fixturesDir =
			parsed.fixtures ??
			deps.fixturesDir ??
			defaultFixturesDir(import.meta.url);
		return runExperiment(
			{
				mode: parsed.experiment,
				planFile: parsed.planFile ?? defaultPlanFile(import.meta.url),
				final: parsed.final === true,
			},
			deps.experiment ??
				realExperimentDeps({
					fixturesDir,
					out,
					client: deps.client,
					adjudicationDir: deps.adjudicationDir,
				}),
		);
	}
	if (parsed.seeds) return runSeeds(parsed, deps, out);
	const misuse =
		(parsed.check && "--check requires --seeds") ||
		(parsed.gatePlan !== undefined &&
			"--gate-plan requires --seeds --strategy") ||
		(parsed.saveTrace &&
			(!parsed.live || parsed.record !== undefined) &&
			"--save-trace requires --live without --record") ||
		((parsed.heldOut || parsed.expectClean) &&
			parsed.record === undefined &&
			"--held-out and --expect-clean require --record") ||
		(parsed.strategy !== undefined &&
			(!parsed.live || parsed.record !== undefined) &&
			"--strategy requires --live without --record") ||
		(parsed.investigateJoin !== undefined &&
			(parsed.live ||
				parsed.reviewer !== undefined ||
				parsed.bot !== undefined ||
				parsed.record !== undefined ||
				parsed.saveTrace ||
				parsed.strategy !== undefined ||
				parsed.rounds !== undefined ||
				parsed.maxCost !== undefined ||
				parsed.heldOut ||
				parsed.expectClean ||
				!FIXTURE_ID.test(parsed.investigateJoin)) &&
			"--investigate-join takes a fixture id and no other mode flags") ||
		(parsed.adjudicate !== undefined &&
			(parsed.live ||
				parsed.reviewer !== undefined ||
				parsed.bot !== undefined ||
				parsed.record !== undefined ||
				parsed.investigateJoin !== undefined ||
				parsed.saveTrace ||
				parsed.strategy !== undefined ||
				parsed.rounds !== undefined ||
				parsed.maxCost !== undefined ||
				parsed.heldOut ||
				parsed.expectClean ||
				(parsed.plan && parsed.audit) ||
				!FIXTURE_ID.test(parsed.adjudicate)) &&
			"--adjudicate takes a fixture id, optional caps, and either --plan or --audit, with no other mode flags") ||
		(parsed.adjudicate === undefined &&
			(parsed.plan ||
				parsed.audit ||
				parsed.maxAnthropic !== undefined ||
				parsed.maxOpenai !== undefined) &&
			"--plan, --audit, --max-anthropic and --max-openai require --adjudicate");
	if (misuse) {
		out(`${misuse}\n${USAGE}`);
		return 2;
	}
	let strategy: ReviewStrategy | undefined;
	if (parsed.live) {
		registerBuiltinStrategies();
		try {
			strategy = getStrategy(parsed.strategy ?? "a");
		} catch (err) {
			if (!(err instanceof UnknownStrategyError)) throw err;
			out(err.message);
			return 2;
		}
	}
	const dir =
		parsed.fixtures ?? deps.fixturesDir ?? defaultFixturesDir(import.meta.url);
	if (parsed.adjudicate !== undefined)
		return runAdjudication({
			id: parsed.adjudicate,
			dir,
			caps: {
				anthropic: parsed.maxAnthropic ?? DEFAULT_MAX_ANTHROPIC,
				openai: parsed.maxOpenai ?? DEFAULT_MAX_OPENAI,
			},
			plan: parsed.plan === true,
			audit: parsed.audit === true,
			client: deps.client ?? ghCli(),
			out,
			cacheDir: deps.adjudicationDir,
			judges:
				deps.adjudicationJudges ??
				(async () =>
					(await import("./adjudication/model-judges.js"))
						.modelAdjudicationJudges),
		});
	if (parsed.investigateJoin !== undefined)
		return investigate(
			parsed,
			dir,
			deps.client ?? ghCli(),
			out,
			deps.joinJudge ?? realJoinJudge,
		);
	if (parsed.record !== undefined)
		return record(parsed, dir, deps.client ?? ghCli(), out);
	if (strategy)
		return liveAll(
			dir,
			parsed,
			deps.client ?? ghCli(),
			out,
			strategy,
			deps.liveWiring,
		);
	return replayAll(
		dir,
		deps.pipeline ?? todaysCodePipeline,
		out,
		deps.adjudicationDir,
	);
}
