import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { classifyFile } from "../push-shape.js";
import { buildFileNodes } from "./files.js";

const file = (over: Partial<PushFile>): PushFile => ({
	filename: "src/a.ts",
	status: "modified",
	additions: 0,
	deletions: 0,
	...over,
});

describe("buildFileNodes", () => {
	it("classifies kind by path through classifyFile", () => {
		const names = ["src/a.ts", "src/a.test.ts", "README.md", "pnpm-lock.yaml"];
		const nodes = buildFileNodes(names.map((filename) => file({ filename })));
		expect(nodes.map((n) => n.kind)).toEqual(names.map(classifyFile));
	});

	it("parses hunk headers into old and new ranges", () => {
		const patch = "@@ -10,42 +10,2 @@ fn\n-a\n+b\n@@ -60 +30,3 @@\n x";
		const [node] = buildFileNodes([file({ patch })]);
		expect(node?.hunks).toEqual([
			{ oldStart: 10, oldLines: 42, newStart: 10, newLines: 2 },
			{ oldStart: 60, oldLines: 1, newStart: 30, newLines: 3 },
		]);
	});

	it("keeps a file with no patch as a node with no hunks", () => {
		const [node] = buildFileNodes([
			file({ filename: "logo.png", status: "added" }),
		]);
		expect(node).toMatchObject({
			filename: "logo.png",
			hunks: [],
			shown: "full",
		});
	});

	it("carries previous_filename for a rename", () => {
		const [node] = buildFileNodes([
			file({ filename: "b.ts", status: "renamed", previous_filename: "a.ts" }),
		]);
		expect(node?.previousFilename).toBe("a.ts");
		expect(buildFileNodes([file({})])[0]).not.toHaveProperty(
			"previousFilename",
		);
	});
});
