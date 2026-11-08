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
	const content = createHash("sha256")
		.update(JSON.stringify([item.title, item.text, item.path, item.line]))
		.digest("hex");
	return createHash("sha256")
		.update(
			[
				VERIFIER_PROMPT_HASH,
				judge.model,
				judge.effort,
				item.id,
				item.headSha,
				content,
			].join("|"),
		)
		.digest("hex");
}

/** The cached verdicts, and whether the file ended mid-line (an interrupted append) so the next append must start on a fresh line. */
async function loadCache(file: string): Promise<{
	cache: Map<string, Extract<SpikeOutcome, { kind: "verdict" }>>;
	endsMidLine: boolean;
}> {
	const cache = new Map<string, Extract<SpikeOutcome, { kind: "verdict" }>>();
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return { cache, endsMidLine: false };
		throw new Error(
			`could not read the verdict cache ${file}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const row = JSON.parse(line) as {
				key: string;
				outcome: Extract<SpikeOutcome, { kind: "verdict" }>;
			};
			if (typeof row.key === "string" && row.outcome?.kind === "verdict")
				cache.set(row.key, row.outcome);
		} catch {
			// a line cut short by an interrupted append; the verdict is simply asked for again
		}
	}
	return { cache, endsMidLine: raw.length > 0 && !raw.endsWith("\n") };
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
	const { cache, endsMidLine } = await loadCache(cacheFile);
	let needsNewline = endsMidLine;
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
			const index = next++;
			const task = tasks[index];
			if (!task) return;
			const { item, judge } = task;
			const key = cacheKey(item, judge);
			let outcome: SpikeOutcome | undefined = cache.get(key);
			if (!outcome) {
				if (o.maxCostUsd !== undefined && spentUsd >= o.maxCostUsd) {
					capped = true;
					continue;
				}
				let file = files.get(item.id);
				if (!file) {
					file = o.fileFor(item);
					files.set(item.id, file);
				}
				let fileText: string | null;
				let fileError: unknown;
				try {
					fileText = await file;
				} catch (err) {
					fileText = null;
					fileError = err;
				}
				if (fileText === null) {
					outcome = {
						kind: "unverified",
						why: fileError
							? `file unavailable: ${fileError instanceof Error ? fileError.message : String(fileError)}`
							: `no file at ${item.headSha.slice(0, 8)} for ${item.path}`,
						costUsd: 0,
					};
				} else {
					try {
						const r = await o.call({ judge, item, fileText });
						outcome = { kind: "verdict", ...r };
						spentUsd += r.costUsd;
						cache.set(key, outcome);
					} catch (err) {
						outcome = {
							kind: "unverified",
							why: `call failed: ${err instanceof Error ? err.message : String(err)}`,
							costUsd: 0,
						};
					}
					if (outcome.kind === "verdict") {
						const lead = needsNewline ? "\n" : "";
						needsNewline = false;
						try {
							await appendFile(
								cacheFile,
								`${lead}${JSON.stringify({ key, outcome })}\n`,
							);
						} catch (err) {
							console.warn(
								`could not write the verdict cache ${cacheFile}; this verdict is kept for the run but a rerun will pay for it again: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
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
