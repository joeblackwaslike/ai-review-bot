import { describe, expect, it } from "vitest";
import { buildAuditUserMessage } from "./prompt.js";

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
