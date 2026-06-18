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
