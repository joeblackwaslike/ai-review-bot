import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";

const count = 8000;

function side(filename: string, sign: "-" | "+", tag: string): PushFile {
	const rows = Array.from(
		{ length: count },
		(_, i) => `${sign}export const NAME_${i} = { id: ${i}, tag: "${tag}" };`,
	);
	const header =
		sign === "-" ? `@@ -1,${count} +0,0 @@` : `@@ -0,0 +1,${count} @@`;
	const patch = [header, ...rows].join("\n");
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

describe("buildDiffModel at scale", () => {
	it("verifies thousands of one-line declaration moves in linear time", () => {
		const files = [side("src/a.ts", "-", "a"), side("src/b.ts", "+", "b")];
		const started = performance.now();
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			prFilesComplete: true,
			title: "t",
			body: null,
		});
		const elapsed = performance.now() - started;
		const relocations = model.operations.filter((o) => o.type === "relocation");
		expect(relocations.length).toBeGreaterThan(0);
		expect(relocations.length).toBeLessThanOrEqual(5000);
		expect(model.droppedClaims).toBe(0);
		expect(elapsed).toBeLessThan(3000);
	}, 5000);
});
