import type { KvClient } from "./feedback/kv.js";

export type FindingStatus = "open" | "resolved";

export interface PersistedFinding {
	id: string;
	path: string | null;
	line: number | null;
	title: string;
	severity: string;
	status: FindingStatus;
}

export interface ReviewState {
	lastReviewedSha: string;
	event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
	findings: PersistedFinding[];
	reviewedAt: string;
}

const STATE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days, refreshed on each write

export function stateKey(
	provider: string,
	owner: string,
	repo: string,
	pullNumber: number,
): string {
	return `review-state:${provider}:${owner}/${repo}#${pullNumber}`;
}

export function findingId(
	path: string | null,
	line: number | null,
	title: string,
): string {
	return `${path ?? "-"}:${line ?? "-"}:${title.toLowerCase().trim()}`;
}

export async function saveReviewState(
	kv: KvClient,
	provider: string,
	owner: string,
	repo: string,
	pullNumber: number,
	state: ReviewState,
): Promise<void> {
	await kv.set(
		stateKey(provider, owner, repo, pullNumber),
		JSON.stringify(state),
		STATE_TTL_SECONDS,
	);
}

// Best-effort parse of a prior posted review body into findings. The body format
// is the markdown table produced by generateSummary; we only need titles +
// severity for triage, so a loose parse is acceptable.
//
// NOTE: only GENERAL (table) findings are recoverable from the review body —
// inline comments live on the diff, not in the body, so they cannot be parsed
// back out here. After a cold-KV fallback the triage resolve path therefore
// can't match inline findings that round; the gate simply won't mark them
// resolved, which degrades toward MORE review (a re-review), never less. Once KV
// is warm again, full state (incl. inline findings) is persisted directly and
// this fallback is bypassed.
function parsePriorReview(body: string): ReviewState | null {
	const shaMatch = body.match(/Reviewed commit: `([0-9a-f]{7,40})`/);
	if (!shaMatch) return null;
	const findings: PersistedFinding[] = [];
	// After Phase 1, 🔴 = P0 in new review bodies. Pre-Phase-1 reviews used 🔴 for
	// "high" (→P1), but upgrading those to P0 on re-parse is conservative and acceptable.
	const BADGE_TO_SEVERITY: Record<string, string> = {
		"🔴": "P0", // P0 (critical); pre-Phase-1 "high" findings are conservatively upgraded
		"🟠": "P1", // P1 badge (only emitted after Phase 1 lands)
		"🟡": "P2",
		"🟢": "P3",
	};
	for (const line of body.split("\n")) {
		const row = line.match(/^\|\s*(🔴|🟠|🟡|🟢)\s*\|\s*(.+?)\s*\|$/);
		if (!row) continue;
		const severity = BADGE_TO_SEVERITY[row[1]] ?? "P3";
		const title = row[2].replace(/\*\*/g, "").trim();
		if (!title || title.toLowerCase() === "finding") continue;
		findings.push({
			id: findingId(null, null, title),
			path: null,
			line: null,
			title,
			severity,
			status: "open",
		});
	}
	return {
		lastReviewedSha: shaMatch[1],
		event: findings.length > 0 ? "REQUEST_CHANGES" : "COMMENT",
		findings,
		reviewedAt: new Date().toISOString(),
	};
}

function isReviewState(v: unknown): v is ReviewState {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	return (
		typeof s.lastReviewedSha === "string" &&
		typeof s.event === "string" &&
		Array.isArray(s.findings)
	);
}

const SEVERITY_COMPAT: Record<string, string> = {
	high: "P1",
	medium: "P2",
	low: "P3",
};

function migrateSeverity(s: string): string {
	return SEVERITY_COMPAT[s] ?? s;
}

export async function loadReviewState(
	kv: KvClient,
	provider: string,
	owner: string,
	repo: string,
	pullNumber: number,
	priorOwnReview: string | null,
): Promise<ReviewState | null> {
	const raw = await kv.get(stateKey(provider, owner, repo, pullNumber));
	if (raw) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isReviewState(parsed)) {
				// Migrate legacy severity strings from pre-Phase-1 KV records
				for (const f of parsed.findings) {
					f.severity = migrateSeverity(f.severity);
				}
				return parsed;
			}
			console.warn(
				"review-state: KV entry has unexpected shape; treating as cold",
				{
					provider,
					owner,
					repo,
					pullNumber,
				},
			);
		} catch (err) {
			console.warn("review-state: KV entry is corrupt JSON; treating as cold", {
				provider,
				owner,
				repo,
				pullNumber,
				err,
			});
		}
	}
	if (priorOwnReview) return parsePriorReview(priorOwnReview);
	return null;
}
