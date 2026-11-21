import {
	type Candidate,
	collectContextRuns,
	type PushFile,
	type Run,
	selectMatches,
} from "../moved-blocks.js";
import { acceptCopySeed } from "./acceptance.js";
import type { WorkBudget } from "./budget.js";
import { type Built, build, chainSeeds } from "./relocation.js";
import type { Operation, Span } from "./types.js";

const MIN_SEED_LINES = 2;
const DATA_FILE = /\.jsonl?$/i;

interface Pending {
	op: Operation;
	from: Run;
	fromStart: number;
	fromEnd: number;
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
	};
}

function claimTarget(to: Run, built: Built): void {
	for (let j = built.toStart; j < built.toEnd; j++) to.used[j] = true;
}

function resolve(chain: Candidate[], budget: WorkBudget): Pending[] {
	const { from, to } = chain[0] as Candidate;
	const whole = build(chain, true, budget, false, "head");
	if (whole.counted <= whole.limit) {
		claimTarget(to, whole);
		return [toCopy(from, to, whole)];
	}
	if (chain.length > 1) return chain.flatMap((seed) => resolve([seed], budget));
	const plain = build(chain, false, budget, true, "head");
	claimTarget(to, plain);
	return [toCopy(from, to, plain)];
}

function settle({ op, from, fromStart, fromEnd }: Pending): Operation {
	const weighed = op.divergences.filter(
		(d) => d.class === "code" || d.class === "signature",
	).length;
	const hasReceiver = op.divergences.some((d) => d.class === "receiver");
	const count = Math.max(weighed, hasReceiver ? 1 : 0);
	let sourceNew = from.index >= 0;
	for (let i = fromStart; i < fromEnd; i++) if (from.used[i]) sourceNew = false;
	return sourceNew
		? { ...op, reviewWeight: Math.max(1, count), shape: { sourceNew: true } }
		: { ...op, reviewWeight: count };
}

/**
 * Finds blocks added in this change that duplicate other code the patch shows: unchanged
 * context lines or another added block. Only added lines no earlier pass claimed can be a
 * copy; a source may be any visible line. A source made only of added lines no earlier pass
 * claimed is `shape.sourceNew`: the original is new code in this change too. Among identical
 * duplicates the earliest added block is the source and the later ones are copies, and a
 * context source wins over an added one. A copy needs five counted lines or a whole definition
 * of three lines, at least one line that carries information, and edits inside it are
 * divergences under the relocation limits. Both spans are head-side. Work is drawn from the
 * shared budget and stops when it runs out. JSON files are skipped: repeated records in data
 * files are structure, not copied logic.
 */
export function findCopies(
	files: PushFile[],
	added: Run[],
	budget: WorkBudget,
): Operation[] {
	const code = files.filter((f) => !DATA_FILE.test(f.filename));
	const targets = added.filter((run) => !DATA_FILE.test(run.filename));
	const sources = [...collectContextRuns(code), ...targets];
	const accept = (c: Candidate) =>
		c.from !== c.to &&
		(c.from.index < 0 || c.from.index < c.to.index) &&
		acceptCopySeed(c, budget);
	const seeds = selectMatches(sources, targets, MIN_SEED_LINES, accept, {
		allowSameFile: true,
		sharedSources: true,
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
	return pending.map(settle);
}

function weight(chain: Candidate[]): number {
	return chain.reduce((sum, seed) => sum + seed.counted, 0);
}
