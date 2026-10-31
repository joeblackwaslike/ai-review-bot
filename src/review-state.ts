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
	reviewCount?: number;
	/** Skills that still owe this PR a whole-PR review (the agents marker's
	 * `pending` list). Absent or empty when the source review has no such
	 * marker: none pending. */
	incompleteSkills?: string[];
}

export function findingId(
	path: string | null,
	line: number | null,
	title: string,
): string {
	return `${path ?? "-"}:${line ?? "-"}:${title.toLowerCase().trim()}`;
}

export function parseBodyFindings(body: string): PersistedFinding[] {
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
		// New 3-col format: | emoji | category | **title** |
		const row3 = line.match(
			/^\|\s*(🔴|🟠|🟡|🟢)\s*\|\s*[^|]+\s*\|\s*(.+?)\s*\|$/,
		);
		// Legacy 2-col format: | emoji | **title** |
		const row2 = line.match(/^\|\s*(🔴|🟠|🟡|🟢)\s*\|\s*(.+?)\s*\|$/);
		const row = row3 ?? row2;
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
	return findings;
}
