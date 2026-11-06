import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VerdictRecord } from "./types.js";

export function defaultAdjudicationDir(): string {
	return (
		process.env.AI_REVIEW_ADJUDICATION_DIR ??
		join(homedir(), ".ai-review", "adjudication")
	);
}

interface Line<T> {
	key: string;
	record: T;
}

export class VerdictCache<T = VerdictRecord> {
	skippedLines = 0;
	private readonly loaded = new Map<string, Map<string, T>>();

	constructor(private readonly dir: string = defaultAdjudicationDir()) {}

	get(snapshot: string, key: string): T | undefined {
		return this.load(snapshot).get(key);
	}

	put(snapshot: string, key: string, record: T): void {
		const entries = this.load(snapshot);
		entries.set(key, record);
		mkdirSync(this.dir, { recursive: true });
		const file = this.file(snapshot);
		const body = [...entries]
			.map(([k, r]) => JSON.stringify({ key: k, record: r } satisfies Line<T>))
			.join("\n");
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, `${body}\n`);
		renameSync(temp, file);
	}

	private file(snapshot: string): string {
		return join(this.dir, `${snapshot}.jsonl`);
	}

	private load(snapshot: string): Map<string, T> {
		const cached = this.loaded.get(snapshot);
		if (cached) return cached;
		const entries = new Map<string, T>();
		const file = this.file(snapshot);
		if (existsSync(file)) {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line) as Line<T>;
					if (typeof parsed.key !== "string" || parsed.record === undefined)
						throw new Error("bad line");
					entries.set(parsed.key, parsed.record);
				} catch {
					this.skippedLines++;
				}
			}
		}
		this.loaded.set(snapshot, entries);
		return entries;
	}
}
