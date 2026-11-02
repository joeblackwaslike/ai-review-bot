import type { ModelReview } from "../review.js";
import { findingRecords, type MistakeLog } from "./log.js";
import { implementerFromEnv } from "./session.js";
import type { AgentReview } from "./types.js";

export function logReviewRun(opts: {
	log: MistakeLog;
	headSha: string;
	scope: string;
	costUsd: number;
	durationSeconds: number;
	providers: string[];
	models: string[];
	agentsAttempted: number;
	agentsSucceeded: number;
	reportPath: string;
	agentReviews: AgentReview[];
	merged: ModelReview;
	env: NodeJS.ProcessEnv;
}): void {
	opts.log.append({
		type: "run",
		headSha: opts.headSha,
		mergeBase: null,
		scope: opts.scope,
		round: null,
		costUsd: opts.costUsd,
		durationSeconds: opts.durationSeconds,
		providers: opts.providers,
		models: opts.models,
		agentsAttempted: opts.agentsAttempted,
		agentsSucceeded: opts.agentsSucceeded,
		partial: opts.agentsSucceeded < opts.agentsAttempted,
		reportPath: opts.reportPath,
		implementer: implementerFromEnv(opts.env),
	});
	if (opts.agentsAttempted === 0) return;
	for (const rec of findingRecords({
		agentReviews: opts.agentReviews,
		merged: opts.merged,
	})) {
		opts.log.append(rec);
	}
}
