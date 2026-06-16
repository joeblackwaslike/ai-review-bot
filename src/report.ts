// Renders a durable Markdown code-review report for `docs/code-reviews/`:
// YAML front-matter (for tracking) + an auto-generated table of contents +
// the findings body. Filenames carry a zero-padded round number so multiple
// reviews of the same slug on the same day don't collide.

import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ModelReview } from "./review.js";

export type ReviewStatus = "reviewed" | "implemented" | "wontfix";

export interface ReviewReportMeta {
	title: string;
	/** YYYY-MM-DD */
	date: string;
	/** ISO 8601 timestamp */
	timestamp: string;
	status: ReviewStatus;
	/** "local-changes" | "full-tree" | "commit:<sha>" */
	scope: string;
	remote: string;
	durationSeconds: number;
	costUsd: number;
	providers: string[];
	models: string[];
	skills: string[];
	filesReviewed: number;
}

const SEVERITY_EMOJI: Record<string, string> = {
	high: "🔴",
	medium: "🟡",
	low: "🟢",
};

export function slugify(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "review"
	);
}

/** GitHub-flavoured heading anchor (lowercase, spaces→-, drop punctuation). */
function anchor(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-");
}

/**
 * Allocate the next round-numbered report path: `<date>-<slug>-NN.md`. Scans the
 * target dir for same-day, same-slug files and returns max(NN)+1 (starting 01).
 */
export async function allocateReportPath(opts: {
	docsDir: string;
	date: string;
	slug: string;
	readDir?: (dir: string) => Promise<string[]>;
}): Promise<string> {
	const readDir = opts.readDir ?? ((d) => readdir(d));
	let existing: string[] = [];
	try {
		existing = await readDir(opts.docsDir);
	} catch {
		// dir doesn't exist yet → round 01
	}
	const pattern = new RegExp(
		`^${escapeRe(opts.date)}-${escapeRe(opts.slug)}-(\\d{2})\\.md$`,
	);
	let max = 0;
	for (const name of existing) {
		const m = pattern.exec(name);
		if (m) max = Math.max(max, Number(m[1]));
	}
	const round = String(max + 1).padStart(2, "0");
	return path.join(opts.docsDir, `${opts.date}-${opts.slug}-${round}.md`);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countSeverities(merged: ModelReview): {
	high: number;
	medium: number;
	low: number;
} {
	// Severity is carried on general findings only; inline comments have none.
	const counts = { high: 0, medium: 0, low: 0 };
	for (const f of merged.general_findings)
		counts[f.severity as keyof typeof counts]++;
	return counts;
}

function yamlList(items: string[]): string {
	return `[${items.map((i) => i.replace(/[[\],]/g, "")).join(", ")}]`;
}

function frontMatter(meta: ReviewReportMeta, merged: ModelReview): string {
	const c = countSeverities(merged);
	return [
		"---",
		`title: ${JSON.stringify(meta.title)}`,
		`date: ${meta.date}`,
		`timestamp: ${meta.timestamp}`,
		`status: ${meta.status}`,
		`scope: ${meta.scope}`,
		`remote: ${meta.remote}`,
		`duration_seconds: ${meta.durationSeconds}`,
		`cost_usd: ${meta.costUsd.toFixed(6)}`,
		`providers: ${yamlList(meta.providers)}`,
		`models: ${yamlList(meta.models)}`,
		`skills: ${yamlList(meta.skills)}`,
		`files_reviewed: ${meta.filesReviewed}`,
		"findings:",
		`  high: ${c.high}`,
		`  medium: ${c.medium}`,
		`  low: ${c.low}`,
		"---",
	].join("\n");
}

/** Build the full Markdown report (front-matter + TOC + body). */
export function formatReviewReport(opts: {
	merged: ModelReview;
	meta: ReviewReportMeta;
}): string {
	const { merged, meta } = opts;
	const c = countSeverities(merged);

	// Sections present in this report (drives both the TOC and the body order).
	const sections: string[] = ["Summary"];
	if (merged.general_findings.length > 0) sections.push("Findings");
	if (merged.inline_comments.length > 0) sections.push("Inline Notes");
	sections.push("Metadata");

	const toc = [
		"## Table of Contents",
		"",
		...sections.map((s) => `- [${s}](#${anchor(s)})`),
	];

	const total = merged.general_findings.length + merged.inline_comments.length;
	const body: string[] = [
		`# ${meta.title}`,
		"",
		...toc,
		"",
		"## Summary",
		"",
		`Reviewed **${meta.filesReviewed}** file(s) (${meta.scope}) with ${meta.providers.join(" + ")}. ` +
			`Found **${total}** item(s): ${c.high} high · ${c.medium} medium · ${c.low} low. ` +
			`Took ${meta.durationSeconds}s · $${meta.costUsd.toFixed(4)}.`,
	];

	if (merged.general_findings.length > 0) {
		body.push("", "## Findings");
		for (const [i, f] of merged.general_findings.entries()) {
			body.push(
				"",
				`### ${i + 1}. ${SEVERITY_EMOJI[f.severity] ?? ""} [${f.severity.toUpperCase()}] ${f.title}`,
				"",
				f.body,
			);
		}
	}

	if (merged.inline_comments.length > 0) {
		body.push(
			"",
			"## Inline Notes",
			"",
			"| File | Line | Comment |",
			"|------|------|---------|",
		);
		for (const c2 of merged.inline_comments) {
			const text = c2.body.replace(/[|\n]/g, " ").trim();
			body.push(`| \`${c2.path}\` | ${c2.line} | **${c2.title}**: ${text} |`);
		}
	}

	body.push(
		"",
		"## Metadata",
		"",
		`- **Models:** ${meta.models.join(", ")}`,
		`- **Skills:** ${meta.skills.join(", ")}`,
		`- **Remote:** ${meta.remote}`,
		"",
		"---",
		"*Generated by [ai-review-bot](https://github.com/joeblackwaslike/ai-review-bot). " +
			"Flip `status:` to `implemented` once findings are addressed.*",
		"",
	);

	return `${frontMatter(meta, merged)}\n\n${body.join("\n")}`;
}
