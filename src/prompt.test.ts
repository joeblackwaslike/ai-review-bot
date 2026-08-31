import { describe, expect, it } from "vitest";
import {
	buildAgentSystemPrompt,
	buildAuditUserMessage,
	buildUserMessage,
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
