import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { VERIFIER_PROMPT_HASH } from "./prompt.js";
import type {
	RefutationReason,
	SpikeItem,
	SpikeJudge,
	SpikeOutcome,
	SpikeResult,
} from "./types.js";

export interface CallResult {
	refuted: boolean;
	reason: RefutationReason | null;
	rationale: string;
	costUsd: number;
}

export interface RunOptions {
	items: SpikeItem[];
	judgesFor: (item: SpikeItem) => SpikeJudge[];
	fileFor: (item: SpikeItem) => Promise<string | null>;
	call: (a: {
		judge: SpikeJudge;
		item: SpikeItem;
		fileText: string;
	}) => Promise<CallResult>;
	cacheDir: string;
	maxCostUsd?: number;
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
}

export interface RunSummary {
	results: SpikeResult[];
	/** Spent in this run only; verdicts read from the cache cost nothing now. */
	spentUsd: number;
	capped: boolean;
}

function cacheKey(item: SpikeItem, judge: SpikeJudge): string {
	return createHash("sha256")
		.update(
			[
				VERIFIER_PROMPT_HASH,
				judge.model,
				judge.effort,
				item.id,
				item.headSha,
			].join("|"),
		)
		.digest("hex");
}

async function loadCache(
	file: string,
): Promise<Map<string, Extract<SpikeOutcome, { kind: "verdict" }>>> {
	const cache = new Map<string, Extract<SpikeOutcome, { kind: "verdict" }>>();
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return cache;
	}
	for (const line of raw.split("\n")) {
		if (!line) continue;
		const row = JSON.parse(line) as {
			key: string;
			outcome: Extract<SpikeOutcome, { kind: "verdict" }>;
		};
		cache.set(row.key, row.outcome);
	}
	return cache;
}

/**
 * Every judge over every item, in item then judge order. Verdicts are kept in a JSONL cache keyed
 * by prompt, model, effort and item, so a rerun costs nothing and a changed prompt starts fresh.
 * A missing file or a failed call is `unverified` and is not cached. Once new spend reaches the
 * cap no further model call is made.
 */
export async function runSpike(o: RunOptions): Promise<RunSummary> {
	await mkdir(o.cacheDir, { recursive: true });
	const cacheFile = join(o.cacheDir, "verdicts.jsonl");
	const cache = await loadCache(cacheFile);
	const tasks = o.items.flatMap((item) =>
		o.judgesFor(item).map((judge) => ({ item, judge })),
	);
	const slots: (SpikeResult | undefined)[] = new Array(tasks.length);
	const files = new Map<string, Promise<string | null>>();
	let spentUsd = 0;
	let capped = false;
	let next = 0;
	let done = 0;

	const worker = async () => {
		for (;;) {
			if (o.maxCostUsd !== undefined && spentUsd >= o.maxCostUsd) {
				capped = true;
				return;
			}
			const index = next++;
			const task = tasks[index];
			if (!task) return;
			const { item, judge } = task;
			const key = cacheKey(item, judge);
			const cached = cache.get(key);
			let outcome: SpikeOutcome;
			if (cached) {
				outcome = cached;
			} else {
				let file = files.get(item.id);
				if (!file) {
					file = o.fileFor(item);
					files.set(item.id, file);
				}
				const fileText = await file.catch(() => null);
				if (fileText === null) {
					outcome = {
						kind: "unverified",
						why: `no file at ${item.headSha.slice(0, 8)} for ${item.path}`,
						costUsd: 0,
					};
				} else {
					try {
						const r = await o.call({ judge, item, fileText });
						outcome = { kind: "verdict", ...r };
						spentUsd += r.costUsd;
						cache.set(key, outcome);
						await appendFile(
							cacheFile,
							`${JSON.stringify({ key, outcome })}\n`,
						);
					} catch (err) {
						outcome = {
							kind: "unverified",
							why: `call failed: ${err instanceof Error ? err.message : String(err)}`,
							costUsd: 0,
						};
					}
				}
			}
			slots[index] = { itemId: item.id, judgeId: judge.id, outcome };
			done += 1;
			o.onProgress?.(done, tasks.length);
		}
	};

	await Promise.all(
		Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker),
	);
	return {
		results: slots.filter((r): r is SpikeResult => r !== undefined),
		spentUsd,
		capped,
	};
}
