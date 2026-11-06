import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { StrategyResult } from "../strategy.js";
import type { Provider } from "../types.js";

export interface CellKey {
	strategy: string;
	version: string;
	fixtureId: string;
	round: number;
	trial: number;
}

export interface CellRecord {
	key: CellKey;
	provider: Provider;
	planHash: string;
	at: string;
	costUsd: number;
	fitIn210s: boolean;
	failedAttempts: number;
	cacheTemperature: "cold" | "warm" | "unknown";
	/** Set when the strategy spent past the budget it was given. */
	overCap?: { allowedUsd: number; actualUsd: number };
	result: Pick<
		StrategyResult,
		| "findings"
		| "candidates"
		| "posted"
		| "agentReviews"
		| "usage"
		| "toolCalls"
		| "wallMs"
		| "spend"
	>;
}

export type StoredCell = CellRecord & { stale: boolean };

export function defaultExperimentsDir(): string {
	const override = process.env.AI_REVIEW_EXPERIMENTS_DIR?.trim();
	return override || join(homedir(), ".ai-review", "experiments");
}

export const cellId = (k: CellKey): string =>
	`${k.strategy}\u0000${k.version}\u0000${k.fixtureId}\u0000${k.round}\u0000${k.trial}`;

const Candidate = z.object({
	skill: z.string().nullable(),
	title: z.string(),
	path: z.string().nullable(),
	line: z.number().nullable(),
	severity: z.string().nullable(),
});

const Usage = z.record(
	z.string(),
	z.object({
		promptTokens: z.number(),
		completionTokens: z.number(),
		cachedInputTokens: z.number().optional(),
		reasoningTokens: z.number().optional(),
	}),
);

/** The review body stays loose (any object): `ModelReview` evolves and old results must stay readable. */
const CellRecordSchema = z.object({
	key: z.object({
		strategy: z.string(),
		version: z.string(),
		fixtureId: z.string(),
		round: z.number(),
		trial: z.number(),
	}),
	provider: z.enum(["anthropic", "openai"]),
	planHash: z.string(),
	at: z.string(),
	costUsd: z.number(),
	fitIn210s: z.boolean(),
	failedAttempts: z.number(),
	cacheTemperature: z.enum(["cold", "warm", "unknown"]),
	overCap: z
		.object({ allowedUsd: z.number(), actualUsd: z.number() })
		.optional(),
	result: z.object({
		findings: z.array(
			z.object({
				title: z.string(),
				path: z.string().nullable(),
				line: z.number().nullable(),
				body: z.string().optional(),
				severity: z.string().optional(),
				suppressible: z.boolean().optional(),
			}),
		),
		candidates: z.array(Candidate),
		posted: z.array(Candidate),
		agentReviews: z.array(
			z.object({ skill: z.string(), review: z.object({}).passthrough() }),
		),
		usage: Usage,
		toolCalls: z.array(
			z.object({ name: z.string(), wallMs: z.number(), costUsd: z.number() }),
		),
		wallMs: z.number(),
		spend: z
			.object({
				targetUsd: z.number().nullable(),
				achievedUsd: z.number(),
				withinTolerance: z.boolean(),
				failedAttempts: z.number(),
			})
			.optional(),
	}),
});

/** Append-only JSONL results for one plan. Nothing is rewritten or deleted. */
export class ResultsStore {
	readonly file: string;

	constructor(root: string = defaultExperimentsDir(), planHashValue: string) {
		const dir = join(root, planHashValue);
		mkdirSync(dir, { recursive: true });
		this.file = join(dir, "results.jsonl");
	}

	append(record: CellRecord): void {
		appendFileSync(this.file, `${JSON.stringify(record)}\n`);
	}

	hasCell(key: CellKey): boolean {
		const id = cellId(key);
		return this.readAll().records.some((r) => cellId(r.key) === id);
	}

	/** `registered` maps strategy name to its current version; a record from another version is flagged stale. */
	readAll(registered: Record<string, string> = {}): {
		records: StoredCell[];
		skipped: number;
	} {
		const records: StoredCell[] = [];
		let skipped = 0;
		if (!existsSync(this.file)) return { records, skipped };
		for (const line of readFileSync(this.file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = CellRecordSchema.parse(JSON.parse(line)) as CellRecord;
				const current = registered[parsed.key.strategy];
				records.push({
					...parsed,
					stale: current !== undefined && current !== parsed.key.version,
				});
			} catch {
				skipped++;
			}
		}
		return { records, skipped };
	}
}
