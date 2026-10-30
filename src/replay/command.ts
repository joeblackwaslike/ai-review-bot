import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureId } from "./claims.js";
import {
	type ClassFile,
	formatClassReport,
	summarizeClasses,
} from "./classify.js";
import { filterMargin, formatMargin } from "./filter-margin.js";
import { type GhClient, ghCli } from "./gh.js";
import { checkRecall } from "./guard.js";
import { labelFixture } from "./label.js";
import { runLiveTier } from "./live.js";
import { computeMetrics, formatReport } from "./metrics.js";
import { type ReplayPipeline, todaysCodePipeline } from "./pipeline.js";
import { recordPr } from "./record.js";
import { replayFixture } from "./replay.js";
import type { LabelFile, Provider, ReplayFixture } from "./types.js";

export interface ReplayDeps {
	client?: GhClient;
	fixturesDir?: string;
	out?: (s: string) => void;
	pipeline?: ReplayPipeline;
}

interface ParsedArgs {
	record?: string;
	provider?: Provider;
	bot?: string;
	fixtures?: string;
	live?: boolean;
	rounds?: number;
	maxCost?: number;
}

const USAGE = [
	"Usage:",
	"  ai-review replay [--fixtures <dir>]",
	"  ai-review replay --record <pr-url> --provider anthropic|openai --bot <login> [--fixtures <dir>]",
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
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		const value = args[i + 1];
		if (flag === "--live") {
			parsed.live = true;
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
				flag === "--provider" ||
				flag === "--bot" ||
				flag === "--fixtures") &&
			(value === undefined || value.startsWith("--"))
		)
			return null;
		if (flag === "--record") parsed.record = value;
		else if (flag === "--bot") parsed.bot = value;
		else if (flag === "--fixtures") parsed.fixtures = value;
		else if (flag === "--provider") {
			if (value !== "anthropic" && value !== "openai") return null;
			parsed.provider = value;
		} else return null;
		i++;
	}
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
	if (!m || !p.provider || !p.bot) {
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
		provider: p.provider as Provider,
		botLogin: p.bot as string,
	});
	const id = fixtureId(fixture);
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
	await writeFile(
		join(dir, `${id}.json`),
		`${JSON.stringify(fixture, null, 2)}\n`,
	);
	await writeFile(
		target,
		`${JSON.stringify(labelFixture(fixture), null, 2)}\n`,
	);
	out(`recorded ${id} (${fixture.rounds.length} rounds) -> ${target}`);
	return 0;
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
	out(`replayed ${metrics.length} fixture${metrics.length === 1 ? "" : "s"}`);
	return failed ? 1 : 0;
}

async function liveAll(
	dir: string,
	p: ParsedArgs,
	client: GhClient,
	out: (s: string) => void,
): Promise<number> {
	const { buildLiveWiring } = await import("./live-wiring.js");
	const files = existsSync(dir)
		? (await readdir(dir)).filter((n) => FIXTURE_FILE.test(n)).sort()
		: [];
	if (files.length === 0) {
		out(`no fixtures found in ${dir}; record some with --record`);
		return 1;
	}
	let remaining = p.maxCost ?? 5;
	for (const name of files) {
		const f = JSON.parse(
			await readFile(join(dir, name), "utf8"),
		) as ReplayFixture;
		const id = fixtureId(f);
		const labelsPath = join(dir, `${id}.labels.json`);
		if (!existsSync(labelsPath)) {
			out(`${id}: missing ${id}.labels.json (run --record first)`);
			continue;
		}
		const labels = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
		const wiring = buildLiveWiring(f, client);
		const rounds = f.rounds.slice(-(p.rounds ?? 2)).map((r) => r.index);
		out(`live ${id}`);
		const report = await runLiveTier({
			fixture: f,
			labels,
			rounds,
			maxCostUsd: remaining,
			out,
			...wiring,
		});
		remaining -= report.spentUsd;
	}
	return 0;
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
	const dir =
		parsed.fixtures ?? deps.fixturesDir ?? defaultFixturesDir(import.meta.url);
	if (parsed.record !== undefined)
		return record(parsed, dir, deps.client ?? ghCli(), out);
	if (parsed.live) return liveAll(dir, parsed, deps.client ?? ghCli(), out);
	return replayAll(dir, deps.pipeline ?? todaysCodePipeline, out);
}
