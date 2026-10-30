import { describe, expect, it } from "vitest";
import {
	buildAgentSystemPrompt,
	buildAuditUserMessage,
	buildUserMessage,
	isGeneratedFile,
	MAX_REASON_CHARS,
	wholePrInputComplete,
} from "./prompt.js";

describe("buildAgentSystemPrompt epistemic guardrails", () => {
	const prompt = buildAgentSystemPrompt("code-reviewer.md", "");

	it("tells agents they cannot see deps/node_modules", () => {
		expect(prompt).toContain("Epistemic Guardrails");
		expect(prompt).toContain("node_modules");
	});

	it("forbids asserting a library API does not exist from training knowledge", () => {
		expect(prompt).toContain("does not exist");
		expect(prompt).toContain("low-severity question");
	});

	it("flags that type-only imports have no runtime effect", () => {
		expect(prompt).toContain("import type");
		expect(prompt).toContain("erased at compile time");
	});
});

describe("buildUserMessage prior own review", () => {
	const base = {
		owner: "o",
		repo: "r",
		pullNumber: 1,
		headSha: "abc",
		title: "t",
		body: null,
		additions: 1,
		deletions: 0,
		changedFiles: 1,
		labels: [],
		extraInstructions: "",
		files: [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n+x" }],
	};

	it("injects the bot's own prior findings with do-not-re-report guidance", () => {
		const msg = buildUserMessage({
			...base,
			priorOwnReview: "### ai-review\nPrior finding: Unvalidated input",
		});
		expect(msg).toContain("previously raised");
		expect(msg).toContain("Unvalidated input");
	});

	it("omits the prior-review section when none is provided", () => {
		const msg = buildUserMessage(base);
		expect(msg).not.toContain("previously raised");
	});
});

describe("buildAuditUserMessage", () => {
	it("keeps full file content intact for files over 8000 chars", () => {
		const big = "// line\n".repeat(2000); // >8000 chars
		const msg = buildAuditUserMessage({
			owner: "o",
			repo: "r",
			ref: "working-tree",
			extraInstructions: "",
			files: [{ path: "big.ts", content: big }],
		});
		expect(msg).toContain(big);
		expect(msg).not.toContain("[patch truncated]");
	});
});

const promptBase = {
	owner: "o",
	repo: "r",
	pullNumber: 1,
	headSha: "abc",
	title: "t",
	body: null,
	additions: 1,
	deletions: 0,
	changedFiles: 1,
	labels: [],
	extraInstructions: "",
	files: [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n+x" }],
};

describe("prior own findings", () => {
	const findings = [
		{
			path: "src/qc-app.ts",
			line: 123,
			title: "body is set to f.title",
			severity: "P1",
			status: "open",
		},
		{
			path: null,
			line: null,
			title: "no tests for the handler",
			severity: "P3",
			status: "resolved",
		},
	];

	// The prior review *body* is a synthesised summary that never lists the
	// inline comments, so agents could not see what they had already filed and
	// refiled it round after round.
	it("lists every prior finding with its status and anchor", () => {
		const message = buildUserMessage({
			...promptBase,
			priorOwnFindings: findings,
		});
		expect(message).toContain(
			"[open] P1 — src/qc-app.ts:123 — body is set to f.title",
		);
		expect(message).toContain(
			"[resolved] P3 — general — no tests for the handler",
		);
		expect(message).toContain("Do not file any of these again");
	});

	it("shows the author's reason on a settled finding", () => {
		const message = buildUserMessage({
			...promptBase,
			priorOwnFindings: [
				{
					path: "src/a.ts",
					line: 7,
					title: "retry has no backoff",
					severity: "P2",
					status: "rejected",
					decidedBy: "author",
					reason: "by design,\nthe caller backs off",
				},
			],
		});
		expect(message).toContain(
			"[rejected] [declined by author: by design, the caller backs off] P2 — src/a.ts:7 — retry has no backoff",
		);
	});

	it("labels each settled status by what happened", () => {
		const item = (status: string, reason: string | null) => ({
			path: null,
			line: null,
			title: `t-${status}`,
			severity: "P3",
			status,
			decidedBy: "author",
			reason,
		});
		const message = buildUserMessage({
			...promptBase,
			priorOwnFindings: [
				item("fixed", "fixed in abc1234"),
				item("deferred", "follow-up PR"),
				item("resolved", null),
			],
		});
		expect(message).toContain("[fixed] [fixed by author: fixed in abc1234]");
		expect(message).toContain("[deferred] [deferred by author: follow-up PR]");
		expect(message).toContain("[resolved] [resolved by author] P3");
		expect(message).not.toContain("[declined");
	});

	describe("a decider's reason", () => {
		const render = (reason: string) =>
			buildUserMessage({
				...promptBase,
				priorOwnFindings: [
					{
						path: null,
						line: null,
						title: "t",
						severity: "P3",
						status: "rejected",
						decidedBy: "author",
						reason,
					},
				],
			});
		const reasonOf = (message: string) =>
			message.match(/\[declined by author: (.*)\] P3/)?.[1];

		it("is collapsed to one line and capped at MAX_REASON_CHARS", () => {
			const long = Array.from({ length: 100 }, () => "x".repeat(49)).join("\n");
			expect(long.length).toBeGreaterThan(4900);

			const reason = reasonOf(render(long));

			expect(MAX_REASON_CHARS).toBe(300);
			expect(reason).not.toContain("\n");
			expect(reason?.endsWith("…")).toBe(true);
			expect(reason?.length).toBe(MAX_REASON_CHARS + 1);
		});

		it("is unchanged when short", () => {
			expect(reasonOf(render("won't fix, by design"))).toBe(
				"won't fix, by design",
			);
		});
	});

	it("names no decider when none is recorded", () => {
		const message = buildUserMessage({
			...promptBase,
			priorOwnFindings: [
				{
					path: null,
					line: null,
					title: "t",
					severity: "P3",
					status: "rejected",
					decidedBy: null,
					reason: "won't fix",
				},
			],
		});
		expect(message).toContain("[rejected] [declined: won't fix] P3");
	});

	it("explains every status in the closing guidance", () => {
		const message = buildUserMessage({
			...promptBase,
			priorOwnFindings: findings,
		});
		for (const status of ["open", "fixed", "resolved", "rejected", "deferred"])
			expect(message).toMatch(new RegExp(`^- ${status}: `, "m"));
	});

	it("says nothing about prior findings when there are none", () => {
		const message = buildUserMessage({ ...promptBase, priorOwnFindings: [] });
		expect(message).not.toContain("Do not file any of these again");
	});
});

describe("strict evidence rules", () => {
	it("are absent unless asked for, so an untuned reviewer is unchanged", () => {
		const prompt = buildAgentSystemPrompt("code-reviewer.md", "");
		expect(prompt).not.toContain("What Counts As A Finding");
	});

	// One rule per measured failure category from #43 and #45.
	it.each([
		["no-defect findings", "must name a defect"],
		["verify-this findings", "asks the reader to verify"],
		[
			"speculation about unseen code",
			"Do not speculate about code you cannot see",
		],
		[
			"deletion read without the addition",
			"not a removal until you have checked the additions",
		],
		[
			"restating one claim many times",
			"Report each distinct claim exactly once",
		],
		["severity inflation", "demonstrated data loss"],
	])("ban %s", (_label, rule) => {
		const prompt = buildAgentSystemPrompt("code-reviewer.md", "", {
			strictEvidenceRules: true,
		});
		expect(prompt).toContain(rule);
	});
});

describe("isGeneratedFile", () => {
	it.each([
		"package-lock.json",
		"pnpm-lock.yaml",
		"yarn.lock",
		"bun.lock",
		"Cargo.lock",
		"poetry.lock",
		"go.sum",
		"web/vendor/jquery.min.js",
		"src/__snapshots__/review.test.ts.snap",
		"apps/web/pnpm-lock.yaml",
	])("%s is generated", (path) => {
		expect(isGeneratedFile(path)).toBe(true);
	});

	it.each([
		"src/review.ts",
		"lock.yaml",
		"package.json",
		"docs/yarn.lock.md",
		"src/min.js",
		"go.sum.bak",
	])("%s is not", (path) => {
		expect(isGeneratedFile(path)).toBe(false);
	});
});

describe("wholePrInputComplete", () => {
	const file = (
		filename: string,
		o: { patch?: string; additions?: number; deletions?: number } = {
			patch: "@@ -1 +1 @@\n+x",
			additions: 1,
			deletions: 0,
		},
	) => ({ filename, ...o });
	const big = "x".repeat(24_001);

	it("is complete when every file has an untrimmed patch", () => {
		expect(wholePrInputComplete([file("a.ts"), file("b.ts")], 2)).toBe(true);
	});

	it("a trimmed patch is incomplete", () => {
		expect(
			wholePrInputComplete([file("a.ts", { patch: big, additions: 1 })], 1),
		).toBe(false);
	});

	it("a file with no patch and no changes (binary, pure rename) is complete", () => {
		expect(
			wholePrInputComplete(
				[
					file("a.ts"),
					file("logo.png", { additions: 0, deletions: 0 }),
					file("moved.ts", { additions: 0, deletions: 0 }),
				],
				3,
			),
		).toBe(true);
	});

	it("a file with changes but no patch is incomplete", () => {
		expect(
			wholePrInputComplete([file("huge.ts", { additions: 5000 })], 1),
		).toBe(false);
	});

	it("a file with no patch and unknown change counts is incomplete", () => {
		expect(wholePrInputComplete([file("x.ts", {})], 1)).toBe(false);
	});

	it("a generated file does not block, even trimmed or without a patch", () => {
		expect(
			wholePrInputComplete(
				[
					file("a.ts"),
					file("pnpm-lock.yaml", { patch: big, additions: 900 }),
					file("dist/app.min.js", { additions: 40 }),
				],
				3,
			),
		).toBe(true);
	});

	it("a file list shorter than the PR's changed files is incomplete", () => {
		expect(wholePrInputComplete([file("a.ts")], 2)).toBe(false);
	});

	it("a file list at GitHub's 3000-file cap is incomplete", () => {
		const files = Array.from({ length: 3000 }, (_, i) => file(`f${i}.ts`));
		expect(wholePrInputComplete(files, 3000)).toBe(false);
		expect(wholePrInputComplete(files.slice(1), 2999)).toBe(true);
	});
});
