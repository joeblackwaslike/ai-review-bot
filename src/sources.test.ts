import { describe, expect, it } from "vitest";
import {
	collectFilesFromCommit,
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
		const mergeBaseArgs: string[][] = [];
		const runGit: GitRunner = (args) => {
			const key = args.join(" ");
			if (key.startsWith("symbolic-ref")) return "refs/remotes/origin/main";
			if (key.startsWith("merge-base")) {
				mergeBaseArgs.push([...args]);
				return "BASE_SHA";
			}
			if (key.startsWith("diff --name-only"))
				return "src/a.ts\nsrc/b.ts\ndocs/x.md";
			if (key.startsWith("status --porcelain"))
				return " M src/b.ts\n?? src/c.ts\n?? notes.txt\nR  src/old.ts -> src/new.ts";
			return "";
		};
		const files = await collectFilesFromLocal({
			cwd: "/repo",
			mode: "changed",
			runGit,
			readFile,
		});
		// merge-base is computed against the remote-tracking ref origin/main
		expect(mergeBaseArgs).toEqual([["merge-base", "HEAD", "origin/main"]]);
		expect(files.map((f) => f.path).sort()).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/new.ts",
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

	it("skips paths that resolve outside cwd (traversal guard)", async () => {
		const runGit: GitRunner = (args) =>
			args[0] === "ls-files" ? "src/a.ts\n../outside.ts" : "";
		const files = await collectFilesFromLocal({
			cwd: "/repo",
			mode: "full",
			runGit,
			readFile,
		});
		expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
	});
});

describe("collectFilesFromCommit", () => {
	it("lists code files in the commit and reads commit-pinned content", async () => {
		const showArgs: string[][] = [];
		const runGit: GitRunner = (args) => {
			const key = args.join(" ");
			if (key.startsWith("diff-tree")) return "src/a.ts\nsrc/b.ts\ndocs/x.md\n";
			if (args[0] === "show") {
				showArgs.push([...args]);
				return `// ${args[1]}`;
			}
			return "";
		};
		const files = await collectFilesFromCommit({
			cwd: "/repo",
			sha: "abc123",
			runGit,
		});
		expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
		// content comes from `git show <sha>:<path>`, not the working tree
		expect(showArgs).toEqual([
			["show", "abc123:src/a.ts"],
			["show", "abc123:src/b.ts"],
		]);
		expect(files[0].content).toBe("// abc123:src/a.ts");
	});

	it("skips paths absent at the commit (deleted / old side of rename)", async () => {
		const runGit: GitRunner = (args) => {
			const key = args.join(" ");
			if (key.startsWith("diff-tree")) return "src/old.ts\nsrc/new.ts";
			if (args[0] === "show") {
				if (args[1] === "abc123:src/old.ts")
					throw new Error("fatal: path 'src/old.ts' does not exist");
				return "ok";
			}
			return "";
		};
		const files = await collectFilesFromCommit({
			cwd: "/repo",
			sha: "abc123",
			runGit,
		});
		expect(files.map((f) => f.path)).toEqual(["src/new.ts"]);
	});
});
