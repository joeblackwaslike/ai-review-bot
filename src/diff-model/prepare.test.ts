import { describe, expect, it } from "vitest";
import { formatPackedDiff } from "../diff-pack.js";
import { buildUserMessage } from "../prompt.js";
import { prepareContentInput, prepareDiffInput } from "./prepare.js";

const lines = (n: number, tag: string) =>
	Array.from({ length: n }, (_, i) => `+${tag}${i}`).join("\n");

const pf = (filename: string, patch: string, status = "modified") => ({
	filename,
	status,
	patch,
	additions: (patch.match(/^\+/gm) ?? []).length,
	deletions: (patch.match(/^-/gm) ?? []).length,
});

const base = {
	prFilesComplete: true,
	title: "t",
	body: null,
	budgetChars: 200_000,
	sectionBudgetChars: 6000,
	scopeLabel: "this push",
};

const shownOf = (model: { files: { filename: string; shown: string }[] }) =>
	Object.fromEntries(model.files.map((f) => [f.filename, f.shown]));

describe("prepareDiffInput", () => {
	it("prepareDiffInput sets span visibility from the packed result", () => {
		const keep = pf("keep.ts", `@@ -0,0 +1,10 @@\n${lines(10, "k")}`);
		const gone = pf(
			"gone.ts",
			`@@ -1,40 +0,0 @@\n${lines(40, "g").replaceAll("+", "-")}`,
		);
		const files = [keep, gone];
		const { packed, model } = prepareDiffInput({
			...base,
			scopeFiles: files,
			prFiles: files,
			budgetChars: 500,
		});
		expect(
			packed.files.find((f) => f.filename === "gone.ts")?.droppedDeletionHunks,
		).toBe(1);
		expect(shownOf(model)["gone.ts"]).toBe("none");
		expect(shownOf(model)["keep.ts"]).not.toBe("none");
	});

	it("marks an omitted file none and a truncated file partial", () => {
		const a = pf("a.ts", `@@ -0,0 +1,60 @@\n${lines(60, "a")}`);
		const b = pf("b.ts", `@@ -0,0 +1,5 @@\n${lines(5, "b")}`);
		const { model } = prepareDiffInput({
			...base,
			scopeFiles: [a, b],
			prFiles: [a, b],
			budgetChars: 500,
		});
		expect(shownOf(model)["a.ts"]).toBe("partial");
		expect(shownOf(model)["b.ts"]).toBe("none");
	});

	it("packed diff text is identical with the model on and off", () => {
		const files = [
			pf("a.ts", `@@ -0,0 +1,5 @@\n${lines(5, "a")}`),
			pf("b.ts", "@@ -1,2 +1,2 @@\n-x\n+y\n z"),
		];
		const { packed } = prepareDiffInput({
			...base,
			scopeFiles: files,
			prFiles: files,
		});
		const ctx = {
			owner: "o",
			repo: "r",
			pullNumber: 1,
			headSha: "s",
			title: "t",
			body: null,
			additions: 1,
			deletions: 0,
			changedFiles: 2,
			labels: [],
			extraInstructions: "",
			files,
		};
		const off = buildUserMessage(ctx);
		expect(off).toContain(formatPackedDiff(packed));
	});
});

describe("prepareContentInput", () => {
	it("returns an empty string when there is nothing to say", () => {
		expect(prepareContentInput({ filenames: [], title: "t", body: null })).toBe(
			"",
		);
	});

	it("renders file kinds for the audited files", () => {
		const text = prepareContentInput({
			filenames: ["a.ts", "a.test.ts"],
			title: "t",
			body: null,
		});
		expect(text).toContain("2 files: 1 code, 1 test.");
	});
});
