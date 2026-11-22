import { describe, expect, it, vi } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";

vi.mock("./relocation.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./relocation.js")>();
	return {
		...actual,
		findRelocations: (files: PushFile[]) =>
			actual
				.findRelocations(files)
				.map((op) => ({ ...op, exact: true, divergences: [] })),
	};
});

const base = Array.from(
	{ length: 12 },
	(_, i) => `  const v${i} = compute(${i}) + offset;`,
);
const head = base.map((l, i) => (i === 5 ? "  const v5 = tampered();" : l));

describe("buildDiffModel with the real checker", () => {
	it("drops a forged clean relocation over a changed line and counts it", () => {
		const files: PushFile[] = [
			{
				filename: "src/a.ts",
				status: "modified",
				patch: ["@@ -10,12 +9,0 @@", ...base.map((l) => `-${l}`)].join("\n"),
				additions: 0,
				deletions: 12,
			},
			{
				filename: "src/b.ts",
				status: "modified",
				patch: ["@@ -0,0 +3,12 @@", ...head.map((l) => `+${l}`)].join("\n"),
				additions: 12,
				deletions: 0,
			},
		];
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
		expect(model.operations.filter((o) => o.type === "relocation")).toEqual([]);
		expect(model.droppedClaims).toBe(1);
	});
});
