import type { ReviewPassResult } from "../audit.js";
import type { LedgerEntry } from "../ledger/types.js";
import {
	type EventRecordBody,
	findingRecords,
	type MistakeLog,
} from "./log.js";

const NO_IMPLEMENTER = {
	agent: null,
	sessionId: null,
	source: null,
	confidence: null,
} as const;

function event(
	e: LedgerEntry,
	status: "fixed" | "reopened",
	head: string,
	note: string | null,
): EventRecordBody {
	return {
		type: "event",
		findingId: e.id,
		status,
		by: "gate-inferred",
		atHead: head,
		fixCommit: null,
		path: e.path,
		title: e.title,
		severity: e.severity,
		note,
	};
}

export function diffRoundEvents(
	before: readonly LedgerEntry[],
	after: readonly LedgerEntry[],
	head: string,
): EventRecordBody[] {
	const prior = new Map(before.map((e) => [e.id, e.status]));
	const events: EventRecordBody[] = [];
	for (const e of after) {
		const was = prior.get(e.id);
		if (e.status === "fixed" && (was === undefined || was === "open")) {
			events.push(
				event(
					e,
					"fixed",
					head,
					e.evidence.find((s) => s.startsWith("inferred:")) ?? null,
				),
			);
		} else if (e.status === "open" && was === "fixed") {
			events.push(event(e, "reopened", head, null));
		}
	}
	return events;
}

export function logGateRun(opts: {
	log: MistakeLog;
	pass: ReviewPassResult | null;
	round: number;
	mergeBase: string;
	headSha: string;
	durationSeconds: number;
	before: readonly LedgerEntry[];
	after: readonly LedgerEntry[];
}): void {
	const { log, pass } = opts;
	const stats = pass?.providerStats ?? [];
	log.append({
		type: "run",
		headSha: opts.headSha,
		mergeBase: opts.mergeBase,
		scope: "range",
		round: opts.round,
		costUsd: pass?.costUsd ?? 0,
		durationSeconds: opts.durationSeconds,
		providers: pass?.providersRun ?? [],
		models: pass?.models ?? [],
		agentsAttempted: pass?.agentsAttempted ?? 0,
		agentsSucceeded: pass?.agentsSucceeded ?? 0,
		partial: stats.some((s) => s.succeeded === 0 || s.succeeded < s.attempted),
		reportPath: null,
		implementer: { ...NO_IMPLEMENTER },
	});
	if (pass) {
		for (const rec of findingRecords({
			agentReviews: pass.agentReviews ?? [],
			merged: pass.merged,
		})) {
			log.append(rec);
		}
	}
	for (const ev of diffRoundEvents(opts.before, opts.after, opts.headSha)) {
		log.append(ev);
	}
}
