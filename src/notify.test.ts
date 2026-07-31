import { describe, expect, it, vi } from "vitest";
import {
	notifyQuotaExhausted,
	quotaIssueBody,
	quotaIssueMarker,
	quotaIssueTitle,
} from "./notify.js";

const base = {
	provider: "openai",
	billing: "https://platform.openai.com/settings/organization/billing",
	owner: "o",
	repo: "r",
	pullNumber: 7,
};

describe("quota issue content", () => {
	it("names the provider in the title", () => {
		expect(quotaIssueTitle("openai")).toContain("OpenAI");
		expect(quotaIssueTitle("anthropic")).toContain("Anthropic");
	});

	it("says plainly that waiting will not fix it", () => {
		const body = quotaIssueBody(base);
		expect(body).toContain("does not clear on its own");
		expect(body).toContain("needs payment");
	});

	it("carries the billing link", () => {
		expect(quotaIssueBody(base)).toContain(base.billing);
	});

	it("embeds a per-provider marker so a repeat outage finds this issue", () => {
		const body = quotaIssueBody(base);
		expect(body).toContain(quotaIssueMarker("openai"));
		expect(body).not.toContain(quotaIssueMarker("anthropic"));
	});
});

describe("notifyQuotaExhausted", () => {
	it("opens an issue when none is open", async () => {
		const request = vi.fn(
			async (route: string, _params?: Record<string, unknown>) =>
				route.startsWith("GET")
					? { data: { total_count: 0, items: [] } }
					: { data: { html_url: "https://github.com/o/r/issues/1" } },
		);
		const result = await notifyQuotaExhausted({
			...base,
			octokit: { request } as never,
		});
		expect(result.created).toBe(true);
		const post = request.mock.calls.find((c) => c[0].startsWith("POST"));
		expect(post).toBeDefined();
	});

	it("does not duplicate an already-open issue", async () => {
		const request = vi.fn(
			async (_route: string, _params?: Record<string, unknown>) => ({
				data: {
					total_count: 1,
					items: [{ number: 4, html_url: "https://github.com/o/r/issues/4" }],
				},
			}),
		);
		const result = await notifyQuotaExhausted({
			...base,
			octokit: { request } as never,
		});
		expect(result).toEqual({
			created: false,
			url: "https://github.com/o/r/issues/4",
		});
		expect(request.mock.calls.some((c) => c[0].startsWith("POST"))).toBe(false);
	});

	it("assigns the issue when an assignee is given", async () => {
		const request = vi.fn(
			async (route: string, _params?: Record<string, unknown>) =>
				route.startsWith("GET")
					? { data: { total_count: 0, items: [] } }
					: { data: { html_url: "u" } },
		);
		await notifyQuotaExhausted({
			...base,
			assignee: "joeblackwaslike",
			octokit: { request } as never,
		});
		const post = request.mock.calls.find((c) => c[0].startsWith("POST"));
		expect((post?.[1] as { assignees: string[] }).assignees).toEqual([
			"joeblackwaslike",
		]);
	});

	// The outage is already reported on the PR and in the logs; a failure to also
	// open an issue must not turn into a second failure on top of it.
	it("swallows an API failure rather than masking the outage it reports", async () => {
		const request = vi.fn(
			async (_route: string, _params?: Record<string, unknown>) => {
				throw new Error("search unavailable");
			},
		);
		await expect(
			notifyQuotaExhausted({ ...base, octokit: { request } as never }),
		).resolves.toEqual({ created: false });
	});
});
