import {
	type Candidate,
	collectContextRuns,
	type PushFile,
	type Run,
	selectMatches,
} from "../moved-blocks.js";
import { acceptCopySeed, copyBlockQualifies } from "./acceptance.js";
import { type Built, build, chainSeeds } from "./block-build.js";
import type { WorkBudget } from "./budget.js";
import {
	copyEligible,
	DATA_FILE,
	INDENT_FREE_FILE,
	PROSE_FILE,
	UNMATCHED_FILES,
} from "./file-kinds.js";
import type { Operation, Span } from "./types.js";

const MIN_SEED_LINES = 2;

interface Pending {
	op: Operation;
	from: Run;
	fromStart: number;
	fromEnd: number;
	renamed: number;
}

interface Context {
	budget: WorkBudget;
}

function headSpan(run: Run, start: number, end: number): Span {
	return {
		filename: run.filename,
		side: "head",
		startLine: run.startLine + start,
		endLine: run.startLine + end - 1,
		shown: "full",
	};
}

function toCopy(from: Run, to: Run, built: Built): Pending {
	return {
		op: {
			id: "",
			type: "copy",
			from: [headSpan(from, built.fromStart, built.fromEnd)],
			to: [headSpan(to, built.toStart, built.toEnd)],
			exact: built.divergences.length === 0,
			divergences: built.divergences,
			reviewWeight: 0,
		},
		from,
		fromStart: built.fromStart,
		fromEnd: built.fromEnd,
		renamed: built.renamed,
	};
}

function claimTarget(to: Run, built: Built): void {
	for (let j = built.toStart; j < built.toEnd; j++) to.used[j] = true;
}

function interior(line: string): string {
	const text = line.trim();
	return /["'`/]/.test(text) ? text : text.replace(/\s+/g, " ");
}

function sameText(from: Run, to: Run, built: Built): boolean {
	const spent = (spans: (Span | undefined)[]) => {
		const lines = new Set<number>();
		for (const s of spans)
			if (s) for (let n = s.startLine; n <= s.endLine; n++) lines.add(n);
		return lines;
	};
	const fromSpent = spent(built.divergences.map((d) => d.base));
	const toSpent = spent(built.divergences.map((d) => d.head));
	const rest = (run: Run, start: number, end: number, gone: Set<number>) =>
		run.raw
			.slice(start, end)
			.filter((_, i) => !gone.has(run.startLine + start + i));
	const left = rest(from, built.fromStart, built.fromEnd, fromSpent);
	const right = rest(to, built.toStart, built.toEnd, toSpent);
	if (left.length !== right.length) return false;
	const strict =
		!INDENT_FREE_FILE.test(from.filename) ||
		!INDENT_FREE_FILE.test(to.filename) ||
		from.literalRisk ||
		to.literalRisk;
	return left.every((line, i) => {
		const other = right[i] as string;
		if (line === other) return true;
		if (strict || /\\\s*$/.test(line) || /\\\s*$/.test(other)) return false;
		return interior(line) === interior(other);
	});
}

function resolve(chain: Candidate[], ctx: Context): Pending[] {
	const { from, to } = chain[0] as Candidate;
	const holds = (built: Built) =>
		copyBlockQualifies(from, built.fromStart, built.fromEnd) &&
		sameText(from, to, built);
	const whole = build(chain, true, ctx.budget, false, "head");
	if (whole.counted <= whole.limit && holds(whole)) {
		claimTarget(to, whole);
		return [toCopy(from, to, whole)];
	}
	if (chain.length > 1) return chain.flatMap((seed) => resolve([seed], ctx));
	const plain = build(chain, false, ctx.budget, true, "head");
	if (!holds(plain)) return [];
	claimTarget(to, plain);
	return [toCopy(from, to, plain)];
}

/**
 * Head lines an earlier operation already accounts for: its target lines, except the lines of
 * its own divergences, which carry text the base block did not have.
 */
function reviewedLines(claimed: Operation[]): Map<string, Set<number>> {
	const reviewed = new Map<string, Set<number>>();
	for (const op of claimed) {
		if (op.type === "copy") continue;
		for (const span of op.to) {
			if (span.side !== "head") continue;
			const own = new Set<number>();
			for (let n = span.startLine; n <= span.endLine; n++) own.add(n);
			for (const d of op.divergences)
				if (d.head?.filename === span.filename)
					for (let n = d.head.startLine; n <= d.head.endLine; n++)
						own.delete(n);
			const lines = reviewed.get(span.filename) ?? new Set<number>();
			for (const n of own) lines.add(n);
			reviewed.set(span.filename, lines);
		}
	}
	return reviewed;
}

function settle(
	{ op, from, fromStart, fromEnd, renamed }: Pending,
	reviewed: Map<string, Set<number>>,
): Operation {
	const weighed = op.divergences.filter((d) => d.class === "code").length;
	const hasReceiver = op.divergences.some((d) => d.class === "receiver");
	const count = weighed + renamed + (hasReceiver ? 1 : 0);
	const known = reviewed.get(from.filename);
	let sourceNew = false;
	if (from.index >= 0)
		for (let i = fromStart; i < fromEnd; i++)
			if (known?.has(from.startLine + i) !== true) sourceNew = true;
	return sourceNew
		? { ...op, reviewWeight: Math.max(1, count), shape: { sourceNew: true } }
		: { ...op, reviewWeight: count };
}

/**
 * Finds blocks added in this change that duplicate other code the patch shows: unchanged
 * context lines or another added block. Only added lines no earlier pass claimed can be a
 * copy. A source is `shape.sourceNew` when any of its lines is added and is neither in the
 * target of an exact relocation nor on a relocation divergence line (`claimed` lists the
 * earlier operations). Among identical duplicates the earliest added block is the source, and
 * a context source wins. A copy needs five counted lines or a whole definition, and edits
 * inside it are divergences. Lines differing only in whitespace pair up only in brace
 * languages, else raw text must match. Only files that pass `copyEligible` take part, as
 * source or target. JSON, prose, lockfiles and minified bundles are skipped. Work is drawn
 * from the shared budget.
 */
export function findCopies(
	files: PushFile[],
	added: Run[],
	budget: WorkBudget,
	claimed: Operation[] = [],
): Operation[] {
	const ctx: Context = { budget };
	const eligible = new Set(
		files
			.filter((f) => copyEligible(f.filename, f.patch))
			.map((f) => f.filename),
	);
	const skipped = (name: string) =>
		DATA_FILE.test(name) ||
		PROSE_FILE.test(name) ||
		UNMATCHED_FILES.test(name) ||
		!eligible.has(name);
	const code = files.filter((f) => !skipped(f.filename));
	const targets = added.filter((run) => !skipped(run.filename));
	const sources = [...collectContextRuns(code), ...targets];
	const accept = (c: Candidate) =>
		c.from !== c.to &&
		(c.from.index < 0 || c.from.index < c.to.index) &&
		acceptCopySeed(c, budget);
	const seeds = selectMatches(sources, targets, MIN_SEED_LINES, accept, {
		allowSameFile: true,
		sharedSources: true,
		charge: () => budget.spendExtensions(1),
	});
	const groups = new Map<string, Candidate[]>();
	for (const seed of seeds) {
		const key = `${seed.from.index}|${seed.to.index}`;
		groups.set(key, [...(groups.get(key) ?? []), seed]);
	}
	const chains = [...groups.values()].flatMap(chainSeeds);
	chains.sort(
		(a, b) =>
			weight(b) - weight(a) ||
			(a[0] as Candidate).from.index - (b[0] as Candidate).from.index ||
			(a[0] as Candidate).to.index - (b[0] as Candidate).to.index,
	);
	const pending: Pending[] = [];
	const seedsExhausted = budget.exhausted;
	for (const chain of chains) {
		if (!seedsExhausted && budget.exhausted) break;
		pending.push(...resolve(chain, ctx));
	}
	const reviewed = reviewedLines(claimed);
	return pending.map((p) => settle(p, reviewed));
}

function weight(chain: Candidate[]): number {
	return chain.reduce((sum, seed) => sum + seed.counted, 0);
}
