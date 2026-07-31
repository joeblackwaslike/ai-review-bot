import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_THRESHOLDS,
	openProposalIssue,
	planDuplicateIssue,
	planSeverityIssue,
	planSkillIssue,
	proposalMarker,
	thresholdsFromEnv,
} from "./issues.js";
import type { DuplicateCluster, SeverityReliability } from "./trends.js";

function severity(over: Partial<SeverityReliability>): SeverityReliability {
	return {
		severity: "high",
		useful: 1,
		lowValue: 1,
		wrong: 10,
		sampleSize: 12,
		usefulRatio: 1 / 12,
		...over,
	};
}

const opts = { minSample: 8, maxUsefulRatio: 0.3 };

describe("planSeverityIssue", () => {
	it("files the worst qualifying band with its counts", () => {
		const plan = planSeverityIssue([severity({})], opts);
		expect(plan?.signature).toBe("severity_reliability:high");
		expect(plan?.title).toContain("8% useful");
		expect(plan?.body).toContain("| **factually wrong** | **10** |");
	});

	// A 0%-useful band with two samples is noise; filing it trains the reader to
	// ignore these issues.
	it("suppresses a bad ratio that has too few observations", () => {
		expect(
			planSeverityIssue(
				[severity({ sampleSize: 3, useful: 0, usefulRatio: 0 })],
				opts,
			),
		).toBeNull();
	});

	it("does not file a band that is performing acceptably", () => {
		expect(
			planSeverityIssue([severity({ usefulRatio: 0.8 })], opts),
		).toBeNull();
	});

	it("ignores the unlabelled bucket, which is not a severity the reviewer chose", () => {
		expect(
			planSeverityIssue([severity({ severity: "none", usefulRatio: 0 })], opts),
		).toBeNull();
	});

	it("picks the least reliable band when several qualify", () => {
		const plan = planSeverityIssue(
			[
				severity({ severity: "low", usefulRatio: 0.25 }),
				severity({ severity: "high", usefulRatio: 0.05 }),
			],
			opts,
		);
		expect(plan?.signature).toBe("severity_reliability:high");
	});

	it("names a fix surface without prescribing the fix", () => {
		const plan = planSeverityIssue([severity({})], opts);
		expect(plan?.targetFile).toBe("src/prompt.ts");
		expect(plan?.body).toContain("Opened for discussion");
	});
});

describe("planDuplicateIssue", () => {
	const cluster: DuplicateCluster = {
		pr: 18,
		path: "src/github-app.ts",
		identifier: "buildReview",
		findingIds: [1, 2, 3, 4],
		titles: ["a", "b", "c", "d"],
	};

	it("summarises the clusters and their total thread count", () => {
		const plan = planDuplicateIssue([cluster], { minClusters: 1 });
		expect(plan?.title).toContain("4 threads");
		expect(plan?.body).toContain("buildReview");
	});

	it("stays quiet below the threshold", () => {
		expect(planDuplicateIssue([cluster], { minClusters: 2 })).toBeNull();
	});

	it("builds an order-independent signature so cycles dedupe", () => {
		const a = planDuplicateIssue([cluster, { ...cluster, identifier: "z" }], {
			minClusters: 1,
		});
		const b = planDuplicateIssue([{ ...cluster, identifier: "z" }, cluster], {
			minClusters: 1,
		});
		expect(a?.signature).toBe(b?.signature);
	});

	it("renders a missing path rather than printing null", () => {
		const plan = planDuplicateIssue([{ ...cluster, path: null }], {
			minClusters: 1,
		});
		expect(plan?.body).toContain("(no path)");
		expect(plan?.body).not.toContain("`null`");
	});
});

describe("planSkillIssue", () => {
	const signal = {
		skill: "code-reviewer.md",
		useful: 2,
		negative: 10,
		sampleSize: 12,
		negativeRatio: 10 / 12,
	};

	it("files the worst skill above both thresholds", () => {
		const plan = planSkillIssue([signal], {
			minSample: 8,
			minNegativeRatio: 0.5,
		});
		expect(plan?.signature).toBe("skill_signal:code-reviewer.md");
		expect(plan?.targetFile).toBe("skills/code-reviewer.md");
	});

	it("suppresses a small sample", () => {
		expect(
			planSkillIssue([{ ...signal, sampleSize: 3 }], {
				minSample: 8,
				minNegativeRatio: 0.5,
			}),
		).toBeNull();
	});
});

describe("thresholdsFromEnv", () => {
	it("uses defaults when unset and reads configured values", () => {
		expect(thresholdsFromEnv({}).minSample).toBe(DEFAULT_THRESHOLDS.minSample);
		expect(thresholdsFromEnv({ IMPROVE_MIN_SAMPLE: "20" }).minSample).toBe(20);
	});

	// A NaN comparison is always false, so propagating it would switch detection
	// off silently — but the fallback must still be visible, or someone believes
	// a threshold they set is in effect.
	it("falls back on an unparseable value and says so", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(thresholdsFromEnv({ IMPROVE_MIN_SAMPLE: "eight" }).minSample).toBe(
			DEFAULT_THRESHOLDS.minSample,
		);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("IMPROVE_MIN_SAMPLE"),
		);
		warn.mockRestore();
	});

	it("treats an empty string as unset without warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(thresholdsFromEnv({ IMPROVE_MIN_CLUSTERS: "  " }).minClusters).toBe(
			DEFAULT_THRESHOLDS.minClusters,
		);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("openProposalIssue", () => {
	const plan = {
		kind: "severity_reliability" as const,
		signature: "severity_reliability:high",
		title: "t",
		body: "b",
		targetFile: "src/prompt.ts",
	};

	it("opens an issue carrying its signature marker", async () => {
		const request = vi.fn(
			async (route: string, _p?: Record<string, unknown>) =>
				route.startsWith("GET")
					? { data: { items: [] } }
					: { data: { html_url: "u" } },
		);
		const result = await openProposalIssue({
			octokit: { request } as never,
			owner: "o",
			repo: "r",
			plan,
		});
		expect(result.action).toBe("created");
		const post = request.mock.calls.find(
			(c) => c[0] === "POST /repos/{owner}/{repo}/issues",
		);
		expect((post?.[1] as { body: string }).body).toContain(
			proposalMarker(plan.signature),
		);
	});

	// A recurrence is evidence on the existing discussion, not a new one.
	it("comments on the open issue instead of opening a second", async () => {
		const request = vi.fn(
			async (_route: string, _p?: Record<string, unknown>) => ({
				data: { items: [{ number: 9, html_url: "u9" }] },
			}),
		);
		const result = await openProposalIssue({
			octokit: { request } as never,
			owner: "o",
			repo: "r",
			plan,
		});
		expect(result).toEqual({ action: "commented", url: "u9" });
		expect(
			request.mock.calls.some(
				(c) => c[0] === "POST /repos/{owner}/{repo}/issues",
			),
		).toBe(false);
	});

	it("writes nothing on a dry run", async () => {
		const request = vi.fn(
			async (_route: string, _p?: Record<string, unknown>) => ({
				data: { items: [] },
			}),
		);
		const result = await openProposalIssue({
			octokit: { request } as never,
			owner: "o",
			repo: "r",
			plan,
			dryRun: true,
		});
		// Distinct from would_comment: an operator needs to know whether this
		// would open a new discussion or add to one already open.
		expect(result.action).toBe("would_create");
		expect(request.mock.calls.every((c) => c[0].startsWith("GET"))).toBe(true);
	});

	it("reports would_comment on a dry run when an issue is already open", async () => {
		const request = vi.fn(
			async (_route: string, _p?: Record<string, unknown>) => ({
				data: { items: [{ number: 9, html_url: "u9" }] },
			}),
		);
		const result = await openProposalIssue({
			octokit: { request } as never,
			owner: "o",
			repo: "r",
			plan,
			dryRun: true,
		});
		expect(result).toEqual({ action: "would_comment", url: "u9" });
	});

	// One plan failing must not abandon the others in the same cycle; the cycle
	// is idempotent, so a failed proposal is retried on the next run.
	it("reports failure instead of throwing when GitHub is unreachable", async () => {
		const request = vi.fn(
			async (_route: string, _p?: Record<string, unknown>) => {
				throw new Error("502");
			},
		);
		await expect(
			openProposalIssue({
				octokit: { request } as never,
				owner: "o",
				repo: "r",
				plan,
			}),
		).resolves.toEqual({ action: "failed" });
	});
});
