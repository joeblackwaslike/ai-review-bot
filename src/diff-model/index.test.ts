import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";
import { verifyRelocation } from "./relocation-check.js";

vi.mock("./relocation-check.js", () => ({ verifyRelocation: vi.fn() }));

const block = Array.from(
	{ length: 12 },
	(_, i) => `  const v${i} = compute(${i}) + offset;`,
);

function moveFiles(): PushFile[] {
	return [
		{
			filename: "src/a.ts",
			status: "modified",
			patch: ["@@ -10,12 +9,0 @@", ...block.map((l) => `-${l}`)].join("\n"),
			additions: 0,
			deletions: 12,
		},
		{
			filename: "src/b.ts",
			status: "modified",
			patch: ["@@ -0,0 +3,12 @@", ...block.map((l) => `+${l}`)].join("\n"),
			additions: 12,
			deletions: 0,
		},
	];
}

const meta = { prFilesComplete: true, title: "t", body: null };

describe("buildDiffModel", () => {
	beforeEach(() => vi.mocked(verifyRelocation).mockReset());

	it("keeps a relocation the checker accepts", () => {
		vi.mocked(verifyRelocation).mockReturnValue(true);
		const files = moveFiles();
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			...meta,
		});
		expect(
			model.operations.filter((o) => o.type === "relocation"),
		).toHaveLength(1);
		expect(model.droppedClaims).toBe(0);
	});

	it("drops a relocation the checker rejects and counts it", () => {
		vi.mocked(verifyRelocation).mockReturnValue(false);
		const files = moveFiles();
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			...meta,
		});
		expect(model.operations).toEqual([]);
		expect(model.droppedClaims).toBe(1);
	});

	it("never throws on a file with no patch", () => {
		const files: PushFile[] = [
			{ filename: "img.png", status: "added", additions: 0, deletions: 0 },
		];
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			...meta,
		});
		expect(model.files).toHaveLength(1);
		expect(model.operations).toEqual([]);
	});

	it("tokenizes an adversarial escaped-quote line in linear time", () => {
		const hostile = `  const x = "${'\\"'.repeat(40_000)}`;
		const base = block.map((l, i) => (i === 5 ? hostile : l));
		const head = block.map((l, i) => (i === 5 ? `${hostile}y` : l));
		const files = moveFiles();
		files[0] = {
			...(files[0] as PushFile),
			patch: ["@@ -10,12 +9,0 @@", ...base.map((l) => `-${l}`)].join("\n"),
		};
		files[1] = {
			...(files[1] as PushFile),
			patch: ["@@ -0,0 +3,12 @@", ...head.map((l) => `+${l}`)].join("\n"),
		};
		const start = performance.now();
		buildDiffModel({ scopeFiles: files, prFiles: files, ...meta });
		expect(performance.now() - start).toBeLessThan(1000);
	});
});
