import { createHash } from "node:crypto";

export const DISCARD_REASONS = [
	"SUPPRESSED_SETTLED",
	"SUPPRESSED_OPEN",
	"RETRACTION",
	"OFF_DIFF",
	"CAP",
	"DISCARDED_BY_VERIFY",
	"RESOLVED_LOCATION",
] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

export const OFF_DIFF_CODES = [
	"OFF_DIFF_PATH",
	"OFF_DIFF_LINE",
	"BAD_RANGE",
] as const;
export type OffDiffCode = (typeof OFF_DIFF_CODES)[number];

/** A finding the review pipeline dropped or held back, with why. */
export interface Discard {
	reason: DiscardReason;
	code: OffDiffCode | null;
	disposition: "dropped" | "held";
	title: string;
	path: string | null;
	line: number | null;
	severity: string | null;
	skill: string | null;
	provider: "anthropic" | "openai";
}

/** Stable 12-hex key for a finding: sha1 of `path|lowercased trimmed title`.
 * Same formula as the mistake log's `findingKey`, copied because
 * `src/mistakes/` is CLI-only and must not be imported from webhook paths. */
export function discardKey(f: { path: string | null; title: string }): string {
	return createHash("sha1")
		.update(`${f.path ?? ""}|${f.title.toLowerCase().trim()}`)
		.digest("hex")
		.slice(0, 12);
}

/** Log one line per discard record. */
export function logDiscards(
	discards: readonly Discard[],
	ctx: { owner: string; repo: string; pullNumber: number },
): void {
	for (const d of discards) {
		console.log("finding discarded", { ...ctx, ...d });
	}
}
