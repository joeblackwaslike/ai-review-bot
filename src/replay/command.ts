import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureId } from "./claims.js";
import { type GhClient, ghCli } from "./gh.js";
import { checkRecall } from "./guard.js";
import { labelFixture } from "./label.js";
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
}

const USAGE = [
	"Usage:",
	"  ai-review replay [--fixtures <dir>]",
	"  ai-review replay --record <pr-url> --provider anthropic|openai --bot <login> [--fixtures <dir>]",
].join("\n");

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
const FIXTURE_FILE = /^(?!.*\.labels(\.proposed)?\.json$).+\.json$/;

function parseArgs(args: string[]): ParsedArgs | null {
	const parsed: ParsedArgs = {};
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		const value = args[i + 1];
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
	const fixture = await recordPr(client, {
		owner: m[1] as string,
		repo: m[2] as string,
		pull: Number(m[3]),
		provider: p.provider,
		botLogin: p.bot,
	});
	const id = fixtureId(fixture);
	const labelsPath = join(dir, `${id}.labels.json`);
	let target = labelsPath;
	if (existsSync(labelsPath)) {
		const existing = JSON.parse(
			await readFile(labelsPath, "utf8"),
		) as LabelFile;
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

async function replayAll(
	dir: string,
	pipeline: ReplayPipeline,
	out: (s: string) => void,
): Promise<number> {
	const files = existsSync(dir)
		? (await readdir(dir)).filter((n) => FIXTURE_FILE.test(n)).sort()
		: [];
	const metrics = [];
	const ids: string[] = [];
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
		ids.push(id);
		for (const w of guard.warnings) out(`warning ${id}: ${w}`);
		for (const e of guard.failures) out(`FAIL ${id}: ${e}`);
		if (guard.failures.length > 0) failed = true;
	}
	if (metrics.length > 0) out(formatReport(metrics, ids));
	out(`replayed ${metrics.length} fixture${metrics.length === 1 ? "" : "s"}`);
	return failed ? 1 : 0;
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
		parsed.fixtures ??
		deps.fixturesDir ??
		fileURLToPath(new URL("./fixtures/", import.meta.url));
	if (parsed.record !== undefined)
		return record(parsed, dir, deps.client ?? ghCli(), out);
	return replayAll(dir, deps.pipeline ?? todaysCodePipeline, out);
}
