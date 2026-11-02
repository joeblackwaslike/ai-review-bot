import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelReview } from "../review.js";
import type {
	AgentReview,
	EventRecord,
	FindingRecord,
	RunRecord,
} from "./types.js";

type CommonField = "v" | "ts" | "runId" | "source" | "repo" | "branch";

export type RunRecordBody = Omit<RunRecord, CommonField>;
export type FindingRecordBody = Omit<FindingRecord, CommonField>;
export type EventRecordBody = Omit<EventRecord, CommonField>;
export type MistakeRecordBody =
	| RunRecordBody
	| FindingRecordBody
	| EventRecordBody;

export interface MistakeLog {
	runId: string;
	path: string;
	append(rec: MistakeRecordBody): void;
}

export interface OpenMistakeLogOptions {
	root?: string;
	owner: string;
	repo: string;
	source: "review" | "gate";
	branch: string | null;
	now?: () => Date;
	runId?: string;
}

export function findingKey(f: { path: string | null; title: string }): string {
	return createHash("sha1")
		.update(`${f.path ?? ""}|${f.title.toLowerCase().trim()}`)
		.digest("hex")
		.slice(0, 12);
}

export function openMistakeLog(opts: OpenMistakeLogOptions): MistakeLog {
	const now = opts.now ?? (() => new Date());
	const runId = opts.runId ?? randomUUID();
	const root =
		opts.root ??
		process.env.AI_REVIEW_MISTAKES_DIR ??
		join(homedir(), ".ai-review", "mistakes");
	const stamp = now().toISOString().replace(/[:.]/g, "-");
	const path = join(
		root,
		`${opts.owner}__${opts.repo}`,
		`${stamp}-${runId}.jsonl`,
	);
	let warned = false;
	return {
		runId,
		path,
		append(rec) {
			try {
				mkdirSync(dirname(path), { recursive: true });
				const line = {
					v: 1,
					ts: now().toISOString(),
					runId,
					source: opts.source,
					repo: `${opts.owner}/${opts.repo}`,
					branch: opts.branch,
					...rec,
				};
				appendFileSync(path, `${JSON.stringify(line)}\n`);
			} catch (error) {
				if (warned) return;
				warned = true;
				console.error(
					`mistake log write failed (${path}): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	};
}

export function findingRecords(opts: {
	agentReviews: AgentReview[];
	merged: ModelReview;
}): FindingRecordBody[] {
	const kept = new Set<string>([
		...opts.merged.inline_comments.map((c) => findingKey(c)),
		...opts.merged.general_findings.map((g) =>
			findingKey({ path: null, title: g.title }),
		),
	]);
	return opts.agentReviews.flatMap(({ provider, model, skill, review }) => {
		const rows: FindingRecordBody[] = [];
		const row = (
			f: ModelReview["general_findings"][number],
			loc: {
				path: string | null;
				line: number | null;
				startLine: number | null;
				suggestion: string | null;
			},
		): FindingRecordBody => {
			const key = findingKey({ path: loc.path, title: f.title });
			return {
				type: "finding",
				findingKey: key,
				skill,
				provider,
				model,
				severity: f.severity,
				category: f.category,
				confidence: f.confidence,
				title: f.title,
				body: f.body,
				evidence: f.evidence,
				suppressible: f.suppressible,
				...loc,
				survived: kept.has(key),
			};
		};
		for (const g of review.general_findings) {
			rows.push(
				row(g, { path: null, line: null, startLine: null, suggestion: null }),
			);
		}
		for (const c of review.inline_comments) {
			rows.push(
				row(c, {
					path: c.path,
					line: c.line,
					startLine: c.start_line,
					suggestion: c.suggestion,
				}),
			);
		}
		return rows;
	});
}
