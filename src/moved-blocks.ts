/** A file of a push as GitHub's compare API reports it. */
export interface PushFile {
	filename: string;
	status: string;
	previous_filename?: string;
	patch?: string;
	additions: number;
	deletions: number;
}

/**
 * Lines deleted from one file and added to another in the same push. `lineCount` counts
 * only meaningful lines (and decides match eligibility); `spanLines` is every line of the
 * matched run on each side, blank and lone-bracket lines included, and is what a move
 * discounts from the file totals.
 */
export interface MovedBlock {
	from: string;
	to: string;
	lineCount: number;
	spanLines: number;
}

/**
 * A maximal run of consecutive deleted or added lines, with the line number of its first line.
 * `region` numbers the stretches between context lines or hunk headers, so a deleted run and
 * its replacement share one region. `hunk` numbers the `@@` hunks. `after` is the context
 * line after the run's change group, or undefined at a hunk header or the end of the patch.
 */
export interface Run {
	index: number;
	filename: string;
	indentSensitive: boolean;
	lines: string[];
	raw: string[];
	startLine: number;
	region: number;
	hunk: number;
	after: string | undefined;
	literalRisk: boolean;
	used: boolean[];
}

/** Matches a file patch that mentions a backtick, a triple quote or a heredoc opener. */
export const UNSAFE_FILE_TEXT = /`|"{3}|'{3}|<<[-~]?\s*["']?\w/;
const MIN_COUNTED_LENGTH = 3;
const MAX_KEY_OCCURRENCES = 50;

const QUOTES = new Set(['"', "'", "`"]);
/** Index of a `//` outside any string literal, or -1; an unterminated quote hides the rest of the line. */
export function lineCommentIndex(line: string): number {
	let i = 0;
	while (i < line.length) {
		const ch = line[i] as string;
		if (ch === "/" && line[i + 1] === "/") return i;
		if (!QUOTES.has(ch)) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
		if (j >= line.length) return -1;
		i = j + 1;
	}
	return -1;
}

/** True when `line` has a `//` outside any string literal; an unterminated quote hides the rest of the line. */
export function hasLineComment(line: string): boolean {
	return lineCommentIndex(line) >= 0;
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
	let hasContent = false;
	while (i < line.length) {
		const ch = line[i] as string;
		if (/\s/.test(ch)) {
			pendingSpace = true;
			i++;
			continue;
		}
		if (pendingSpace && hasContent && (!opts.strip || needsSeparator(out, ch)))
			out += " ";
		pendingSpace = false;
		hasContent = true;
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

/** Splits one file's patch into its runs of deleted and added lines, numbered from the hunk headers. */
export function extractRuns(
	filename: string,
	patch: string | undefined,
): { deleted: Run[]; added: Run[] } {
	const deleted: Run[] = [];
	const added: Run[] = [];
	if (!patch) return { deleted, added };
	const literalRisk = UNSAFE_FILE_TEXT.test(patch);
	const indentSensitive = isIndentSensitive(filename);
	const normalize = (line: string) =>
		normalizeCodeLine(line, { keepIndent: indentSensitive });
	let del: string[] = [];
	let add: string[] = [];
	let delRaw: string[] = [];
	let addRaw: string[] = [];
	let oldLine = 0;
	let newLine = 0;
	let delStart = 0;
	let addStart = 0;
	let region = 0;
	let hunk = 0;
	let awaiting: Run[] = [];
	const flush = (after?: string) => {
		if (del.length) {
			deleted.push({
				index: -1,
				filename,
				indentSensitive,
				lines: del,
				raw: delRaw,
				startLine: delStart,
				region,
				hunk,
				after,
				literalRisk,
				used: del.map(() => false),
			});
		}
		if (add.length) {
			added.push({
				index: -1,
				filename,
				indentSensitive,
				lines: add,
				raw: addRaw,
				startLine: addStart,
				region,
				hunk,
				after,
				literalRisk,
				used: add.map(() => false),
			});
		}
		del = [];
		add = [];
		delRaw = [];
		addRaw = [];
	};
	for (const line of patch.split("\n")) {
		if (line.startsWith("\\")) continue;
		if (line.startsWith("-")) {
			if (add.length) {
				const first = added.length;
				flush(line.slice(1));
				awaiting.push(...added.slice(first));
			}
			if (!del.length) delStart = oldLine;
			del.push(normalize(line.slice(1)));
			delRaw.push(line.slice(1));
			oldLine++;
		} else if (line.startsWith("+")) {
			if (!add.length) addStart = newLine;
			add.push(normalize(line.slice(1)));
			addRaw.push(line.slice(1));
			newLine++;
		} else {
			const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
			const after = header ? undefined : line.slice(1);
			for (const run of awaiting) run.after = after;
			awaiting = [];
			flush(after);
			region++;
			if (header) {
				hunk++;
				oldLine = Number(header[1]);
				newLine = Number(header[2]);
			} else {
				oldLine++;
				newLine++;
			}
		}
	}
	flush();
	return { deleted, added };
}

/** A matched stretch of equal normalized lines between a deleted run and an added run. */
export interface Candidate {
	from: Run;
	to: Run;
	fromStart: number;
	toStart: number;
	length: number;
	/** Length of the head side when it differs from `length`, as in a reformatted move. */
	toLength?: number;
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

/**
 * `allowSameFile` also pairs a deleted and an added run of one file when they lie in
 * different regions. `uniqueBelow` seeds windows shorter than that many counted lines only
 * when the window occurs exactly once among the deleted runs and once among the added runs.
 * `charge` is called before each candidate is extended, and discovery stops when it returns false.
 */
export interface MatchOptions {
	allowSameFile?: boolean;
	uniqueBelow?: number;
	charge?: () => boolean;
}

interface SeedPlan {
	size: number;
	unique: boolean;
}

function seedPlans(minLines: number, options: MatchOptions): SeedPlan[] {
	const plans: SeedPlan[] = [];
	const top = options.uniqueBelow ?? minLines;
	for (let size = minLines; size < top; size++)
		plans.push({ size, unique: true });
	plans.push({ size: Math.max(top, minLines), unique: false });
	return plans;
}

function collectCandidates(
	deleted: Run[],
	added: Run[],
	minLines: number,
	accept?: (c: Candidate) => boolean,
	options: MatchOptions = {},
): Candidate[] {
	const seen = new Set<string>();
	const coveredTo = new Map<string, number>();
	const out: Candidate[] = [];
	for (const plan of seedPlans(minLines, options)) {
		const index = new Map<string, { run: Run; pos: number }[]>();
		for (const run of added) {
			for (const [pos, key] of windowKeys(run, plan.size)) {
				const hits = index.get(key);
				if (!hits) index.set(key, [{ run, pos }]);
				else if (hits.length < MAX_KEY_OCCURRENCES) hits.push({ run, pos });
			}
		}
		const totals = new Map<string, number>();
		if (plan.unique) {
			for (const run of deleted) {
				for (const key of windowKeys(run, plan.size).values())
					totals.set(key, (totals.get(key) ?? 0) + 1);
			}
		}
		for (const run of deleted) {
			const occurrences = new Map<string, number>();
			for (const [pos, key] of windowKeys(run, plan.size)) {
				const n = (occurrences.get(key) ?? 0) + 1;
				occurrences.set(key, n);
				if (n > MAX_KEY_OCCURRENCES) continue;
				if (
					plan.unique &&
					(totals.get(key) !== 1 || index.get(key)?.length !== 1)
				)
					continue;
				for (const hit of index.get(key) ?? []) {
					if (hit.run.indentSensitive !== run.indentSensitive) continue;
					if (
						hit.run.filename === run.filename &&
						(!options.allowSameFile || hit.run.region === run.region)
					)
						continue;
					const diagonal = `${run.index}|${hit.run.index}|${pos - hit.pos}`;
					if (pos < (coveredTo.get(diagonal) ?? 0)) continue;
					if (options.charge && !options.charge()) return out;
					const c = extend(run, pos, hit.run, hit.pos);
					coveredTo.set(diagonal, c.fromStart + c.length);
					if (c.counted < minLines || (accept && !accept(c))) continue;
					const id = `${diagonal}|${c.fromStart}`;
					if (seen.has(id)) continue;
					seen.add(id);
					out.push(c);
				}
			}
		}
	}
	return out;
}

function unusedSegments(
	c: Candidate,
	minLines: number,
	accept?: (c: Candidate) => boolean,
): Candidate[] {
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
		const part: Candidate = {
			from: c.from,
			to: c.to,
			fromStart: c.fromStart + start,
			toStart: c.toStart + start,
			length: k - start,
			counted,
		};
		if (counted >= minLines && (!accept || accept(part))) out.push(part);
	}
	return out;
}

/** Every file's deleted and added runs, indexed in file order. */
export function collectRuns(files: PushFile[]): {
	deleted: Run[];
	added: Run[];
} {
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
	return { deleted, added };
}

/**
 * Selects the non-overlapping exact matches of at least `minLines` counted lines, largest
 * first, and marks their lines used on both runs. `accept` further filters candidates and
 * the unused parts of larger ones. With `options.uniqueBelow` the seed windows start at
 * `minLines` and grow to that size, the shorter ones only when unique; with
 * `options.allowSameFile` a run may pair with a run of its own file from another region.
 */
export function selectMatches(
	deleted: Run[],
	added: Run[],
	minLines: number,
	accept?: (c: Candidate) => boolean,
	options?: MatchOptions,
): Candidate[] {
	const queue: Candidate[] = [];
	for (const c of collectCandidates(
		deleted,
		added,
		minLines,
		accept,
		options,
	)) {
		insertSorted(queue, c);
	}
	const selected: Candidate[] = [];
	for (let c = queue.pop(); c; c = queue.pop()) {
		const free = unusedSegments(c, minLines, accept);
		if (free.length !== 1 || free[0]?.length !== c.length) {
			for (const part of free) insertSorted(queue, part);
			continue;
		}
		for (let k = 0; k < c.length; k++) {
			c.from.used[c.fromStart + k] = true;
			c.to.used[c.toStart + k] = true;
		}
		selected.push(c);
	}
	return selected;
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
	const { deleted, added } = collectRuns(files);
	return selectMatches(deleted, added, Math.max(1, minLines)).map((c) => ({
		from: c.from.filename,
		to: c.to.filename,
		lineCount: c.counted,
		spanLines: c.length,
	}));
}
