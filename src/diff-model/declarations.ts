import type { Run } from "../moved-blocks.js";
import type { Divergence, Operation, Span } from "./types.js";

const DECLARATION =
	/^(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:declare\s+)?(?:const|let|var|static|type|interface|enum)\s+(?:mut\s+)?([A-Za-z_$][\w$]*)/;
const UPPER_CONSTANT = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/;
const SCREAMING_CASE = /^[A-Z][A-Z0-9_]*$/;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const CONTINUES = /[=,([{<:\\+*|&?-]$/;
const PROSE_FILE = /\.(md|mdx|txt|rst|adoc)$/i;

interface Site {
	run: Run;
	at: number;
}

function declaredName(line: string): string | undefined {
	const match = DECLARATION.exec(line) ?? UPPER_CONSTANT.exec(line);
	return match?.[1];
}

function isComplete(line: string): boolean {
	if (CONTINUES.test(line.trimEnd())) return false;
	let depth = 0;
	for (const ch of line) {
		if (OPENERS.has(ch)) depth++;
		else if (CLOSERS.has(ch)) depth--;
		if (depth < 0) return false;
	}
	return depth === 0;
}

function topLevel(raw: string, name: string): boolean {
	return !/^\s/.test(raw) || SCREAMING_CASE.test(name);
}

function collect(runs: Run[]): Map<string, Site[]> {
	const byName = new Map<string, Site[]>();
	for (const run of runs) {
		if (PROSE_FILE.test(run.filename)) continue;
		run.lines.forEach((line, at) => {
			const name = declaredName(line);
			if (!name || !isComplete(line)) return;
			if (!topLevel(run.raw[at] as string, name)) return;
			byName.set(name, [...(byName.get(name) ?? []), { run, at }]);
		});
	}
	return byName;
}

function lineSpan(run: Run, side: Span["side"], at: number): Span {
	const line = run.startLine + at;
	return {
		filename: run.filename,
		side,
		startLine: line,
		endLine: line,
		shown: "full",
	};
}

/**
 * Finds one-line declarations (constants, types, interfaces, enums) that were deleted from
 * one file and added to another under the same name, whether or not the value changed.
 * The name must be declared once among the deleted lines and once among the added lines of
 * the whole change, at the top level of its file (not indented, unless it is SCREAMING_CASE),
 * and neither line may already belong to a larger relocation. A declaration that spans
 * several lines is left to the block matcher.
 */
export function findDeclarationMoves(
	deleted: Run[],
	added: Run[],
): Operation[] {
	const gone = collect(deleted);
	const arrived = collect(added);
	const out: Operation[] = [];
	for (const [name, from] of gone) {
		const to = arrived.get(name);
		if (from.length !== 1 || to?.length !== 1) continue;
		const base = from[0] as Site;
		const head = to[0] as Site;
		if (
			base.run.filename === head.run.filename &&
			base.run.region === head.run.region
		)
			continue;
		if (base.run.used[base.at] || head.run.used[head.at]) continue;
		const baseText = base.run.raw[base.at] as string;
		const headText = head.run.raw[head.at] as string;
		const exact = baseText.trim() === headText.trim();
		const divergences: Divergence[] = exact
			? []
			: [
					{
						kind: "changed",
						class: "code",
						base: lineSpan(base.run, "base", base.at),
						head: lineSpan(head.run, "head", head.at),
						original: baseText.trim(),
					},
				];
		base.run.used[base.at] = true;
		head.run.used[head.at] = true;
		out.push({
			id: "",
			type: "relocation",
			from: [lineSpan(base.run, "base", base.at)],
			to: [lineSpan(head.run, "head", head.at)],
			exact,
			divergences,
			reviewWeight: divergences.length,
		});
	}
	return out;
}
