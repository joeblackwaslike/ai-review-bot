import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";

function file(filename: string, patch: string): PushFile {
	return { filename, status: "modified", patch, additions: 0, deletions: 0 };
}

describe("buildDiffModel at scale", () => {
	it("verifies thousands of one-line declaration moves in linear time", () => {
		const count = 8000;
		const names = Array.from({ length: count }, (_, i) => `NAME_${i}`);
		const files = [
			file(
				"src/a.ts",
				[
					`@@ -1,${count} +0,0 @@`,
					...names.map(
						(n, i) => `-export const ${n} = { id: ${i}, tag: "a" };`,
					),
				].join("\n"),
			),
			file(
				"src/b.ts",
				[
					`@@ -0,0 +1,${count} @@`,
					...names.map(
						(n, i) => `+export const ${n} = { id: ${i}, tag: "b" };`,
					),
				].join("\n"),
			),
		];
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
