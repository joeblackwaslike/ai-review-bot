import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QcAppConfig } from "./config.js";
import { runPrQc } from "./qc-app.js";

const db = { marker: "db" };

const listFindingsForPr = vi.fn();
const recordQcRun = vi.fn();
const finalizeQcRun = vi.fn();
const releaseQcRun = vi.fn();
const reclaimStaleQcRun = vi.fn();
const judgeFinding = vi.fn();

vi.mock("./improve/db/client.js", () => ({ getDb: () => db }));

vi.mock("./improve/db/repo.js", () => ({
	listFindingsForPr: (...args: unknown[]) => listFindingsForPr(...args),
	recordQcRun: (...args: unknown[]) => recordQcRun(...args),
	finalizeQcRun: (...args: unknown[]) => finalizeQcRun(...args),
	releaseQcRun: (...args: unknown[]) => releaseQcRun(...args),
	reclaimStaleQcRun: (...args: unknown[]) => reclaimStaleQcRun(...args),
}));

vi.mock("./improve/qc.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./improve/qc.js")>()),
	judgeFinding: (...args: unknown[]) => judgeFinding(...args),
}));

const config: QcAppConfig = {
	appId: "1",
	privateKey: "k",
	webhookSecret: "s",
	command: "/qc",
	commentPrefix: "ai-review-qc",
	sampleRate: 1,
	enabled: true,
};

function catalogRow(over: Record<string, unknown> = {}) {
	return {
		id: 1,
		provider: "anthropic" as const,
		commentId: 900,
		path: "src/x.ts",
		line: 10,
		title: "a finding",
		severity: "high",
		...over,
	};
}

function verdict() {
	return {
		isFalsePositive: false,
		isUseful: true,
		severityCorrect: true,
		suggestedSeverity: null,
		rationale: "holds up",
	};
}

/** Minimal octokit: routes by the request path so a test can fail one endpoint
 * without stubbing the others. */
function stubOctokit(over: Record<string, unknown> = {}) {
	const posted: string[] = [];
	const request = vi.fn(
		async (route: string, params: Record<string, string>) => {
			if (route.includes("/pulls/{pull_number}")) {
				return { data: { head: { sha: "HEAD1" } } };
			}
			if (route.includes("/pulls/comments/")) {
				const handler = over.comment;
				if (typeof handler === "function") return handler(params);
				return {
					data: {
						body: "🔴 **High**\n\n**a finding**\n\nthe real explanation",
						diff_hunk: "@@ -1 +1 @@\n-old\n+new",
					},
				};
			}
			if (route.includes("/issues/{issue_number}/comments")) {
				posted.push((params as { body: string }).body);
				return { data: { id: 555 } };
			}
			throw new Error(`unexpected route ${route}`);
		},
	);
	return {
		posted,
		request,
		app: {
			getInstallationOctokit: async () => ({ request }),
		},
	};
}

function run(octokit: ReturnType<typeof stubOctokit>) {
	return runPrQc({
		// biome-ignore lint/suspicious/noExplicitAny: minimal octokit stub
		app: octokit.app as any,
		config,
		installationId: 42,
		owner: "o",
		repo: "r",
		pr: 7,
		trigger: "command",
		full: true,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	recordQcRun.mockResolvedValue(1);
	releaseQcRun.mockResolvedValue(undefined);
	finalizeQcRun.mockResolvedValue(undefined);
	reclaimStaleQcRun.mockResolvedValue(false);
	judgeFinding.mockResolvedValue(verdict());
	listFindingsForPr.mockResolvedValue([catalogRow()]);
});

describe("runPrQc dedup claim", () => {
	it("skips without spending budget when this head was already reported", async () => {
		recordQcRun.mockResolvedValue(0);
		const octokit = stubOctokit();

		const result = await run(octokit);

		expect(result).toEqual({
			judged: 0,
			posted: false,
			reason: "already-reported",
		});
		expect(judgeFinding).not.toHaveBeenCalled();
		expect(octokit.posted).toEqual([]);
	});

	// Holding the claim after a failure would lock the head out of QC forever:
	// every later /qc returns "already-reported" and no report is ever posted.
	it("releases the claim when the run fails, so /qc can be retried", async () => {
		judgeFinding.mockRejectedValue(new Error("provider exploded"));

		await expect(run(stubOctokit())).rejects.toThrow("provider exploded");

		expect(releaseQcRun).toHaveBeenCalledWith(db, "qcrun:o/r#7:HEAD1");
	});

	it("releases the claim when posting the report fails", async () => {
		const octokit = stubOctokit();
		octokit.request.mockImplementation(async (route: string) => {
			if (route.includes("/pulls/{pull_number}")) {
				return { data: { head: { sha: "HEAD1" } } };
			}
			if (route.includes("/pulls/comments/")) {
				return { data: { body: "**t**\n\nb", diff_hunk: "h" } };
			}
			throw new Error("comment POST rejected");
		});

		await expect(run(octokit)).rejects.toThrow("comment POST rejected");

		expect(releaseQcRun).toHaveBeenCalledWith(db, "qcrun:o/r#7:HEAD1");
	});

	// The row is claimed with placeholder counts, so without this the table
	// records that a run happened but never what it found.
	it("writes the real counts and the comment id back after reporting", async () => {
		judgeFinding.mockResolvedValue({ ...verdict(), isFalsePositive: true });

		await run(stubOctokit());

		expect(finalizeQcRun).toHaveBeenCalledWith(db, "qcrun:o/r#7:HEAD1", {
			findingsJudged: 1,
			falsePositives: 1,
			prCommentId: 555,
		});
		expect(releaseQcRun).not.toHaveBeenCalled();
	});

	// A hard function timeout kills the instance, so no catch runs and the
	// release path never fires. Reclaiming the abandoned row is what keeps that
	// from being the same permanent lockout by another route.
	it("takes over a claim left behind by a run that died without reporting", async () => {
		recordQcRun.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
		reclaimStaleQcRun.mockResolvedValue(true);

		const result = await run(stubOctokit());

		expect(reclaimStaleQcRun).toHaveBeenCalledWith(
			db,
			"qcrun:o/r#7:HEAD1",
			300,
		);
		expect(result.posted).toBe(true);
	});

	// A run still inside the function's window is genuinely in flight; taking
	// its claim would let two runs judge and post the same head.
	it("does not take over a claim that is still within its window", async () => {
		recordQcRun.mockResolvedValue(0);
		reclaimStaleQcRun.mockResolvedValue(false);

		const result = await run(stubOctokit());

		expect(result.reason).toBe("already-reported");
		expect(recordQcRun).toHaveBeenCalledTimes(1);
		expect(judgeFinding).not.toHaveBeenCalled();
	});
});

describe("runPrQc judge context", () => {
	// The catalog stores the title only. Passing it as the body too would show
	// the judge the same sentence twice and no code at all.
	it("judges against the posted comment body and its diff hunk", async () => {
		await run(stubOctokit());

		const [finding, hunk] = judgeFinding.mock.calls[0];
		expect(finding.body).toBe("the real explanation");
		expect(finding.body).not.toBe(finding.title);
		expect(hunk).toBe("@@ -1 +1 @@\n-old\n+new");
	});

	it("degrades to empty context when the comment is gone, rather than failing the run", async () => {
		const octokit = stubOctokit({
			comment: () => {
				throw Object.assign(new Error("Not Found"), { status: 404 });
			},
		});

		const result = await run(octokit);

		expect(judgeFinding).toHaveBeenCalledWith(
			expect.objectContaining({ body: "" }),
			"",
		);
		expect(result.posted).toBe(true);
	});

	// A rate limit or an expired token is not a deleted comment. Degrading there
	// would judge every finding with no body and no code, and report the result
	// as if it meant something.
	it.each([
		401, 403, 429, 500,
	])("fails the run on a %s rather than judging without context", async (status) => {
		const octokit = stubOctokit({
			comment: () => {
				throw Object.assign(new Error("api error"), { status });
			},
		});

		await expect(run(octokit)).rejects.toThrow("api error");

		expect(judgeFinding).not.toHaveBeenCalled();
		expect(releaseQcRun).toHaveBeenCalledWith(db, "qcrun:o/r#7:HEAD1");
	});

	// The report is out; releasing the claim here would let the next /qc post a
	// second one over the top of it.
	it("keeps the claim when the report posts but the counts fail to record", async () => {
		finalizeQcRun.mockRejectedValue(new Error("db connection dropped"));

		const result = await run(stubOctokit());

		expect(result.posted).toBe(true);
		expect(releaseQcRun).not.toHaveBeenCalled();
	});

	it("skips the comment fetch for a general finding that has none", async () => {
		listFindingsForPr.mockResolvedValue([catalogRow({ commentId: null })]);
		const octokit = stubOctokit();

		await run(octokit);

		expect(
			octokit.request.mock.calls.filter(([route]) =>
				route.includes("/pulls/comments/"),
			),
		).toEqual([]);
		expect(judgeFinding).toHaveBeenCalledWith(
			expect.objectContaining({ body: "" }),
			"",
		);
	});

	// An unparseable comment still carries the reviewer's words; dropping it
	// would leave the judge with less context than it could have had.
	it("falls back to the raw comment body when it does not match the bot's format", async () => {
		const octokit = stubOctokit({
			comment: () => ({ data: { body: "free-form text", diff_hunk: "" } }),
		});

		await run(octokit);

		expect(judgeFinding.mock.calls[0][0].body).toBe("free-form text");
	});
});
