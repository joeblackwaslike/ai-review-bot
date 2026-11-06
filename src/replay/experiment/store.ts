import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

const isRecord = (v: unknown): v is CellRecord => {
	const r = v as CellRecord | null;
	return (
		!!r &&
		typeof r.key?.strategy === "string" &&
		typeof r.key.version === "string" &&
		typeof r.key.fixtureId === "string" &&
		typeof r.key.round === "number" &&
		typeof r.key.trial === "number" &&
		typeof r.result === "object" &&
		r.result !== null
	);
};

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
				const parsed: unknown = JSON.parse(line);
				if (!isRecord(parsed)) throw new Error("bad record");
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
