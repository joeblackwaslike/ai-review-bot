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

	it("takes operations from scopeFiles and facts from prFiles", () => {
		vi.mocked(verifyRelocation).mockReturnValue(true);
		const scopeFiles: PushFile[] = [
			{ filename: "src/c.ts", status: "modified", additions: 1, deletions: 0 },
		];
		const prFiles = [
			...moveFiles(),
			{
				filename: "src/c.test.ts",
				status: "added",
				additions: 1,
				deletions: 0,
			},
		];
		const model = buildDiffModel({ scopeFiles, prFiles, ...meta });
		expect(model.facts.testsChanged).toBe(true);
		expect(model.operations).toEqual([]);
		expect(model.files.map((f) => f.filename)).toEqual(["src/c.ts"]);
	});

	it("reports both a rename and a whitespace hunk", () => {
		const lines = [
			"const alpha = 1;",
			"const bravo = 2;",
			"const charlie = 3;",
		];
		const files: PushFile[] = [
			{
				filename: "src/old.ts",
				status: "removed",
				patch: ["@@ -1,3 +0,0 @@", ...lines.map((l) => `-${l}`)].join("\n"),
				additions: 0,
				deletions: 3,
			},
			{
				filename: "src/new.ts",
				status: "added",
				patch: ["@@ -0,0 +1,3 @@", ...lines.map((l) => `+${l}`)].join("\n"),
				additions: 3,
				deletions: 0,
			},
			{
				filename: "src/fmt.ts",
				status: "modified",
				patch: "@@ -1,1 +1,1 @@\n-    run();\n+run();",
				additions: 1,
				deletions: 1,
			},
		];
		const model = buildDiffModel({
			scopeFiles: files,
			prFiles: files,
			...meta,
		});
		expect(model.operations.map((o) => o.type).sort()).toEqual([
			"mechanical",
			"rename",
		]);
	});
});
