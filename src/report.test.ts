import { describe, expect, it } from "vitest";
import {
	allocateReportPath,
	formatReviewReport,
	type ReviewReportMeta,
	slugify,
} from "./report.js";
import type { ModelReview } from "./review.js";

const baseMeta: ReviewReportMeta = {
	title: "Review — Local Changes",
	date: "2026-06-15",
	timestamp: "2026-06-15T20:00:00Z",
	status: "reviewed",
	scope: "local-changes",
	remote: "https://github.com/joeblackwaslike/ai-review-bot",
	durationSeconds: 92,
	costUsd: 0.012345,
	providers: ["anthropic", "openai"],
	models: ["claude-sonnet-4-6", "gpt-5"],
	skills: ["code-reviewer", "security-sast"],
	filesReviewed: 14,
};

const review: ModelReview = {
	event: "REQUEST_CHANGES",
	general_findings: [
		{ title: "SQL injection", body: "raw query", severity: "high" },
		{ title: "Loose typing", body: "narrow it", severity: "medium" },
		{ title: "Magic number", body: "extract const", severity: "low" },
	],
	inline_comments: [
		{
			title: "Null deref",
			body: "guard this",
			path: "src/a.ts",
			line: 12,
			start_line: null,
			suggestion: null,
			severity: "high",
		},
	],
};

describe("slugify", () => {
	it("lowercases, hyphenates, trims", () => {
		expect(slugify("Auth Refactor!! (v2)")).toBe("auth-refactor-v2");
		expect(slugify("")).toBe("review");
	});
});

describe("allocateReportPath", () => {
	it("returns round 01 when the dir is empty/missing", async () => {
		const p = await allocateReportPath({
			docsDir: "docs/code-reviews",
			date: "2026-06-15",
			slug: "auth",
			readDir: async () => {
				throw new Error("ENOENT");
			},
		});
		expect(p).toBe("docs/code-reviews/2026-06-15-auth-01.md");
	});

	it("returns max(existing round)+1 for same date+slug", async () => {
		const p = await allocateReportPath({
			docsDir: "docs/code-reviews",
			date: "2026-06-15",
			slug: "auth",
			readDir: async () => [
				"2026-06-15-auth-01.md",
				"2026-06-15-auth-03.md",
				"2026-06-15-other-09.md",
				"2026-06-14-auth-07.md",
			],
		});
		expect(p).toBe("docs/code-reviews/2026-06-15-auth-04.md");
	});
});

describe("formatReviewReport", () => {
	const out = formatReviewReport({ merged: review, meta: baseMeta });

	it("emits YAML front-matter with tracking fields", () => {
		expect(out.startsWith("---\n")).toBe(true);
		expect(out).toContain('title: "Review — Local Changes"');
		expect(out).toContain("status: reviewed");
		expect(out).toContain("scope: local-changes");
		expect(out).toContain(
			"remote: https://github.com/joeblackwaslike/ai-review-bot",
		);
		expect(out).toContain("duration_seconds: 92");
		expect(out).toContain("cost_usd: 0.012345");
		expect(out).toContain('providers: ["anthropic", "openai"]');
		expect(out).toContain("files_reviewed: 14");
		// severity counts: 1 high, 1 medium, 1 low
		expect(out).toContain("high: 1");
		expect(out).toContain("medium: 1");
		expect(out).toContain("low: 1");
	});

	it("includes a table of contents linking present sections", () => {
		expect(out).toContain("## Table of Contents");
		expect(out).toContain("- [Summary](#summary)");
		expect(out).toContain("- [Findings](#findings)");
		expect(out).toContain("- [Inline Notes](#inline-notes)");
	});

	it("renders findings and the inline notes table", () => {
		expect(out).toContain("[HIGH] SQL injection");
		expect(out).toContain("| `src/a.ts` | 12 |");
		expect(out).toContain("Null deref");
	});

	it("omits sections with no content", () => {
		const empty = formatReviewReport({
			merged: { event: "COMMENT", general_findings: [], inline_comments: [] },
			meta: baseMeta,
		});
		expect(empty).not.toContain("## Findings");
		expect(empty).not.toContain("## Inline Notes");
		expect(empty).toContain("## Summary");
	});
});
