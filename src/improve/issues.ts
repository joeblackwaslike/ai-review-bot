import type {
	DuplicateCluster,
	SeverityReliability,
	SkillSignal,
} from "./trends.js";

export interface IssueOctokit {
	request: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<{ data: unknown }>;
}

export type ProposalKind =
	| "severity_reliability"
	| "duplicate_claims"
	| "skill_signal";

export interface ProposalPlan {
	kind: ProposalKind;
	/** Stable identity for this proposal across cycles. One open proposal per
	 * signature; a recurrence while one is open is a comment, not a new issue. */
	signature: string;
	title: string;
	body: string;
	/** Where a fix would most likely go. A suggestion for the discussion, not an
	 * instruction — the issue is opened to decide, not to execute. */
	targetFile: string;
}

const SEVERITY_FIX_SURFACE = "src/prompt.ts";
const DUPLICATE_FIX_SURFACE = "src/review.ts (mergeReviews)";

function evidenceList(lines: string[], cap = 8): string {
	const shown = lines.slice(0, cap);
	const omitted = lines.length - shown.length;
	return [
		...shown.map((l) => `- ${l}`),
		...(omitted > 0 ? [`- _…and ${omitted} more_`] : []),
	].join("\n");
}

/** Pure: a severity band that is measurably unreliable.
 *
 * Returns null unless the band is both bad AND has enough observations to mean
 * something — a 0%-useful band with two samples is noise, and filing it would
 * train the reader to ignore these issues. */
export function planSeverityIssue(
	rows: SeverityReliability[],
	opts: { minSample: number; maxUsefulRatio: number },
): ProposalPlan | null {
	const worst = rows
		.filter((r) => r.severity !== "none" && r.sampleSize >= opts.minSample)
		.filter((r) => r.usefulRatio <= opts.maxUsefulRatio)
		.sort((a, b) => a.usefulRatio - b.usefulRatio)[0];
	if (!worst) return null;

	const pct = Math.round(worst.usefulRatio * 100);
	return {
		kind: "severity_reliability",
		signature: `severity_reliability:${worst.severity}`,
		title: `Severity "${worst.severity}" is ${pct}% useful across ${worst.sampleSize} rated findings`,
		body: [
			`Maintainer feedback says findings the reviewer marks **${worst.severity}** are worth acting on ${pct}% of the time.`,
			"",
			"| outcome | count |",
			"|---|---|",
			`| worth raising | ${worst.useful} |`,
			`| not worth raising | ${worst.lowValue} |`,
			`| **factually wrong** | **${worst.wrong}** |`,
			`| total rated | ${worst.sampleSize} |`,
			"",
			"This matters more than the raw ratio suggests: severity is the signal a reader trusts most, so a band that is confidently wrong costs more than a missing finding.",
			"",
			`**Where a fix would go:** \`${SEVERITY_FIX_SURFACE}\` — either raise the bar for this band or drop it, so the reviewer stops spending its most emphatic label on findings that do not hold up.`,
			"",
			"_Opened for discussion, not as an instruction. Decide the change here; the PR comes afterwards._",
		].join("\n"),
		targetFile: SEVERITY_FIX_SURFACE,
	};
}

/** Pure: repeated restatements of one rejected claim. */
export function planDuplicateIssue(
	clusters: DuplicateCluster[],
	opts: { minClusters: number },
): ProposalPlan | null {
	if (clusters.length < opts.minClusters) return null;
	const total = clusters.reduce((n, c) => n + c.findingIds.length, 0);

	return {
		kind: "duplicate_claims",
		signature: `duplicate_claims:${clusters
			.map((c) => c.identifier)
			.sort()
			.join(",")}`,
		title: `${clusters.length} rejected claims were each filed several times (${total} threads)`,
		body: [
			"Findings the maintainer rejected were restated multiple times in the same file, one thread each.",
			"",
			evidenceList(
				clusters.map(
					(c) =>
						`**×${c.findingIds.length}** \`${c.path ?? "(no path)"}\` — \`${c.identifier}\`\n  ${c.titles
							.slice(0, 3)
							.map((t) => `\n  - ${t}`)
							.join("")}`,
				),
			),
			"",
			"Raising one real bug from several angles is thorough. Restating one *rejected* claim is what crowds out other reviewers — on cc-recall#55 three duplicates of a single false positive displaced a Sourcery finding on the same lines that was correct.",
			"",
			`**Where a fix would go:** \`${DUPLICATE_FIX_SURFACE}\` — dedup currently keys on \`path:line\` plus an exact title match, which cannot catch one root cause surfacing at several locations under different wording. \`detectDuplicateClusters\` in \`src/improve/trends.ts\` already implements the grouping.`,
			"",
			"_Opened for discussion, not as an instruction._",
		].join("\n"),
		targetFile: DUPLICATE_FIX_SURFACE,
	};
}

/** Pure: a skill whose findings are mostly rejected. */
export function planSkillIssue(
	signals: SkillSignal[],
	opts: { minSample: number; minNegativeRatio: number },
): ProposalPlan | null {
	const worst = signals
		.filter(
			(s) =>
				s.sampleSize >= opts.minSample &&
				s.negativeRatio >= opts.minNegativeRatio,
		)
		.sort((a, b) => b.negativeRatio - a.negativeRatio)[0];
	if (!worst) return null;

	const pct = Math.round(worst.negativeRatio * 100);
	return {
		kind: "skill_signal",
		signature: `skill_signal:${worst.skill}`,
		title: `Skill \`${worst.skill}\`: ${pct}% of its findings were rejected (n=${worst.sampleSize})`,
		body: [
			`Of ${worst.sampleSize} rated findings raised by \`${worst.skill}\`, ${worst.negative} were rejected and ${worst.useful} were worth raising.`,
			"",
			`**Where a fix would go:** \`skills/${worst.skill}\` — tighten what it asks for, or narrow when it runs.`,
			"",
			"_Opened for discussion, not as an instruction._",
		].join("\n"),
		targetFile: `skills/${worst.skill}`,
	};
}

const SIGNATURE_MARKER = "<!-- ai-review:proposal:";

export function proposalMarker(signature: string): string {
	return `${SIGNATURE_MARKER}${signature} -->`;
}

/** Open a proposal issue, or comment on the one already open for this
 * signature. Never opens a second issue for the same signal — a recurrence is
 * evidence on the existing discussion, not a new one. */
export async function openProposalIssue(deps: {
	octokit: IssueOctokit;
	owner: string;
	repo: string;
	plan: ProposalPlan;
	dryRun?: boolean;
}): Promise<{ action: "created" | "commented" | "skipped"; url?: string }> {
	const { octokit, owner, repo, plan } = deps;
	const marker = proposalMarker(plan.signature);

	const existing = (await octokit.request("GET /search/issues", {
		q: `repo:${owner}/${repo} is:issue is:open "${marker}"`,
	})) as { data: { items?: { number: number; html_url: string }[] } };
	const open = existing.data.items?.[0];

	if (deps.dryRun) {
		return { action: open ? "skipped" : "skipped", url: open?.html_url };
	}

	if (open) {
		await octokit.request(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
			{
				owner,
				repo,
				issue_number: open.number,
				body: `Still present in the latest cycle.\n\n${plan.body}`,
			},
		);
		return { action: "commented", url: open.html_url };
	}

	const created = (await octokit.request("POST /repos/{owner}/{repo}/issues", {
		owner,
		repo,
		title: plan.title,
		body: `${marker}\n\n${plan.body}`,
		labels: ["ai-review-quality"],
	})) as { data: { html_url: string } };
	return { action: "created", url: created.data.html_url };
}
