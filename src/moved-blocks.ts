/** A file of a push as GitHub's compare API reports it. */
export interface PushFile {
	filename: string;
	status: string;
	previous_filename?: string;
	patch?: string;
	additions: number;
	deletions: number;
}

/** Lines deleted from one file and added to another in the same push. */
export interface MovedBlock {
	from: string;
	to: string;
	lineCount: number;
}

interface Run {
	filename: string;
	lines: string[];
	used: boolean[];
}

const MIN_COUNTED_LENGTH = 3;

function normalize(line: string): string {
	return line.trim().replace(/\s+/g, " ");
}

function countsTowardBlock(line: string): boolean {
	return line.length >= MIN_COUNTED_LENGTH;
}

function extractRuns(
	filename: string,
	patch: string | undefined,
): { deleted: Run[]; added: Run[] } {
	const deleted: Run[] = [];
	const added: Run[] = [];
	if (!patch) return { deleted, added };
	let del: string[] = [];
	let add: string[] = [];
	const flush = () => {
		if (del.length) {
			deleted.push({
				filename,
				lines: del,
				used: del.map(() => false),
			});
		}
		if (add.length) {
			added.push({ filename, lines: add, used: add.map(() => false) });
		}
		del = [];
		add = [];
	};
	for (const line of patch.split("\n")) {
		if (line.startsWith("\\")) continue;
		if (line.startsWith("-")) {
			if (add.length) flush();
			del.push(normalize(line.slice(1)));
		} else if (line.startsWith("+")) {
			add.push(normalize(line.slice(1)));
		} else {
			flush();
		}
	}
	flush();
	return { deleted, added };
}

interface Match {
	from: Run;
	to: Run;
	fromStart: number;
	toStart: number;
	length: number;
	counted: number;
}

function longestMatch(from: Run, to: Run): Match | null {
	let best: Match | null = null;
	let prev = new Array<number>(to.lines.length + 1).fill(0);
	let prevCounted = new Array<number>(to.lines.length + 1).fill(0);
	for (let i = 1; i <= from.lines.length; i++) {
		const cur = new Array<number>(to.lines.length + 1).fill(0);
		const curCounted = new Array<number>(to.lines.length + 1).fill(0);
		for (let j = 1; j <= to.lines.length; j++) {
			const a = from.lines[i - 1] as string;
			if (a === to.lines[j - 1] && !from.used[i - 1] && !to.used[j - 1]) {
				cur[j] = (prev[j - 1] as number) + 1;
				curCounted[j] =
					(prevCounted[j - 1] as number) + (countsTowardBlock(a) ? 1 : 0);
				if (!best || curCounted[j] > best.counted) {
					best = {
						from,
						to,
						fromStart: i - cur[j],
						toStart: j - cur[j],
						length: cur[j],
						counted: curCounted[j],
					};
				}
			}
		}
		prev = cur;
		prevCounted = curCounted;
	}
	return best;
}

/**
 * Finds runs of at least `minLines` lines deleted in one file and added to
 * another. Lines are compared after trimming and collapsing whitespace; lines
 * under 3 characters stay inside a run but do not count toward its length.
 */
export function findMovedBlocks(files: PushFile[], minLines = 5): MovedBlock[] {
	const deleted: Run[] = [];
	const added: Run[] = [];
	for (const f of files) {
		const runs = extractRuns(f.filename, f.patch);
		deleted.push(...runs.deleted);
		added.push(...runs.added);
	}
	const blocks: MovedBlock[] = [];
	for (;;) {
		let best: Match | null = null;
		for (const d of deleted) {
			for (const a of added) {
				if (d.filename === a.filename) continue;
				const m = longestMatch(d, a);
				if (m && (!best || m.counted > best.counted)) best = m;
			}
		}
		if (!best || best.counted < minLines) return blocks;
		for (let k = 0; k < best.length; k++) {
			best.from.used[best.fromStart + k] = true;
			best.to.used[best.toStart + k] = true;
		}
		blocks.push({
			from: best.from.filename,
			to: best.to.filename,
			lineCount: best.counted,
		});
	}
}
