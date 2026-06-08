import { describe, expect, it } from "vitest";
import {
	collectFilesFromLocal,
	type GitRunner,
	hasCodeExtension,
} from "./sources.js";

describe("hasCodeExtension", () => {
	it("accepts code files and rejects others", () => {
		expect(hasCodeExtension("src/a.ts")).toBe(true);
		expect(hasCodeExtension("README.md")).toBe(false);
		expect(hasCodeExtension("Makefile")).toBe(false);
	});
});

describe("collectFilesFromLocal", () => {
	const readFile = async (p: string) => `// content of ${p}`;

	it("changed mode = diff names ∪ porcelain, code-filtered, deduped", async () => {
		const runGit: GitRunner = (args) => {
			const key = args.join(" ");
			if (key.startsWith("merge-base")) return "BASE_SHA";
			if (key.startsWith("diff --name-only"))
				return "src/a.ts\nsrc/b.ts\ndocs/x.md";
			if (key.startsWith("status --porcelain"))
				return " M src/b.ts\n?? src/c.ts\n?? notes.txt";
			return "";
		};
		const files = await collectFilesFromLocal({
			cwd: "/repo",
			mode: "changed",
			runGit,
			readFile,
		});
		expect(files.map((f) => f.path).sort()).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
		expect(files[0].content).toContain("content of");
	});

	it("full mode = git ls-files, code-filtered", async () => {
		const runGit: GitRunner = (args) =>
			args[0] === "ls-files" ? "src/a.ts\nREADME.md\nsrc/d.tsx" : "";
		const files = await collectFilesFromLocal({
			cwd: "/repo",
			mode: "full",
			runGit,
			readFile,
		});
		expect(files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/d.tsx"]);
	});

	it("skips files that fail to read (deleted/binary)", async () => {
		const runGit: GitRunner = (args) =>
			args[0] === "ls-files" ? "src/a.ts\nsrc/gone.ts" : "";
		const failingRead = async (p: string) => {
			if (p.endsWith("gone.ts")) throw new Error("ENOENT");
			return "ok";
		};
		const files = await collectFilesFromLocal({
			cwd: "/repo",
			mode: "full",
			runGit,
			readFile: failingRead,
		});
		expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
	});
});
