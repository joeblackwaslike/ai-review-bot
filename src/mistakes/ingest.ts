import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gateRepoSlug, gateRoot } from "../gate/run.js";
import { fileStamp, safeSegment } from "./log.js";
import {
	decisionsFor,
	type NoMistakesSource,
	sqliteNoMistakesSource,
} from "./nomistakes.js";
import {
	pickSession,
	type SessionActivity,
	scanTranscripts,
} from "./transcripts.js";
import {
	type AnnotationRecord,
	type EventRecord,
	type Implementer,
	MistakeRecord,
	type RunRecord,
} from "./types.js";

export interface IngestOptions {
	root: string;
	repo?: string;
	transcriptsDir?: string;
	noMistakesDir?: string;
	now?: () => Date;
	noMistakes?: NoMistakesSource;
}

export interface IngestResult {
	resolved: { byReviewRow: number; byTranscript: number };
	unresolved: number;
	events: number;
	file: string | null;
}

interface LogState {
	runs: RunRecord[];
	annotated: Set<string>;
	eventKeys: Set<string>;
}

const warn = (msg: string) => console.error(`mistakes ingest: ${msg}`);

const eventKey = (
	e: Pick<
		EventRecord,
		"runId" | "findingId" | "status" | "atHead" | "by" | "step"
	>,
) =>
	JSON.stringify([
		e.runId,
		e.findingId,
		e.status,
		e.atHead,
		e.by,
		e.step ?? null,
	]);

/** `owner/name` of the checkout at `cwd`, from its origin remote or its top-level directory name. */
export function currentRepoSlug(cwd = process.cwd()): string {
	const top = gateRoot(cwd);
	let origin: string | null = null;
	try {
		origin =
			execFileSync("git", ["remote", "get-url", "origin"], {
				cwd: top,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || null;
	} catch {
		origin = null;
	}
	const { owner, repo } = gateRepoSlug(origin, top);
	return `${owner}/${repo}`;
}

function readLog(dir: string): LogState {
	const state: LogState = {
		runs: [],
		annotated: new Set(),
		eventKeys: new Set(),
	};
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return state;
		throw new Error(
			`could not list ${dir}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	for (const file of files) {
		const path = join(dir, file);
		const isIngest = file.startsWith("ingest-");
		let content: string;
		try {
			content = readFileSync(path, "utf-8");
		} catch (error) {
			const message = `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`;
			if (isIngest) throw new Error(message);
			warn(message);
			continue;
		}
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (!line.trim()) continue;
			let rec: MistakeRecord;
			try {
				rec = MistakeRecord.parse(JSON.parse(line));
			} catch {
				warn(`skipped malformed log line at ${path}:${i + 1}`);
				continue;
			}
			if (isIngest && rec.type === "annotation") state.annotated.add(rec.runId);
			else if (isIngest && rec.type === "event")
				state.eventKeys.add(eventKey(rec));
			else if (!isIngest && rec.type === "run") state.runs.push(rec);
		}
	}
	return state;
}

function latestReviewSession(
	runs: readonly RunRecord[],
	branch: string,
	before: number,
): { sessionId: string; agent: Implementer["agent"] } | null {
	let best: {
		at: number;
		sessionId: string;
		agent: Implementer["agent"];
	} | null = null;
	for (const r of runs) {
		const at = Date.parse(r.ts);
		const sessionId = r.implementer.sessionId;
		if (r.source !== "review" || r.branch !== branch || !sessionId) continue;
		if (!(at < before) || (best && best.at >= at)) continue;
		best = { at, sessionId, agent: r.implementer.agent };
	}
	return best ? { sessionId: best.sessionId, agent: best.agent } : null;
}

async function noMistakesEvents(opts: {
	source: NoMistakesSource;
	repo: string;
	runs: readonly RunRecord[];
	seen: Set<string>;
	ts: string;
}): Promise<EventRecord[]> {
	const heads = new Map<string, Set<string>>();
	for (const r of opts.runs) {
		if (!r.branch) continue;
		heads.set(r.branch, (heads.get(r.branch) ?? new Set()).add(r.headSha));
	}
	if (heads.size === 0) return [];
	let nmRuns: Awaited<ReturnType<NoMistakesSource["runs"]>>;
	try {
		nmRuns = await opts.source.runs(opts.repo);
	} catch (error) {
		warn(
			`no-mistakes data unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
	const events: EventRecord[] = [];
	let skipped = 0;
	for (const run of nmRuns) {
		const branchHeads = heads.get(run.branch);
		if (!branchHeads) continue;
		let rounds: Awaited<ReturnType<NoMistakesSource["rounds"]>>;
		try {
			rounds = await opts.source.rounds(run.id);
		} catch (error) {
			warn(
				`no-mistakes rounds for ${run.id} unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		const matched =
			branchHeads.has(run.headSha) ||
			rounds.some(
				(r) => r.reviewedHeadSha && branchHeads.has(r.reviewedHeadSha),
			);
		if (!matched) continue;
		const result = decisionsFor(run, rounds);
		skipped += result.skipped;
		for (const d of result.decisions) {
			const atHead = d.atHead ?? run.headSha;
			if (!branchHeads.has(atHead)) continue;
			const event: EventRecord = {
				v: 1,
				type: "event",
				ts: opts.ts,
				runId: run.id,
				source: "ingest",
				repo: opts.repo,
				branch: run.branch,
				findingId: d.findingId,
				status: d.status,
				by: "no-mistakes",
				step: d.step,
				atHead,
				fixCommit: null,
				path: d.path,
				title: d.title,
				severity: d.severity,
				note: d.note,
			};
			const key = eventKey(event);
			if (opts.seen.has(key)) continue;
			opts.seen.add(key);
			events.push(event);
		}
	}
	if (skipped > 0)
		warn(`skipped ${skipped} unrecognized no-mistakes finding(s)`);
	return events;
}

const MAX_WRITE_ATTEMPTS = 10;

function writeExclusive(dir: string, stem: string, data: string): string {
	for (let attempt = 1; ; attempt++) {
		const file = join(
			dir,
			`${stem}${attempt === 1 ? "" : `-${attempt}`}.jsonl`,
		);
		try {
			writeFileSync(file, data, { flag: "wx", mode: 0o600 });
			return file;
		} catch (error) {
			const taken = (error as NodeJS.ErrnoException).code === "EEXIST";
			if (!taken || attempt >= MAX_WRITE_ATTEMPTS) throw error;
		}
	}
}

/** Resolves gate runs with no implementer to a Claude Code session and records no-mistakes decisions for captured branches and heads, appending both to a new `ingest-<stamp>.jsonl` beside the capture files. Capture files are only read. Annotations and events already written by an earlier ingest are not repeated. */
export async function ingest(opts: IngestOptions): Promise<IngestResult> {
	const now = opts.now ?? (() => new Date());
	const repo = opts.repo ?? currentRepoSlug();
	const [owner, name] = repo.split("/");
	const dir = join(opts.root, `${safeSegment(owner)}__${safeSegment(name)}`);
	const state = readLog(dir);
	const started = now();
	const ts = started.toISOString();
	const result: IngestResult = {
		resolved: { byReviewRow: 0, byTranscript: 0 },
		unresolved: 0,
		events: 0,
		file: null,
	};
	const lines: (AnnotationRecord | EventRecord)[] = [];
	const scans = new Map<string, Promise<SessionActivity[]>>();
	const scan = (branch: string) => {
		const cached = scans.get(branch);
		if (cached) return cached;
		const pending = scanTranscripts({
			dir: opts.transcriptsDir ?? join(homedir(), ".claude", "projects"),
			repoName: name ?? repo,
			branch,
		}).then(({ sessions, skipped, warnings }) => {
			if (skipped > 0) warn(`skipped ${skipped} malformed transcript line(s)`);
			for (const w of warnings) warn(w);
			return sessions;
		});
		scans.set(branch, pending);
		return pending;
	};

	const seenRunIds = new Set<string>();
	const gates = state.runs.filter((r) => {
		if (
			r.source !== "gate" ||
			r.implementer.sessionId !== null ||
			state.annotated.has(r.runId) ||
			seenRunIds.has(r.runId)
		)
			return false;
		seenRunIds.add(r.runId);
		return true;
	});
	for (const gate of gates) {
		if (!gate.branch) {
			result.unresolved++;
			continue;
		}
		const at = Date.parse(gate.ts);
		let implementer: Implementer | null = null;
		const fromReview = latestReviewSession(state.runs, gate.branch, at);
		if (fromReview) {
			implementer = {
				agent: fromReview.agent,
				sessionId: fromReview.sessionId,
				source: "resolved",
				confidence: "high",
			};
			result.resolved.byReviewRow++;
		} else {
			const match = pickSession(await scan(gate.branch), at);
			if (match) {
				implementer = {
					agent: "claude-code",
					sessionId: match.sessionId,
					source: "resolved",
					confidence: match.confidence,
				};
				result.resolved.byTranscript++;
			}
		}
		if (!implementer) {
			result.unresolved++;
			continue;
		}
		lines.push({
			v: 1,
			type: "annotation",
			ts,
			runId: gate.runId,
			repo,
			branch: gate.branch,
			implementer,
		});
	}

	const events = await noMistakesEvents({
		source:
			opts.noMistakes ??
			sqliteNoMistakesSource({
				dbPath: join(
					opts.noMistakesDir ?? join(homedir(), ".no-mistakes"),
					"state.sqlite",
				),
			}),
		repo,
		runs: state.runs,
		seen: state.eventKeys,
		ts,
	});
	result.events = events.length;
	lines.push(...events);

	if (lines.length === 0) return result;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	result.file = writeExclusive(
		dir,
		`ingest-${fileStamp(started)}`,
		lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
	);
	return result;
}
