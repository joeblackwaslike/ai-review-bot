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
import { DATA_FILE, PROSE_FILE } from "./file-kinds.js";
import type { Operation, Span } from "./types.js";

const MIN_SEED_LINES = 2;

interface Pending {
	op: Operation;
	from: Run;
	fromStart: number;
	fromEnd: number;
	renamed: number;
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

function resolve(chain: Candidate[], budget: WorkBudget): Pending[] {
	const { from, to } = chain[0] as Candidate;
	const holds = (built: Built) =>
		copyBlockQualifies(from, built.fromStart, built.fromEnd);
	const whole = build(chain, true, budget, false, "head");
	if (whole.counted <= whole.limit && holds(whole)) {
		claimTarget(to, whole);
		return [toCopy(from, to, whole)];
	}
	if (chain.length > 1) return chain.flatMap((seed) => resolve([seed], budget));
	const plain = build(chain, false, budget, true, "head");
	if (!holds(plain)) return [];
	claimTarget(to, plain);
	return [toCopy(from, to, plain)];
}

function settle(
	{ op, from, fromStart, fromEnd, renamed }: Pending,
	before: Map<Run, boolean[]>,
): Operation {
	const weighed = op.divergences.filter(
		(d) => d.class === "code" || d.class === "signature",
	).length;
	const hasReceiver = op.divergences.some((d) => d.class === "receiver");
	const count = weighed + renamed + (hasReceiver ? 1 : 0);
	const claimed = before.get(from);
	let sourceNew = false;
	for (let i = fromStart; i < fromEnd; i++)
		if (claimed && !claimed[i]) sourceNew = true;
	return sourceNew
		? { ...op, reviewWeight: Math.max(1, count), shape: { sourceNew: true } }
		: { ...op, reviewWeight: count };
}

/**
 * Finds blocks added in this change that duplicate other code the patch shows: unchanged
 * context lines or another added block. Only added lines no earlier pass claimed can be a
 * copy; a source may be any visible line. A source containing any added line no earlier pass
 * claimed is `shape.sourceNew`: the original is new code in this change too. Among identical
 * duplicates the earliest added block is the source and the later ones are copies, and a
 * context source wins over an added one. A copy needs five counted lines or a whole definition
 * of three lines, at least one line that carries information, and edits inside it are
 * divergences under the relocation limits. Both spans are head-side. Work is drawn from the
 * shared budget and stops when it runs out. JSON and prose files are skipped: repeated records and repeated
 * wording are not copied logic.
 */
export function findCopies(
	files: PushFile[],
	added: Run[],
	budget: WorkBudget,
): Operation[] {
	const skipped = (name: string) =>
		DATA_FILE.test(name) || PROSE_FILE.test(name);
	const code = files.filter((f) => !skipped(f.filename));
	const targets = added.filter((run) => !skipped(run.filename));
	const before = new Map(targets.map((run) => [run, [...run.used]]));
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
		pending.push(...resolve(chain, budget));
	}
	return pending.map((p) => settle(p, before));
}

function weight(chain: Candidate[]): number {
	return chain.reduce((sum, seed) => sum + seed.counted, 0);
}
