import { z } from "zod";
import type { Provider } from "../auth.js";
import type { ModelReview } from "../review.js";

export interface AgentReview {
	provider: Provider;
	model: string;
	skill: string;
	review: ModelReview;
}

export const Implementer = z.object({
	agent: z.enum(["claude-code", "codex"]).nullable(),
	sessionId: z.string().nullable(),
	source: z.enum(["env", "resolved"]).nullable(),
	confidence: z.string().nullable(),
});
export type Implementer = z.infer<typeof Implementer>;

const common = {
	v: z.literal(1),
	ts: z.string(),
	runId: z.string(),
	source: z.enum(["review", "gate"]),
	repo: z.string(),
	branch: z.string().nullable(),
};

export const RunRecord = z.object({
	...common,
	type: z.literal("run"),
	headSha: z.string(),
	mergeBase: z.string().nullable(),
	scope: z.string(),
	round: z.number().nullable(),
	costUsd: z.number(),
	durationSeconds: z.number(),
	providers: z.array(z.string()),
	models: z.array(z.string()),
	agentsAttempted: z.number(),
	agentsSucceeded: z.number(),
	partial: z.boolean(),
	reportPath: z.string().nullable(),
	implementer: Implementer,
});
export type RunRecord = z.infer<typeof RunRecord>;

export const FindingRecord = z.object({
	...common,
	type: z.literal("finding"),
	findingKey: z.string(),
	skill: z.string(),
	provider: z.string(),
	model: z.string(),
	severity: z.string(),
	category: z.string(),
	confidence: z.number(),
	title: z.string(),
	body: z.string(),
	evidence: z.string(),
	suppressible: z.boolean(),
	path: z.string().nullable(),
	line: z.number().nullable(),
	startLine: z.number().nullable(),
	suggestion: z.string().nullable(),
	survived: z.boolean(),
});
export type FindingRecord = z.infer<typeof FindingRecord>;

export const EventRecord = z.object({
	...common,
	source: z.enum(["review", "gate", "ingest"]),
	type: z.literal("event"),
	findingId: z.string(),
	status: z.enum([
		"fixed",
		"open",
		"reopened",
		"approved",
		"skipped",
		"rejected",
	]),
	by: z.enum(["gate-inferred", "no-mistakes", "agent"]),
	step: z.string().nullable().optional(),
	atHead: z.string().nullable(),
	fixCommit: z.string().nullable(),
	path: z.string().nullable(),
	title: z.string(),
	severity: z.string(),
	note: z.string().nullable(),
});
export type EventRecord = z.infer<typeof EventRecord>;

export const AnnotationRecord = z.object({
	v: z.literal(1),
	type: z.literal("annotation"),
	ts: z.string(),
	runId: z.string(),
	repo: z.string(),
	branch: z.string().nullable(),
	implementer: Implementer,
});
export type AnnotationRecord = z.infer<typeof AnnotationRecord>;

export const MistakeRecord = z.discriminatedUnion("type", [
	RunRecord,
	FindingRecord,
	EventRecord,
	AnnotationRecord,
]);
export type MistakeRecord = z.infer<typeof MistakeRecord>;
