import type { Ledger } from "./ledger/types.js";
import {
	findingId,
	type PersistedFinding,
	parseBodyFindings,
	type ReviewState,
} from "./review-state.js";

export type DerivedBaseline = { state: ReviewState; complete: boolean };

const PATH_SUFFIX = /\s*\(`([^`\s]+):(\d+)`\)$/;
const UNANCHORED_BULLET = /^>\s*-\s*(🔴|🟠|🟡|🟢)\s*(\*\*.+\*\*.*)$/;

function withRecoveredPath(f: PersistedFinding): PersistedFinding {
	if (f.path !== null) return f;
	const m = f.title.match(PATH_SUFFIX);
	if (!m) return f;
	const title = f.title.replace(PATH_SUFFIX, "").trim();
	const line = Number(m[2]);
	return { ...f, id: findingId(m[1], line, title), path: m[1], line, title };
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
): DerivedBaseline | null {
	if (!source) return null;
	const body = source.body;
	const sha =
		body.match(/<!--\s*ai-review:sha=([0-9a-f]{7,40})\s*-->/)?.[1] ??
		body.match(/Reviewed commit: `([0-9a-f]{7,40})`/)?.[1];
	if (!sha) return null;
	const count = body.match(/<!--\s*ai-review:review=(\d+)\s*-->/)?.[1];

	const round = ledger.reviewIds.indexOf(source.id);
	const fromLedger: PersistedFinding[] =
		round < 0
			? []
			: ledger.entries
					.filter(
						(e) =>
							e.round === round &&
							e.status === "open" &&
							!e.id.includes(":body:"),
					)
					.map((e) =>
						withRecoveredPath({
							id: findingId(e.path, e.line, e.title),
							path: e.path,
							line: e.line,
							title: e.title,
							severity: e.severity,
							status: "open",
						}),
					);

	const byId = new Map<string, PersistedFinding>();
	for (const f of [...fromLedger, ...bodyFindings(body)]) {
		if (!byId.has(f.id)) byId.set(f.id, f);
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
		},
		complete,
	};
}
