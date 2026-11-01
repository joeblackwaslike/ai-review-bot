import { parseAgentsMarker } from "./agent-log.js";
import type { Ledger, LedgerEntry } from "./ledger/types.js";
import { readMetadataValue } from "./review-metadata.js";
import {
	findingId,
	moreSevere,
	type PersistedFinding,
	parseBodyFindings,
	type ReviewState,
	recoverLocation,
} from "./review-state.js";

export type DerivedBaseline = { state: ReviewState; complete: boolean };

const UNANCHORED_BULLET = /^>\s*-\s*(🔴|🟠|🟡|🟢)\s*(\*\*.+\*\*.*)$/;

/** Most ids the `ai-review:carry` marker lists. */
export const MAX_CARRY_IDS = 50;

function withRecoveredPath(f: PersistedFinding): PersistedFinding {
	const r = recoverLocation(f);
	return r === f ? f : { ...r, id: findingId(r.path, r.line, r.title) };
}

/** A ledger entry as the open finding a baseline carries. */
export function ledgerEntryFinding(e: LedgerEntry): PersistedFinding {
	return withRecoveredPath({
		id: findingId(e.path, e.line, e.title),
		path: e.path,
		line: e.line,
		title: e.title,
		severity: e.severity,
		status: "open",
	});
}

function bodyFindings(body: string): PersistedFinding[] {
	const bulletRows = body
		.split("\n")
		.map((l) => l.match(UNANCHORED_BULLET))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => `| ${m[1]} | ${m[2]} |`);
	return parseBodyFindings([body, ...bulletRows].join("\n")).map(
		withRecoveredPath,
	);
}

export function deriveBaseline(
	source: { id: number; body: string } | null,
	ledger: { entries: Ledger; reviewIds: number[]; warm: boolean },
	knownSkills: ReadonlySet<string>,
): DerivedBaseline | null {
	if (!source) return null;
	const body = source.body;
	const metaSha = readMetadataValue(body, "sha");
	const sha =
		(metaSha && /^[0-9a-f]{7,40}$/.test(metaSha) ? metaSha : undefined) ??
		body.match(/Reviewed commit: `([0-9a-f]{7,40})`/)?.[1];
	if (!sha) return null;
	const metaCount = readMetadataValue(body, "review");
	const count = metaCount && /^\d+$/.test(metaCount) ? metaCount : undefined;

	const round = ledger.reviewIds.indexOf(source.id);
	const carried = new Set(
		(readMetadataValue(body, "carry") ?? "")
			.split(",")
			.filter(Boolean)
			.slice(0, MAX_CARRY_IDS),
	);
	const fromLedger: PersistedFinding[] = ledger.entries
		.filter(
			(e) =>
				e.status === "open" &&
				!e.advisory &&
				((e.round === round && !e.id.includes(":body:")) || carried.has(e.id)),
		)
		.map(ledgerEntryFinding);

	const byId = new Map<string, PersistedFinding>();
	for (const f of [...fromLedger, ...bodyFindings(body)]) {
		const seen = byId.get(f.id);
		byId.set(
			f.id,
			seen ? { ...seen, severity: moreSevere(seen.severity, f.severity) } : f,
		);
	}
	const findings = [...byId.values()];

	const complete = ledger.warm
		? round >= 0
		: /^Inline comments: none$/m.test(body);
	return {
		state: {
			lastReviewedSha: sha,
			event: findings.length > 0 ? "REQUEST_CHANGES" : "COMMENT",
			findings,
			reviewedAt: new Date().toISOString(),
			reviewCount: count !== undefined ? Number.parseInt(count, 10) : 0,
			incompleteSkills: parseAgentsMarker(body, knownSkills)?.pending ?? [],
		},
		complete,
	};
}
