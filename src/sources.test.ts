import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectFilesFromCommit,
	collectFilesFromLocal,
	collectFilesFromRange,
	defaultGitRunner,
	diffHash,
	type GitRunner,
	hasCodeExtension,
	listRangeChanges,
	resolveBase,
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

describe("range scope", () => {
	it("resolveBase prefers an explicit ref", () => {
		const runGit: GitRunner = () => {
			throw new Error("should not be called");
		};
		expect(resolveBase(runGit, "origin/dev")).toBe("origin/dev");
	});

	it("resolveBase falls back to origin/main then origin/master", () => {
		const only =
			(ok: string): GitRunner =>
			(args) => {
				if (args[0] === "symbolic-ref") throw new Error("no origin/HEAD");
				if (args[0] === "rev-parse" && args.at(-1) === ok) return "sha";
				throw new Error("bad ref");
			};
		expect(resolveBase(only("origin/main"))).toBe("origin/main");
		expect(resolveBase(only("origin/master"))).toBe("origin/master");
		expect(() => resolveBase(only("none"))).toThrow("No base branch found");
	});

	it("resolveBase uses the origin/HEAD target when present", () => {
		const runGit: GitRunner = (args) => {
			if (args[0] === "symbolic-ref") return "refs/remotes/origin/trunk\n";
			return "sha";
		};
		expect(resolveBase(runGit)).toBe("origin/trunk");
	});

	it("resolveBase asks symbolic-ref to stay quiet when origin/HEAD is unset", () => {
		const calls: string[][] = [];
		const runGit: GitRunner = (args) => {
			calls.push([...args]);
			if (args[0] === "symbolic-ref") throw new Error("no origin/HEAD");
			if (args.at(-1) === "origin/main") return "sha";
			throw new Error("bad ref");
		};
		expect(resolveBase(runGit)).toBe("origin/main");
		expect(calls[0]).toEqual([
			"symbolic-ref",
			"--quiet",
			"refs/remotes/origin/HEAD",
		]);
	});

	it("listRangeChanges reports renames with the old path", () => {
		const runGit: GitRunner = (args) => {
			if (args[0] === "merge-base") return "mb1\n";
			return "A\0src/a.ts\0M\0src/b.ts\0D\0src/c.ts\0R100\0src/old.ts\0src/new.ts\0";
		};
		expect(listRangeChanges(runGit, "origin/main")).toEqual({
			mergeBase: "mb1",
			changes: [
				{ path: "src/a.ts", oldPath: null, status: "A" },
				{ path: "src/b.ts", oldPath: null, status: "M" },
				{ path: "src/c.ts", oldPath: null, status: "D" },
				{ path: "src/new.ts", oldPath: "src/old.ts", status: "R" },
			],
		});
	});

	it("listRangeChanges asks for NUL-separated output and keeps non-ASCII and spaced paths", () => {
		const diffArgs: string[][] = [];
		const runGit: GitRunner = (args) => {
			if (args.includes("merge-base")) return "mb1";
			diffArgs.push([...args]);
			return "M\0src/caf\u00e9.ts\0R90\0src/my old.ts\0src/my new.ts\0";
		};
		const { changes } = listRangeChanges(runGit, "origin/main");
		expect(diffArgs[0]).toEqual([
			"diff",
			"-M",
			"--name-status",
			"-z",
			"mb1",
			"HEAD",
		]);
		expect(changes).toEqual([
			{ path: "src/caf\u00e9.ts", oldPath: null, status: "M" },
			{ path: "src/my new.ts", oldPath: "src/my old.ts", status: "R" },
		]);
	});

	it("listRangeChanges drops non-code files", () => {
		const runGit: GitRunner = (args) =>
			args[0] === "merge-base" ? "mb1" : "M\0README.md\0M\0src/a.ts\0";
		expect(
			listRangeChanges(runGit, "origin/main").changes.map((c) => c.path),
		).toEqual(["src/a.ts"]);
	});

	it("diffHash is stable for equal diffs and differs when the diff changes", () => {
		const mk =
			(out: string): GitRunner =>
			() =>
				out;
		const seen: string[][] = [];
		const spy: GitRunner = (args) => {
			seen.push([...args]);
			return "x";
		};
		diffHash(spy, "mb", "a.ts");
		expect(seen).toEqual([["diff", "mb", "HEAD", "--", "a.ts"]]);
		expect(diffHash(mk("x"), "mb", "a.ts")).toBe(
			diffHash(mk("x"), "mb", "a.ts"),
		);
		expect(diffHash(mk("x"), "mb", "a.ts")).not.toBe(
			diffHash(mk("y"), "mb", "a.ts"),
		);
	});

	it("collectFilesFromRange rethrows a read failure for a path that exists at HEAD", async () => {
		const runGit: GitRunner = (args) => {
			if (args[0] === "show") throw new Error("fatal: unable to read blob");
			if (args[0] === "ls-tree") return "100644 blob abc\ta.ts\n";
			throw new Error(`unexpected ${args.join(" ")}`);
		};
		await expect(
			collectFilesFromRange({
				cwd: ".",
				changes: [{ path: "a.ts", oldPath: null, status: "M" }],
				runGit,
			}),
		).rejects.toThrow("unable to read blob");
	});

	it("collectFilesFromRange skips a path that is absent at HEAD", async () => {
		const runGit: GitRunner = (args) => {
			if (args[0] === "show") throw new Error("fatal: path does not exist");
			if (args[0] === "ls-tree") return "";
			throw new Error(`unexpected ${args.join(" ")}`);
		};
		expect(
			await collectFilesFromRange({
				cwd: ".",
				changes: [{ path: "a.ts", oldPath: null, status: "M" }],
				runGit,
			}),
		).toEqual([]);
	});

	it("collectFilesFromRange skips deleted files and honors only", async () => {
		const runGit: GitRunner = (args) => `// ${args[1]}`;
		const changes = [
			{ path: "src/a.ts", oldPath: null, status: "A" as const },
			{ path: "src/b.ts", oldPath: null, status: "M" as const },
			{ path: "src/c.ts", oldPath: null, status: "D" as const },
		];
		const all = await collectFilesFromRange({ cwd: "/r", changes, runGit });
		expect(all.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(all[0].content).toBe("// HEAD:src/a.ts");
		const some = await collectFilesFromRange({
			cwd: "/r",
			changes,
			only: new Set(["src/b.ts"]),
			runGit,
		});
		expect(some.map((f) => f.path)).toEqual(["src/b.ts"]);
	});
});

describe("range helpers against a real git repo", () => {
	function makeRepo() {
		const dir = mkdtempSync(join(tmpdir(), "sources-git-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		writeFileSync(
			join(dir, "a.ts"),
			"export const a = 1;\nexport const keep = 0;\n",
		);
		git("add", ".");
		git("commit", "-q", "-m", "base");
		const mb = git("rev-parse", "HEAD").trim();
		git("checkout", "-q", "-b", "feat");
		return { dir, git, mb, runGit: defaultGitRunner(dir) };
	}

	it("diffHash is equal across a pure git mv and changes after an edit", () => {
		const { dir, git, mb, runGit } = makeRepo();
		writeFileSync(
			join(dir, "a.ts"),
			"export const a = 2;\nexport const keep = 0;\n",
		);
		git("commit", "-qam", "edit");
		const before = diffHash(runGit, mb, "a.ts");

		git("mv", "a.ts", "b.ts");
		git("commit", "-qm", "move");
		const moved = diffHash(runGit, mb, "b.ts", "a.ts");

		writeFileSync(
			join(dir, "b.ts"),
			"export const a = 3;\nexport const keep = 0;\n",
		);
		git("commit", "-qam", "edit again");
		const edited = diffHash(runGit, mb, "b.ts", "a.ts");

		expect(moved).toBe(before);
		expect(edited).not.toBe(before);
	});

	it("diffHash is equal across a git mv of a file the branch added", () => {
		const { dir, git, mb, runGit } = makeRepo();
		writeFileSync(join(dir, "n.ts"), "export const n = 1;\n");
		git("add", ".");
		git("commit", "-qm", "add");
		const before = diffHash(runGit, mb, "n.ts");

		git("mv", "n.ts", "m.ts");
		git("commit", "-qm", "move");

		expect(diffHash(runGit, mb, "m.ts")).toBe(before);
	});

	it("listRangeChanges keeps code files whose names hold a tab or a double quote", () => {
		const { dir, git, runGit } = makeRepo();
		writeFileSync(join(dir, "ta\tb.ts"), "export const t = 1;\n");
		writeFileSync(join(dir, 'q"uote.ts'), "export const q = 1;\n");
		git("add", ".");
		git("commit", "-qm", "odd names");

		const { changes } = listRangeChanges(runGit, "main");

		expect(changes.map((c) => c.path).sort()).toEqual([
			'q"uote.ts',
			"ta\tb.ts",
		]);
	});
});
