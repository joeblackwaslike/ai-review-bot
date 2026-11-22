import type { Run } from "../moved-blocks.js";
import { leavesStatementOpen } from "./acceptance.js";
import type { WorkBudget } from "./budget.js";
import { isProseFile, similarity } from "./lexical.js";
import type { Divergence, Operation, Span } from "./types.js";

const DECLARATION =
	/^(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:declare\s+)?(?:const|let|var|static|type|interface|enum)\s+(?:mut\s+)?([A-Za-z_$][\w$]*)/;
const UPPER_CONSTANT = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/;
const SCREAMING_CASE = /^[A-Z][A-Z0-9_]*$/;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const CONTINUES = /[=,([{<:\\+*|&?-]$/;
const MIN_NAME_LENGTH = 3;
const MIN_VALUE_SIMILARITY = 0.5;
const SCRIPT_FAMILY = new Set([
	"js",
	"jsx",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"mts",
	"cts",
]);

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
		if (isProseFile(run.filename)) continue;
		run.lines.forEach((line, at) => {
			const name = declaredName(line);
			if (!name || name.length < MIN_NAME_LENGTH || !isComplete(line)) return;
			if (!topLevel(run.raw[at] as string, name)) return;
			if (leavesStatementOpen(run, at, at + 1)) return;
			const sites = byName.get(name);
			if (sites) sites.push({ run, at });
			else byName.set(name, [{ run, at }]);
		});
	}
	return byName;
}

function family(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase() ?? filename;
	if (SCRIPT_FAMILY.has(ext)) return "script";
	return ext;
}

function value(line: string, name: string): string {
	const text = line.trim();
	const equals = text.indexOf("=");
	return equals >= 0
		? text.slice(equals + 1)
		: text.slice(text.indexOf(name) + name.length);
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

function sameDeclaration(name: string, base: Site, head: Site): boolean {
	if (family(base.run.filename) !== family(head.run.filename)) return false;
	const baseText = (base.run.raw[base.at] as string).trim();
	const headText = (head.run.raw[head.at] as string).trim();
	if (baseText.replace(/\s+/g, " ") === headText.replace(/\s+/g, " "))
		return true;
	return (
		similarity(value(baseText, name), value(headText, name)) >=
		MIN_VALUE_SIMILARITY
	);
}

/**
 * Finds one-line declarations (constants, types, interfaces, enums) deleted from one file and
 * added to another under the same name, whether or not the value changed. The name must be
 * declared once on each side of the whole change, at the top level (not indented, unless
 * SCREAMING_CASE) and with at least 3 characters. Neither line may already belong to a larger
 * relocation or be followed by a line that may continue its statement. The files must share
 * an extension family, a changed value must keep half of the original's tokens, and within
 * one file the lines must lie in different hunks. Each pair draws one candidate from `budget`
 * and the pass stops when the pool runs dry. Multi-line declarations are left to the block
 * matcher.
 */
export function findDeclarationMoves(
	deleted: Run[],
	added: Run[],
	budget?: WorkBudget,
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
			base.run.hunk === head.run.hunk
		)
			continue;
		if (base.run.used[base.at] || head.run.used[head.at]) continue;
		if (!sameDeclaration(name, base, head)) continue;
		if (budget && !budget.spendCandidates(1)) break;
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
