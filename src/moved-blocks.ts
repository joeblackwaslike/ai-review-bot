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
	index: number;
	filename: string;
	indentSensitive: boolean;
	lines: string[];
	used: boolean[];
}

const MIN_COUNTED_LENGTH = 3;
const MAX_KEY_OCCURRENCES = 50;

const QUOTES = new Set(['"', "'", "`"]);
/** True when `line` has a `//` outside any string literal; an unterminated quote hides the rest of the line. */
export function hasLineComment(line: string): boolean {
	let i = 0;
	while (i < line.length) {
		const ch = line[i] as string;
		if (ch === "/" && line[i + 1] === "/") return true;
		if (!QUOTES.has(ch)) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
		if (j >= line.length) return false;
		i = j + 1;
	}
	return false;
}

const OPERATOR_CHARS = new Set("+-*/%&|<>=!~^?:");

/** True when removing the space between `before` (the end of `text`) and `next` could merge two tokens. */
export function needsSeparator(text: string, next: string): boolean {
	const last = text.slice(-1);
	if (/\w/.test(last) && /\w/.test(next)) return true;
	return OPERATOR_CHARS.has(last) && OPERATOR_CHARS.has(next);
}

/**
 * Normalizes one source line for formatting-insensitive comparison. Outside string
 * literals (`"`, `'`, backtick, backslash escapes honored) whitespace is trimmed and
 * collapsed to one space, or with `strip` removed unless it separates two word
 * characters (then it stays one space); `keepIndent` keeps the leading
 * whitespace verbatim. Inside a literal every character is kept. An unterminated quote
 * (multi-line template, apostrophe in a comment) keeps the rest of the line verbatim, so
 * the comparison only gets stricter.
 *
 * With `strip` a space survives between two word characters and between two operator
 * characters (`a + ++b` versus `a++ + b`), so `x=-1;` and `x = -1;` compare different: the
 * comparison keeps weight there rather than risk hiding a token change.
 *
 * Known ceiling with `strip`: spaces next to punctuation inside a regex literal (`a - b`
 * versus `a-b`) and the interior lines of a multi-line template literal are not detected,
 * so the comparison errs toward ignoring formatting only in those narrow cases.
 */
export function normalizeCodeLine(
	line: string,
	opts: { strip?: boolean; keepIndent?: boolean } = {},
): string {
	let out = "";
	let i = 0;
	if (opts.keepIndent) {
		while (i < line.length && /\s/.test(line[i] as string)) i++;
		out = line.slice(0, i);
	}
	let pendingSpace = false;
	while (i < line.length) {
		const ch = line[i] as string;
		if (/\s/.test(ch)) {
			pendingSpace = true;
			i++;
			continue;
		}
		if (
			pendingSpace &&
			out.trim() !== "" &&
			(!opts.strip || needsSeparator(out, ch))
		)
			out += " ";
		pendingSpace = false;
		if (!QUOTES.has(ch)) {
			out += ch;
			i++;
			continue;
		}
		let j = i + 1;
		while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
		if (j >= line.length) return out + line.slice(i);
		out += line.slice(i, j + 1);
		i = j + 1;
	}
	return out;
}

const INDENT_SENSITIVE_EXT = /\.(py|pyi|ya?ml|mk)$/i;

/** True for files where leading indentation changes meaning (Python, YAML, Makefile). */
export function isIndentSensitive(filename: string): boolean {
	const name = filename.split("/").pop() ?? filename;
	return name === "Makefile" || INDENT_SENSITIVE_EXT.test(name);
}

function countsTowardBlock(line: string): boolean {
	return line.trimStart().length >= MIN_COUNTED_LENGTH;
}

function extractRuns(
	filename: string,
	patch: string | undefined,
): { deleted: Run[]; added: Run[] } {
	const deleted: Run[] = [];
	const added: Run[] = [];
	if (!patch) return { deleted, added };
	const indentSensitive = isIndentSensitive(filename);
	const normalize = (line: string) =>
		normalizeCodeLine(line, { keepIndent: indentSensitive });
	let del: string[] = [];
	let add: string[] = [];
	const flush = () => {
		if (del.length) {
			deleted.push({
				index: -1,
				filename,
				indentSensitive,
				lines: del,
				used: del.map(() => false),
			});
		}
		if (add.length) {
			added.push({
				index: -1,
				filename,
				indentSensitive,
				lines: add,
				used: add.map(() => false),
			});
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

interface Candidate {
	from: Run;
	to: Run;
	fromStart: number;
	toStart: number;
	length: number;
	counted: number;
}

function countRange(lines: string[], start: number, length: number): number {
	let counted = 0;
	for (let k = start; k < start + length; k++) {
		if (countsTowardBlock(lines[k] as string)) counted++;
	}
	return counted;
}

function compareCandidates(a: Candidate, b: Candidate): number {
	return (
		b.counted - a.counted ||
		a.from.index - b.from.index ||
		a.to.index - b.to.index ||
		a.fromStart + a.length - (b.fromStart + b.length) ||
		a.toStart + a.length - (b.toStart + b.length)
	);
}

function insertSorted(queue: Candidate[], c: Candidate): void {
	let lo = 0;
	let hi = queue.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (compareCandidates(queue[mid] as Candidate, c) > 0) lo = mid + 1;
		else hi = mid;
	}
	queue.splice(lo, 0, c);
}

function windowKeys(run: Run, minLines: number): Map<number, string> {
	const counted: number[] = [];
	run.lines.forEach((line, i) => {
		if (countsTowardBlock(line)) counted.push(i);
	});
	const keys = new Map<number, string>();
	for (let k = 0; k + minLines <= counted.length; k++) {
		const start = counted[k] as number;
		const end = counted[k + minLines - 1] as number;
		keys.set(start, run.lines.slice(start, end + 1).join("\n"));
	}
	return keys;
}

function extend(from: Run, fromPos: number, to: Run, toPos: number): Candidate {
	let fs = fromPos;
	let ts = toPos;
	while (fs > 0 && ts > 0 && from.lines[fs - 1] === to.lines[ts - 1]) {
		fs--;
		ts--;
	}
	let length = fromPos - fs + 1;
	while (
		fs + length < from.lines.length &&
		ts + length < to.lines.length &&
		from.lines[fs + length] === to.lines[ts + length]
	) {
		length++;
	}
	return {
		from,
		to,
		fromStart: fs,
		toStart: ts,
		length,
		counted: countRange(from.lines, fs, length),
	};
}

function collectCandidates(
	deleted: Run[],
	added: Run[],
	minLines: number,
): Candidate[] {
	const index = new Map<string, { run: Run; pos: number }[]>();
	for (const run of added) {
		for (const [pos, key] of windowKeys(run, minLines)) {
			const hits = index.get(key);
			if (!hits) index.set(key, [{ run, pos }]);
			else if (hits.length < MAX_KEY_OCCURRENCES) hits.push({ run, pos });
		}
	}
	const seen = new Set<string>();
	const coveredTo = new Map<string, number>();
	const out: Candidate[] = [];
	for (const run of deleted) {
		const occurrences = new Map<string, number>();
		for (const [pos, key] of windowKeys(run, minLines)) {
			const n = (occurrences.get(key) ?? 0) + 1;
			occurrences.set(key, n);
			if (n > MAX_KEY_OCCURRENCES) continue;
			for (const hit of index.get(key) ?? []) {
				if (
					hit.run.filename === run.filename ||
					hit.run.indentSensitive !== run.indentSensitive
				)
					continue;
				const diagonal = `${run.index}|${hit.run.index}|${pos - hit.pos}`;
				if (pos < (coveredTo.get(diagonal) ?? 0)) continue;
				const c = extend(run, pos, hit.run, hit.pos);
				coveredTo.set(diagonal, c.fromStart + c.length);
				if (c.counted < minLines) continue;
				const id = `${diagonal}|${c.fromStart}`;
				if (seen.has(id)) continue;
				seen.add(id);
				out.push(c);
			}
		}
	}
	return out;
}

function unusedSegments(c: Candidate, minLines: number): Candidate[] {
	const out: Candidate[] = [];
	let k = 0;
	while (k < c.length) {
		if (c.from.used[c.fromStart + k] || c.to.used[c.toStart + k]) {
			k++;
			continue;
		}
		const start = k;
		while (
			k < c.length &&
			!c.from.used[c.fromStart + k] &&
			!c.to.used[c.toStart + k]
		) {
			k++;
		}
		const counted = countRange(c.from.lines, c.fromStart + start, k - start);
		if (counted >= minLines) {
			out.push({
				from: c.from,
				to: c.to,
				fromStart: c.fromStart + start,
				toStart: c.toStart + start,
				length: k - start,
				counted,
			});
		}
	}
	return out;
}

/**
 * Finds runs of at least `minLines` lines deleted in one file and added to
 * another. Lines are compared after trimming and collapsing whitespace outside string literals; lines
 * under 3 characters stay inside a run but do not count toward its length.
 * A window of lines that occurs more than 50 times (repeated boilerplate) is matched
 * only through its first 50 occurrences: counted across all added runs on the added
 * side, and within each deleted run on the deleted side.
 */
export function findMovedBlocks(files: PushFile[], minLines = 5): MovedBlock[] {
	const need = Math.max(1, minLines);
	const deleted: Run[] = [];
	const added: Run[] = [];
	for (const f of files) {
		const runs = extractRuns(f.filename, f.patch);
		deleted.push(...runs.deleted);
		added.push(...runs.added);
	}
	deleted.forEach((r, i) => {
		r.index = i;
	});
	added.forEach((r, i) => {
		r.index = i;
	});
	const queue: Candidate[] = [];
	for (const c of collectCandidates(deleted, added, need)) {
		insertSorted(queue, c);
	}
	const blocks: MovedBlock[] = [];
	for (let c = queue.pop(); c; c = queue.pop()) {
		const free = unusedSegments(c, need);
		if (free.length !== 1 || free[0]?.length !== c.length) {
			for (const part of free) insertSorted(queue, part);
			continue;
		}
		for (let k = 0; k < c.length; k++) {
			c.from.used[c.fromStart + k] = true;
			c.to.used[c.toStart + k] = true;
		}
		blocks.push({
			from: c.from.filename,
			to: c.to.filename,
			lineCount: c.counted,
		});
	}
	return blocks;
}
