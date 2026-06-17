import { describe, expect, it } from "vitest";
import { buildAuditUserMessage, buildUserMessage } from "./prompt.js";

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
