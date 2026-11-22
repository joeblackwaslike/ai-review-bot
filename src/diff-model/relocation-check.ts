import { isIndentSensitive, type PushFile } from "../moved-blocks.js";
import { hasBrokenContinuation, hasOddBreak } from "./lexical.js";
import { tokenEquivalent } from "./token-check.js";
import type { Divergence, Operation, Span } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const TRIPLE_QUOTE = /"""|'''/g;
const HEREDOC_OPEN = /<<[-~]?\s*['"]?(\w+)/;
const LITERAL_OPENER = /`|"""|'''|<<[-~]?\s*['"]?\w/;

const HASH_FAMILY =
	/(?:\.(?:py|pyi|rb|sh|bash|zsh|ya?ml|toml|mk)|(?:^|\/)Makefile)$/i;
const C_LINE_COMMENTS =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|java|c|h|cpp|cc|hpp|cs|go|rs|swift|kt|kts|dart|php|scala)$/i;
const C_BLOCK_COMMENTS =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|java|c|h|cpp|cc|hpp|cs|go|rs|swift|kt|kts|dart|php|scala|css|scss|less)$/i;
const WORD =
	/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S/g;
const NAME = /^[A-Za-z_$][\w$]*$/;
const NOT_RENAMABLE = new Set(
	`true false null undefined None True False nil NaN Infinity let const var function return if else for while do in of
	await async yield new this self super public private protected static class interface enum type import export from
	default switch case break continue try catch finally throw typeof instanceof void delete with and or not is as def
	lambda pass del global nonlocal raise except elif end then begin unless until module struct fn mut pub impl trait
	use mod match loop where abstract extends implements final readonly package int string number boolean`.split(
		/\s+/,
	),
);
const LONGEST_RENAMABLE_LINE = 2000;

const SMALL_CLAIM_LINES = 5;
const SMALL_CLAIM_INFORMATION = 30;
const SMALL_SAME_FILE_INFORMATION = 50;
const SMALL_DEFINITION_CHARS = 40;
const MIN_LINE_CHARS = 3;
const FILLER_WORDS = new Set(
	`if else for while do return break continue switch case default try catch finally
	throw new function class def fn func end let const var in of async await yield
	import export from as true false null undefined this self super static public
	private protected void and or not is then pub mut type interface enum extends
	implements with lambda pass assert defer match`.split(/\s+/),
);
const IMPORT_LINE =
	/^(?:import\b|export\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?(?:from\b|;|$)|from\s+\S+\s+import\b|use\s+[\w:{]|require(?:_relative)?\b|#include\b|package\b)|\brequire\s*\(|\bimport\s*\(/;
const LITERALS =
	/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d[\w.]*/g;
const WORDS = /[A-Za-z_$][\w$]*/g;
const DEFINITION_START =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b|def\b|fn\b|func\b|pub\s+fn\b|const\s+[A-Za-z_$]|type\s+\w|interface\s+\w|enum\s+\w)/;
const DEFINITION_END = /^(?:[}\]]|end\b)/;
const ONE_LINE_DECLARATION =
	/^(?:(?:export\s+)?(?:pub\s+)?(?:declare\s+)?(?:const|let|var|static|type|interface|enum)\s+(?:mut\s+)?([A-Za-z_$][\w$]*)|([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=))/;
const SCREAMING = /^[A-Z][A-Z0-9_]*$/;
const SHORTEST_DECLARED_NAME = 3;
const MIN_VALUE_OVERLAP = 0.5;
const OPERATOR_STARTS = "?:,=^%&|*+-.";
const LISTED_STARTS = "?:,+";
const CLOSING_BRACKETS = ")]}";
const OPERATOR_ENDS = "=+*%&|^?:\\([-";
const STATEMENT_ENDS = ";})]";
const MOST_SITES = 50;
const CONTROL_WORDS =
	/^(?:if|else|elif|while|for|foreach|switch|case|when|unless|until|with|try|catch|except|finally|def|class|fn|func|function)\b/;
const DECORATION = /^(?:@[A-Za-z_$]|#!?\[)/;
const SIGNATURE_WORDS =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|def|fn|func|pub\s+fn|interface|enum)\b/;
const CONTINUING_WORDS = /^(?:as|satisfies|instanceof|in)\s/;
const BLOCK_END_WORD = /\b(?:end|fi|done|esac)$/;
const PROSE_NAME = /\.(?:md|mdx|txt|rst|adoc)$/i;

function declaredNameOf(line: string): string | undefined {
	const found = ONE_LINE_DECLARATION.exec(line.trim());
	const name = found?.[1] ?? found?.[2];
	if (name === undefined || name.length < SHORTEST_DECLARED_NAME)
		return undefined;
	return !/^\s/.test(line) || SCREAMING.test(name) ? name : undefined;
}

function declaredValue(line: string, name: string): string {
	const text = line.trim();
	const at = text.indexOf("=");
	return at >= 0
		? text.slice(at + 1)
		: text.slice(text.indexOf(name) + name.length);
}

function fileKind(filename: string): string {
	const ext = (filename.split(".").pop() ?? filename).toLowerCase();
	if (/^(?:[cm]?[jt]sx?)$/.test(ext)) return "script";
	return ext;
}

function valueOverlap(a: string, b: string): number {
	const left = new Set(a.slice(0, LONGEST_RENAMABLE_LINE).match(WORD) ?? []);
	const right = new Set(b.slice(0, LONGEST_RENAMABLE_LINE).match(WORD) ?? []);
	let both = 0;
	for (const word of left) if (right.has(word)) both++;
	const all = left.size + right.size - both;
	return all === 0 ? 0 : both / all;
}

function indentWidth(line: string): number {
	return line.length - line.trimStart().length;
}

function listsItems(filename: string): boolean {
	return isIndentSensitive(filename) || PROSE_NAME.test(filename);
}

function beginsMidStatement(text: string, listy: boolean): boolean {
	const first = text[0];
	if (first === undefined) return false;
	if (CLOSING_BRACKETS.includes(first)) return true;
	if (listy) {
		return (
			text.startsWith("&&") ||
			text.startsWith("||") ||
			text.startsWith("=>") ||
			LISTED_STARTS.includes(first) ||
			/^\.[A-Za-z_$]/.test(text)
		);
	}
	if (OPERATOR_STARTS.includes(first)) return true;
	return first === "/" && !text.startsWith("//") && !text.startsWith("/*");
}

interface Side {
	filename: string;
	lines: string[];
	positions: number[];
	inLiteral: boolean[];
	hunks: Set<number>;
	groups: Set<number>;
	following: string | undefined;
}

interface Entry {
	text: string;
	inLiteral: boolean;
	indentSensitive: boolean;
}

interface PatchRow {
	text: string;
	hunk: number;
	group: number;
	following: string | undefined;
}

interface ParsedPatch {
	deleted: Map<number, PatchRow>;
	added: Map<number, PatchRow>;
	risky: boolean;
}

interface Scanned {
	sign: "-" | "+" | " " | "@";
	text: string;
	row?: PatchRow;
}

const parsedPatches = new WeakMap<PushFile, ParsedPatch>();

function scanPatch(patch: string | undefined): ParsedPatch {
	const out: ParsedPatch = {
		deleted: new Map(),
		added: new Map(),
		risky: LITERAL_OPENER.test(patch ?? ""),
	};
	const scanned: Scanned[] = [];
	let oldLine = 0;
	let newLine = 0;
	let hunk = 0;
	let group = 0;
	let changing = false;
	for (const raw of (patch ?? "").split("\n")) {
		const header = HUNK_HEADER.exec(raw);
		if (header) {
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			hunk++;
			changing = false;
			scanned.push({ sign: "@", text: raw });
		} else if (raw.startsWith("-") || raw.startsWith("+")) {
			if (!changing) group++;
			changing = true;
			const row: PatchRow = {
				text: raw.slice(1),
				hunk,
				group,
				following: undefined,
			};
			if (raw.startsWith("-")) out.deleted.set(oldLine++, row);
			else out.added.set(newLine++, row);
			scanned.push({ sign: raw[0] as "-" | "+", text: row.text, row });
		} else if (raw.startsWith(" ")) {
			changing = false;
			oldLine++;
			newLine++;
			scanned.push({ sign: " ", text: raw.slice(1) });
		}
	}
	let nextBase: string | undefined;
	let nextHead: string | undefined;
	for (let i = scanned.length - 1; i >= 0; i--) {
		const item = scanned[i] as Scanned;
		if (item.sign === "@") {
			nextBase = undefined;
			nextHead = undefined;
			continue;
		}
		if (item.sign !== "+") {
			if (item.row) item.row.following = nextBase;
			nextBase = item.text;
		}
		if (item.sign !== "-") {
			if (item.row) item.row.following = nextHead;
			nextHead = item.text;
		}
	}
	return out;
}

interface RunSet {
	runs: string[][];
	byFirstLine: Map<string, { run: number; at: number }[]>;
}

interface PatchIndex {
	patches: Map<string, ParsedPatch>;
	deleted: RunSet;
	added: RunSet;
	declared: { "-": Map<string, number>; "+": Map<string, number> };
}

const patchIndexes = new WeakMap<readonly PushFile[], PatchIndex>();

function runSetOf(files: readonly PushFile[], sign: "-" | "+"): RunSet {
	const runs = files.flatMap((f) => changedRuns(f.patch, sign));
	const byFirstLine = new Map<string, { run: number; at: number }[]>();
	runs.forEach((run, r) => {
		run.forEach((line, at) => {
			const hits = byFirstLine.get(line);
			if (hits) hits.push({ run: r, at });
			else byFirstLine.set(line, [{ run: r, at }]);
		});
	});
	return { runs, byFirstLine };
}

function declarationCounts(set: RunSet): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of set.byFirstLine.keys()) {
		const found = ONE_LINE_DECLARATION.exec(line);
		const name = found?.[1] ?? found?.[2];
		if (name === undefined) continue;
		counts.set(
			name,
			(counts.get(name) ?? 0) + (set.byFirstLine.get(line)?.length ?? 0),
		);
	}
	return counts;
}

function indexOfPatches(files: readonly PushFile[]): PatchIndex {
	const cached = patchIndexes.get(files);
	if (cached) return cached;
	const patches = new Map<string, ParsedPatch>();
	for (const file of files) {
		if (patches.has(file.filename)) continue;
		let parsed = parsedPatches.get(file);
		if (!parsed) {
			parsed = scanPatch(file.patch);
			parsedPatches.set(file, parsed);
		}
		patches.set(file.filename, parsed);
	}
	const deleted = runSetOf(files, "-");
	const added = runSetOf(files, "+");
	const built = {
		patches,
		deleted,
		added,
		declared: {
			"-": declarationCounts(deleted),
			"+": declarationCounts(added),
		},
	};
	patchIndexes.set(files, built);
	return built;
}

function readSide(spans: Span[], index: PatchIndex): Side[] | null {
	const sides: Side[] = [];
	for (const span of spans) {
		const parsed = index.patches.get(span.filename);
		if (!parsed) return null;
		const source = span.side === "base" ? parsed.deleted : parsed.added;
		const side: Side = {
			filename: span.filename,
			lines: [],
			positions: [],
			inLiteral: [],
			hunks: new Set(),
			groups: new Set(),
			following: undefined,
		};
		for (let n = span.startLine; n <= span.endLine; n++) {
			const row = source.get(n);
			if (row === undefined) return null;
			side.lines.push(row.text);
			side.positions.push(n);
			side.hunks.add(row.hunk);
			side.groups.add(row.group);
			side.following = row.following;
		}
		side.inLiteral = insideLiteral(side.lines);
		sides.push(side);
	}
	return sides;
}

function count(line: string, pattern: RegExp): number {
	return (line.match(pattern) ?? []).length;
}

/**
 * Marks each line that opens, sits inside or closes a multi-line template literal,
 * triple-quoted string or heredoc. A span whose delimiters do not balance is all marked.
 */
function insideLiteral(lines: string[]): boolean[] {
	const marks: boolean[] = [];
	let template = false;
	let triple = false;
	let heredocEnd: string | null = null;
	for (const line of lines) {
		let marked = template || triple || heredocEnd !== null;
		if (heredocEnd !== null && line.trim() === heredocEnd) heredocEnd = null;
		else if (heredocEnd === null) {
			if (count(line, /(?<!\\)`/g) % 2 === 1) {
				template = !template;
				marked = true;
			}
			if (count(line, TRIPLE_QUOTE) % 2 === 1) {
				triple = !triple;
				marked = true;
			}
			const opener = HEREDOC_OPEN.exec(line);
			if (opener) {
				heredocEnd = opener[1] as string;
				marked = true;
			}
		}
		marks.push(marked);
	}
	if (template || triple || heredocEnd !== null) return lines.map(() => true);
	return marks;
}

function claimLine(
	span: Span | undefined,
	sides: Side[],
	spent: Set<string>,
): string | null | undefined {
	if (!span) return undefined;
	if (span.startLine !== span.endLine) return null;
	const side = sides.find((s) => s.filename === span.filename);
	const at = side?.positions.indexOf(span.startLine) ?? -1;
	if (!side || at < 0) return null;
	const key = `${span.filename}:${span.startLine}`;
	if (spent.has(key)) return null;
	spent.add(key);
	return side.lines[at];
}

function supports(
	divergence: Divergence,
	base: string | null | undefined,
	head: string | null | undefined,
): boolean {
	if (base === null || head === null) return false;
	if (divergence.kind === "changed")
		return base !== undefined && head !== undefined && base !== head;
	if (divergence.kind === "removed")
		return base !== undefined && head === undefined;
	return head !== undefined && base === undefined;
}

function unclaimed(sides: Side[], spent: Set<string>): Entry[] {
	return sides.flatMap((side) =>
		side.lines.flatMap((text, i) =>
			spent.has(`${side.filename}:${side.positions[i]}`)
				? []
				: [
						{
							text,
							inLiteral: side.inLiteral[i] as boolean,
							indentSensitive: isIndentSensitive(side.filename),
						},
					],
		),
	);
}

function interior(line: string): string {
	const text = line.trim();
	return /["'`/]/.test(text) ? text : text.replace(/\s+/g, " ");
}

function pairsUp(base: Entry, head: Entry): boolean {
	if (base.text === head.text) return true;
	const safe = (entry: Entry) =>
		!entry.inLiteral &&
		!entry.indentSensitive &&
		!hasBrokenContinuation(entry.text) &&
		!hasOddBreak(entry.text);
	return (
		safe(base) && safe(head) && interior(base.text) === interior(head.text)
	);
}

function accountedPositionally(base: Entry[], head: Entry[]): boolean {
	return (
		base.length === head.length &&
		base.every((entry, i) => pairsUp(entry, head[i] as Entry))
	);
}

function slashStyle(filename: string): boolean {
	return C_LINE_COMMENTS.test(filename);
}

function commentStart(line: string): number {
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
		} else if (ch === "/" && line[i + 1] === "/") {
			return i;
		}
	}
	return -1;
}

function wholeCommentLines(side: Side): boolean[] {
	const lineSlashes = C_LINE_COMMENTS.test(side.filename);
	const blockSlashes = C_BLOCK_COMMENTS.test(side.filename);
	const hash = HASH_FAMILY.test(side.filename);
	let open = false;
	return side.lines.map((raw) => {
		const line = raw.trim();
		if (open) {
			const end = line.indexOf("*/");
			if (end < 0) return true;
			open = false;
			return line.slice(end + 2).trim() === "";
		}
		if (hash && line.startsWith("#")) return true;
		if (lineSlashes && line.startsWith("//")) return true;
		if (!blockSlashes || !line.startsWith("/*")) return false;
		const end = line.indexOf("*/", 2);
		if (end < 0) {
			open = true;
			return true;
		}
		return line.slice(end + 2).trim() === "";
	});
}

function codePart(line: string): string {
	const at = commentStart(line);
	return interior(at < 0 ? line : line.slice(0, at));
}

function commentOnlyHolds(
	divergence: Divergence,
	base: string | undefined,
	head: string | undefined,
	baseWhole: boolean,
	headWhole: boolean,
	slashBoth: boolean,
): boolean {
	if (divergence.kind === "removed") return baseWhole;
	if (divergence.kind === "inserted") return headWhole;
	if (base === undefined || head === undefined) return false;
	if (baseWhole && headWhole) return true;
	if (!slashBoth) return false;
	const differs = commentStart(base) >= 0 || commentStart(head) >= 0;
	return differs && codePart(base) === codePart(head);
}

function words(lines: string[]): string[] {
	return lines.flatMap((line) => line.match(WORD) ?? []);
}

function renamedPairs(base: string, head: string): [string, string][] | null {
	const left = base.match(WORD) ?? [];
	const right = head.match(WORD) ?? [];
	if (left.length !== right.length) return null;
	const pairs: [string, string][] = [];
	for (let i = 0; i < left.length; i++) {
		const a = left[i] as string;
		const b = right[i] as string;
		if (a === b) continue;
		const bothNames = NAME.test(a) && NAME.test(b);
		const free = !NOT_RENAMABLE.has(a) && !NOT_RENAMABLE.has(b);
		const member = left[i - 1] === "." || right[i - 1] === ".";
		if (!bothNames || !free || member) return null;
		pairs.push([a, b]);
	}
	return pairs;
}

function tally(items: string[], item: string): number {
	return items.filter((x) => x === item).length;
}

/**
 * Re-derives a rename claim: the renamed pairs of every claimed rename divergence must form a
 * one-to-one mapping, the new names must be absent from the base span, the old names absent
 * from the head span, and every base occurrence of an old name must sit on a claimed line.
 * Returns the number of distinct renamed identifiers, or null when the claim does not hold.
 */
function verifiedRenames(
	pairsPerLine: [string, string][][],
	baseSides: Side[],
	headSides: Side[],
): number | null {
	const baseLines = baseSides.flatMap((side) => side.lines);
	const headLines = headSides.flatMap((side) => side.lines);
	if (pairsPerLine.length === 0) return 0;
	if (
		[...baseLines, ...headLines].some((l) => l.length > LONGEST_RENAMABLE_LINE)
	)
		return null;
	const forward = new Map<string, string>();
	const backward = new Map<string, string>();
	const occurrences = new Map<string, number>();
	for (const [from, to] of pairsPerLine.flat()) {
		if (forward.get(from) !== undefined && forward.get(from) !== to)
			return null;
		if (backward.get(to) !== undefined && backward.get(to) !== from)
			return null;
		forward.set(from, to);
		backward.set(to, from);
		occurrences.set(from, (occurrences.get(from) ?? 0) + 1);
	}
	const baseWords = words(baseLines);
	const headWords = words(headLines);
	for (const [from, to] of forward) {
		const total = occurrences.get(from) ?? 0;
		if (total < 2 || tally(baseWords, to) > 0 || tally(headWords, from) > 0)
			return null;
		if (tally(baseWords, from) !== total) return null;
	}
	return forward.size;
}

function classesHold(op: Operation, base: Side[], head: Side[]): number | null {
	const wholeBase = new Map(
		base.map((s) => [s.filename, wholeCommentLines(s)]),
	);
	const wholeHead = new Map(
		head.map((s) => [s.filename, wholeCommentLines(s)]),
	);
	const whole = (
		span: Span | undefined,
		sides: Side[],
		marks: Map<string, boolean[]>,
	) => {
		const side = sides.find((s) => s.filename === span?.filename);
		const at = side?.positions.indexOf(span?.startLine ?? -1) ?? -1;
		return at >= 0 && marks.get(side?.filename as string)?.[at] === true;
	};
	let code = 0;
	const renamePairs: [string, string][][] = [];
	for (const d of op.divergences) {
		const baseText = textOf(d.base, base);
		const headText = textOf(d.head, head);
		if (d.class === "code") {
			code++;
		} else if (d.class === "comment-only") {
			const slashBoth =
				slashStyle(d.base?.filename ?? "") &&
				slashStyle(d.head?.filename ?? "");
			if (
				!commentOnlyHolds(
					d,
					baseText,
					headText,
					whole(d.base, base, wholeBase),
					whole(d.head, head, wholeHead),
					slashBoth,
				)
			)
				return null;
		} else if (d.class === "rename") {
			if (
				d.kind !== "changed" ||
				baseText === undefined ||
				headText === undefined
			)
				return null;
			const pairs = renamedPairs(baseText, headText);
			if (!pairs || pairs.length === 0) return null;
			renamePairs.push(pairs);
		} else {
			return null;
		}
	}
	const renamed = verifiedRenames(renamePairs, base, head);
	return renamed === null ? null : code + renamed;
}

function textOf(span: Span | undefined, sides: Side[]): string | undefined {
	const side = sides.find((s) => s.filename === span?.filename);
	const at = side?.positions.indexOf(span?.startLine ?? -1) ?? -1;
	return at < 0 ? undefined : side?.lines[at];
}

/**
 * Checks a relocation claim against the patches without using the matcher's alignment or
 * its helpers. Every line of both spans must be an identical raw pair, a pair that differs
 * only in whitespace outside any multi-line literal of a file without significant
 * indentation, or a divergence the operation lists; a listed divergence the lines do not
 * bear out also fails the claim.
 *
 * A claim whose spans share a file must lie in different change regions with unique text. A
 * claim under 5 counted lines must also pass the small-claim rules of the matching v2 spec.
 * A claim with no divergences that fails the line accounting is instead accepted when
 * `tokenEquivalent` holds, neither file's patch text shows a backtick, triple quote or heredoc
 * opener, and `shape.reindent` matches the checker's shift.
 * The patch scan is built once per `files` array, so a batch is verified in linear time.
 */
export function verifyRelocation(op: Operation, files: PushFile[]): boolean {
	const index = indexOfPatches(files);
	const base = readSide(op.from, index);
	const head = readSide(op.to, index);
	if (!base || !head) return false;
	if (!sameFileHolds(base, head, index)) return false;
	if (!smallClaimHolds(base, head, index)) return false;
	const baseSpent = new Set<string>();
	const headSpent = new Set<string>();
	for (const divergence of op.divergences) {
		const baseLine = claimLine(divergence.base, base, baseSpent);
		const headLine = claimLine(divergence.head, head, headSpent);
		if (!supports(divergence, baseLine, headLine)) return false;
		if (
			divergence.original !== undefined &&
			baseLine !== undefined &&
			baseLine?.trim() !== divergence.original
		)
			return false;
	}
	if (op.exact && op.divergences.length > 0) return false;
	const weight = classesHold(op, base, head);
	if (weight === null || weight !== op.reviewWeight) return false;
	if (
		accountedPositionally(
			unclaimed(base, baseSpent),
			unclaimed(head, headSpent),
		)
	)
		return true;
	return op.divergences.length === 0 && tokenVerified(op, base, head, index);
}

function tokenVerified(
	op: Operation,
	base: Side[],
	head: Side[],
	index: PatchIndex,
): boolean {
	const from = base[0];
	const to = head[0];
	if (base.length !== 1 || head.length !== 1 || !from || !to) return false;
	const tainted = [from, to].some(
		(side) => index.patches.get(side.filename)?.risky ?? false,
	);
	if (tainted) return false;
	const result = tokenEquivalent(
		from.lines,
		to.lines,
		from.filename,
		to.filename,
	);
	return result.equivalent && (op.shape?.reindent ?? 0) === result.reindent;
}

function squeezed(line: string): string {
	return line.trim().replace(/\s+/g, " ");
}

function information(line: string): number {
	const text = line.trim();
	if (text === "" || IMPORT_LINE.test(text)) return 0;
	const rest = text.replace(LITERALS, " ");
	const named = (rest.match(WORDS) ?? []).some((w) => !FILLER_WORDS.has(w));
	const literalOnly = text !== rest && /[^\s,;:()[\]{}]/.test(rest);
	return named || literalOnly ? text.replace(/\s/g, "").length : 0;
}

function isDefinition(lines: string[], indentSensitive: boolean): boolean {
	const present = lines.map((l) => l.trim()).filter((l) => l !== "");
	const first = present[0];
	const last = present[present.length - 1];
	if (first === undefined || last === undefined) return false;
	if (!DEFINITION_START.test(first)) return false;
	if (indentSensitive) return present.length > 1 || !last.endsWith(":");
	return present.length === 1
		? /[}\]][;,]?$/.test(last)
		: DEFINITION_END.test(last);
}

function changedRuns(patch: string | undefined, sign: "-" | "+"): string[][] {
	const runs: string[][] = [];
	let current: string[] | null = null;
	for (const row of (patch ?? "").split("\n")) {
		if (row.startsWith(sign) && !HUNK_HEADER.test(row)) {
			if (!current) {
				current = [];
				runs.push(current);
			}
			current.push(squeezed(row.slice(1)));
		} else {
			current = null;
		}
	}
	return runs;
}

function occurrences(window: string[], set: RunSet): number {
	let found = 0;
	const sites = set.byFirstLine.get(window[0] as string) ?? [];
	if (sites.length > MOST_SITES) return 2;
	for (const { run, at } of sites) {
		const lines = set.runs[run] as string[];
		if (at + window.length > lines.length) continue;
		if (window.every((line, i) => lines[at + i] === line) && ++found > 1) break;
	}
	return found;
}

function distinctEnough(
	sides: Side[],
	index: PatchIndex,
	sign: "-" | "+",
): boolean {
	const set = sign === "-" ? index.deleted : index.added;
	return sides.every((side) => occurrences(side.lines.map(squeezed), set) <= 1);
}

function sharedFiles(base: Side[], head: Side[]): [Side, Side][] {
	return base.flatMap((b) =>
		head
			.filter((h) => h.filename === b.filename)
			.map((h): [Side, Side] => [b, h]),
	);
}

function overlaps(a: Set<number>, b: Set<number>): boolean {
	for (const item of a) if (b.has(item)) return true;
	return false;
}

/** A claim whose sides share a file needs different change regions and unique text on each side. */
function sameFileHolds(base: Side[], head: Side[], index: PatchIndex): boolean {
	const shared = sharedFiles(base, head);
	if (shared.length === 0) return true;
	if (shared.some(([b, h]) => overlaps(b.groups, h.groups))) return false;
	return distinctEnough(base, index, "-") && distinctEnough(head, index, "+");
}

function lastWithText(lines: string[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--)
		if ((lines[i] as string).trim() !== "") return lines[i];
	return undefined;
}

function uncommented(line: string, filename: string): string {
	const hash = isIndentSensitive(filename) || HASH_FAMILY.test(filename);
	const slashes = !hash && C_LINE_COMMENTS.test(filename);
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = "";
		} else if ("\"'`".includes(ch)) {
			quote = ch;
		} else if ((hash && ch === "#") || (slashes && line.startsWith("//", i))) {
			return line.slice(0, i);
		}
	}
	return line;
}

function bracketsBalance(side: Side): boolean {
	const lastAt = side.lines.map((l) => l.trim() !== "").lastIndexOf(true);
	const signature = SIGNATURE_WORDS.test(
		side.lines.find((l) => l.trim() !== "")?.trim() ?? "",
	);
	let depth = 0;
	for (const [at, line] of side.lines.entries()) {
		let code = uncommented(line, side.filename).replace(LITERALS, "");
		if (signature && at === lastAt) code = code.replace(/\{\s*$/, "");
		for (const ch of code) {
			if ("([{".includes(ch)) depth++;
			else if (CLOSING_BRACKETS.includes(ch) && --depth < 0) return false;
		}
	}
	return depth === 0;
}

function startsConstruct(side: Side): boolean {
	const present = side.lines.filter((l) => l.trim() !== "");
	const last = (present[present.length - 1] ?? "").trim();
	if (PROSE_NAME.test(side.filename))
		return (
			present.filter((l) => /^(?:```|~~~)/.test(l.trim())).length % 2 === 1
		);
	const code = side.lines.map((l) => uncommented(l, side.filename)).join("\n");
	const unevenly = (mark: string) => code.split(mark).length % 2 === 0;
	if (unevenly("`") || unevenly('"""') || unevenly("'''")) return true;
	if (DECORATION.test(last)) return true;
	return (
		!isIndentSensitive(side.filename) &&
		CONTROL_WORDS.test(last) &&
		!";}".includes(last[last.length - 1] ?? "")
	);
}

function unfinished(side: Side): boolean {
	if (startsConstruct(side) || !bracketsBalance(side)) return true;
	const present = side.lines.filter((l) => l.trim() !== "");
	return (
		isIndentSensitive(side.filename) &&
		present.length === 1 &&
		(present[0] as string).trimEnd().endsWith(":")
	);
}

function beginsMid(side: Side): boolean {
	const first = side.lines.find((l) => l.trim() !== "")?.trim() ?? "";
	return beginsMidStatement(first, listsItems(side.filename));
}

function mayContinue(side: Side): boolean {
	const last = lastWithText(side.lines);
	if (last === undefined) return false;
	const listy = listsItems(side.filename);
	const code = uncommented(last, side.filename).trimEnd();
	if (code === "") return false;
	if (OPERATOR_ENDS.includes(code[code.length - 1] as string)) return true;
	if (code.endsWith("=>")) return true;
	const next = side.following?.trim() ?? "";
	if (next === "") return false;
	const deeper = indentWidth(side.following as string) > indentWidth(last);
	if (deeper) return true;
	if (CLOSING_BRACKETS.includes(next[0] as string)) return false;
	if (beginsMidStatement(next, listy)) return true;
	if (listy) return false;
	if (CONTINUING_WORDS.test(next) || "([`".includes(next[0] as string))
		return true;
	return (
		!STATEMENT_ENDS.includes(code[code.length - 1] as string) &&
		!BLOCK_END_WORD.test(code)
	);
}

function headDeclares(name: string, base: Side[], head: Side[]): boolean {
	const baseFile = base[0]?.filename ?? "";
	const headLines = head.flatMap((side) =>
		side.lines.filter((l) => l.trim() !== ""),
	);
	if (headLines.length !== 1 || head.length !== 1) return false;
	const text = headLines[0] as string;
	if (declaredNameOf(text) !== name) return false;
	const headFile = head[0]?.filename ?? "";
	if (fileKind(baseFile) !== fileKind(headFile)) return false;
	const baseText = base
		.flatMap((side) => side.lines)
		.find((l) => l.trim() !== "") as string;
	if (squeezed(baseText) === squeezed(text)) return true;
	return (
		valueOverlap(declaredValue(baseText, name), declaredValue(text, name)) >=
		MIN_VALUE_OVERLAP
	);
}

function smallClaimHolds(
	base: Side[],
	head: Side[],
	index: PatchIndex,
): boolean {
	const lines = base.flatMap((side) => side.lines);
	const counted = lines.filter((l) => l.trim().length >= MIN_LINE_CHARS).length;
	if (counted >= SMALL_CLAIM_LINES) return true;
	const headLines = head.flatMap((side) => side.lines);
	if ([...lines, ...headLines].some((l) => l.length > LONGEST_RENAMABLE_LINE))
		return false;
	const shared = sharedFiles(base, head);
	if (shared.some(([b, h]) => overlaps(b.hunks, h.hunks))) return false;
	if ([...base, ...head].some((s) => index.patches.get(s.filename)?.risky))
		return false;
	const present = lines.filter((line) => line.trim() !== "");
	const sensitive = base.some((side) => isIndentSensitive(side.filename));
	const sides = [...base, ...head];
	if (sides.some(unfinished)) return false;
	if (sides.some(mayContinue)) return false;
	if (sides.some(beginsMid)) return false;
	const chars = present.join("").replace(/\s/g, "").length;
	const total = lines.reduce((sum, l) => sum + information(l), 0);
	const sameFile = base.every((side) =>
		head.some((other) => other.filename === side.filename),
	);
	const declared =
		present.length === 1 ? declaredNameOf(present[0] as string) : undefined;
	const informative =
		total >=
			(sameFile ? SMALL_SAME_FILE_INFORMATION : SMALL_CLAIM_INFORMATION) ||
		(isDefinition(lines, sensitive) && chars >= SMALL_DEFINITION_CHARS) ||
		(declared !== undefined &&
			headDeclares(declared, base, head) &&
			index.declared["-"].get(declared) === 1 &&
			index.declared["+"].get(declared) === 1);
	return (
		informative &&
		distinctEnough(base, index, "-") &&
		distinctEnough(head, index, "+")
	);
}
