import { createHash } from "node:crypto";

/** Why the pipeline dropped or held back a finding. `DISCARDED_BY_VERIFY` is
 * reserved for the D1 verifier and has no producer yet. */
export const DISCARD_REASONS = [
	"SUPPRESSED_SETTLED",
	"SUPPRESSED_OPEN",
	"RETRACTION",
	"OFF_DIFF",
	"CAP",
	"DISCARDED_BY_VERIFY",
	"RESOLVED_LOCATION",
	"ADAPTIVE_LIMIT",
] as const;
/** Whether a discarded finding was removed outright or still holds the verdict. */
export const DISPOSITIONS = ["dropped", "held"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export type DiscardReason = (typeof DISCARD_REASONS)[number];

/** The anchor-validation failure behind an `OFF_DIFF` discard. */
export const OFF_DIFF_CODES = [
	"OFF_DIFF_PATH",
	"OFF_DIFF_LINE",
	"BAD_RANGE",
] as const;
export type OffDiffCode = (typeof OFF_DIFF_CODES)[number];

/** The finding a discard describes and who reported it. */
export interface DiscardFields {
	title: string;
	path: string | null;
	line: number | null;
	severity: string | null;
	skill: string | null;
	provider: "anthropic" | "openai";
}

/** A finding the review pipeline dropped or held back, with why. Only an
 * `OFF_DIFF` discard carries a code, and only an open restatement is held. */
export type Discard = DiscardFields &
	(
		| { reason: "OFF_DIFF"; code: OffDiffCode; disposition: "dropped" }
		| { reason: "SUPPRESSED_OPEN"; code: null; disposition: "held" }
		| {
				reason: Exclude<DiscardReason, "OFF_DIFF" | "SUPPRESSED_OPEN">;
				code: null;
				disposition: "dropped";
		  }
	);

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
