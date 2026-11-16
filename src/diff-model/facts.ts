import type { PushFile } from "../moved-blocks.js";
import { classifyFile } from "../push-shape.js";
import type { IntentClaim, PrFacts } from "./types.js";

const INTENT_PHRASES: { phrase: string; pattern: string }[] = [
	{ phrase: "no functional change", pattern: "no functional changes?" },
	{ phrase: "refactor only", pattern: "refactor only" },
	{ phrase: "formatting only", pattern: "formatting only" },
	{ phrase: "whitespace only", pattern: "whitespace only" },
	{ phrase: "rename", pattern: "renames?" },
];

function claimsIn(text: string, source: IntentClaim["source"]): IntentClaim[] {
	return INTENT_PHRASES.flatMap(({ phrase, pattern }) =>
		[...text.matchAll(new RegExp(`\\b${pattern}\\b`, "gi"))].map((m) => ({
			phrase,
			source,
			start: m.index,
			end: m.index + m[0].length,
		})),
	);
}

/**
 * Facts about the whole PR. `testsChanged` is `"unknown"` when the file list is cut short
 * and shows no test file, because a missing path proves nothing.
 */
export function buildPrFacts(input: {
	prFiles: PushFile[];
	prFilesComplete: boolean;
	title: string;
	body: string | null;
}): PrFacts {
	const hasTest = input.prFiles.some(
		(f) => classifyFile(f.filename) === "test",
	);
	return {
		testsChanged: hasTest || (input.prFilesComplete ? false : "unknown"),
		intentClaims: [
			...claimsIn(input.title, "title"),
			...claimsIn(input.body ?? "", "body"),
		],
	};
}
