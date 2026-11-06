import { execFile } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedReviewInput } from "./input.js";
import { materializeSeed } from "./materialize.js";
import { listSeeds, loadSeed } from "./schema.js";

const run = promisify(execFile);
let root: string;

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

async function inlineSeed(
	opId: string,
	variant: string,
	truth: unknown,
): Promise<string> {
	const dir = join(root, opId, variant);
	await write(join(dir, "base", "src", "a.ts"), "export const a = 1;\n");
	await write(join(dir, "head", "src", "a.ts"), "export const a = 2;\n");
	await write(join(dir, "head", "src", "b.ts"), "export const b = 1;\n");
	await write(join(dir, "truth.json"), JSON.stringify(truth));
	return dir;
}

const defect = (startLine = 1, endLine = 1) => ({
	clean: false,
	defects: [{ path: "src/a.ts", startLine, endLine, description: "bad" }],
});

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "seed-test-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("loadSeed", () => {
	it("loads id, opId, variant and truth", async () => {
		const dir = await inlineSeed("REL-01", "original", defect());
		const seed = await loadSeed(dir);
		expect(seed).toMatchObject({
			id: "REL-01/original",
			opId: "REL-01",
			variant: "original",
			dir,
		});
		expect(seed.truth).toEqual(defect());
	});

	it("accepts a clean truth", async () => {
		const dir = await inlineSeed("REL-01", "clean", { clean: true });
		expect((await loadSeed(dir)).truth).toEqual({ clean: true });
	});

	it("rejects two defects", async () => {
		const d = defect().defects[0];
		const dir = await inlineSeed("REL-01", "v1", {
			clean: false,
			defects: [d, d],
		});
		await expect(loadSeed(dir)).rejects.toThrow();
	});

	it("rejects an inverted range", async () => {
		const dir = await inlineSeed("REL-01", "v2", defect(5, 2));
		await expect(loadSeed(dir)).rejects.toThrow();
	});
});

describe("materializeSeed", () => {
	it("builds two commits whose head tree matches head/", async () => {
		const seed = await loadSeed(
			await inlineSeed("REL-01", "original", defect()),
		);
		const m = await materializeSeed(seed);
		try {
			expect(m.baseSha).not.toBe(m.headSha);
			const { stdout } = await run("git", ["rev-list", "--count", "HEAD"], {
				cwd: m.repoPath,
			});
			expect(stdout.trim()).toBe("2");
			expect(await readFile(join(m.repoPath, "src", "b.ts"), "utf8")).toBe(
				"export const b = 1;\n",
			);
			const { stdout: baseFiles } = await run(
				"git",
				["ls-tree", "-r", "--name-only", m.baseSha],
				{ cwd: m.repoPath },
			);
			expect(baseFiles.trim()).toBe("src/a.ts");
		} finally {
			await m.cleanup();
		}
	});

	it("removes the repo on cleanup", async () => {
		const seed = await loadSeed(
			await inlineSeed("REL-01", "original", defect()),
		);
		const m = await materializeSeed(seed);
		await m.cleanup();
		await expect(access(m.repoPath)).rejects.toThrow();
	});

	it("is reproducible", async () => {
		const seed = await loadSeed(
			await inlineSeed("REL-01", "original", defect()),
		);
		const a = await materializeSeed(seed);
		const b = await materializeSeed(seed);
		try {
			expect([a.baseSha, a.headSha]).toEqual([b.baseSha, b.headSha]);
		} finally {
			await a.cleanup();
			await b.cleanup();
		}
	});
});

describe("inherited GIT_* environment", () => {
	it("never touches an outer repository", async () => {
		const outer = join(root, "outer");
		await run("git", ["init", "-q", outer]);
		const seed = await loadSeed(
			await inlineSeed("REL-01", "original", defect()),
		);
		const saved = { ...process.env };
		process.env.GIT_DIR = join(outer, ".git");
		process.env.GIT_INDEX_FILE = join(outer, ".git", "index");
		process.env.GIT_WORK_TREE = outer;
		const m = await materializeSeed(seed);
		const input = await seedReviewInput(seed);
		try {
			expect(input.files.length).toBeGreaterThan(0);
			for (const k of Object.keys(process.env))
				if (k.startsWith("GIT_")) delete process.env[k];
			Object.assign(process.env, saved);
			const count = await run("git", [
				"-C",
				m.repoPath,
				"rev-list",
				"--count",
				"HEAD",
			]);
			expect(count.stdout.trim()).toBe("2");
		} finally {
			for (const k of Object.keys(process.env))
				if (k.startsWith("GIT_")) delete process.env[k];
			Object.assign(process.env, saved);
			await m.cleanup();
			await input.cleanup();
		}
		const commits = await run("git", [
			"-C",
			outer,
			"rev-list",
			"--all",
			"--count",
		]);
		expect(commits.stdout.trim()).toBe("0");
		const status = await run("git", ["-C", outer, "status", "--porcelain"]);
		expect(status.stdout.trim()).toBe("");
	});
});

describe("user git configuration", () => {
	it("does not change the commits", async () => {
		const seed = await loadSeed(
			await inlineSeed("REL-01", "original", defect()),
		);
		const plain = await materializeSeed(seed);
		const home = join(root, "home");
		await write(
			join(home, "template", "hooks", "pre-commit"),
			"#!/bin/sh\nexit 1\n",
		);
		await write(join(home, "attrs"), "* filter=evil\n");
		await write(
			join(home, ".gitconfig"),
			[
				"[commit]\n\tgpgsign = true",
				"[gpg]\n\tprogram = /nonexistent/gpg",
				`[init]\n\ttemplateDir = ${join(home, "template")}`,
				`[core]\n\thooksPath = ${join(home, "template", "hooks")}\n\tattributesFile = ${join(home, "attrs")}`,
				'[filter "evil"]\n\tclean = tr a b',
				"[user]\n\tuseConfigOnly = true",
			].join("\n"),
		);
		const saved = { ...process.env };
		process.env.HOME = home;
		process.env.XDG_CONFIG_HOME = join(home, "xdg");
		let configured: Awaited<ReturnType<typeof materializeSeed>> | undefined;
		try {
			configured = await materializeSeed(seed);
		} finally {
			process.env.HOME = saved.HOME;
			if (saved.XDG_CONFIG_HOME === undefined)
				delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
		}
		try {
			expect([configured.baseSha, configured.headSha]).toEqual([
				plain.baseSha,
				plain.headSha,
			]);
		} finally {
			await plain.cleanup();
			await configured.cleanup();
		}
	});
});

describe("listSeeds", () => {
	it("lists op-id directories in stable order and skips other directories", async () => {
		await inlineSeed("REL-10", "v1", defect());
		await inlineSeed("REL-01", "original", defect());
		await inlineSeed("REL-01", "clean", { clean: true });
		await mkdir(join(root, "__ignored__", "head"), { recursive: true });
		const seeds = await listSeeds(root);
		expect(seeds.map((s) => s.id)).toEqual([
			"REL-01/clean",
			"REL-01/original",
			"REL-10/v1",
		]);
	});
});

describe("seed trees are fixture data", () => {
	it("is excluded from tsc, biome and the test runner", async () => {
		for (const [file, needle] of [
			["tsconfig.json", "src/replay/seeds/**/head"],
			["tsconfig.json", "src/replay/seeds/**/base"],
			["biome.json", "!src/replay/seeds/**/head"],
			["biome.json", "!src/replay/seeds/**/base"],
			["vitest.config.ts", "src/replay/seeds/**/head/**"],
		] as const) {
			expect(await readFile(join(process.cwd(), file), "utf8")).toContain(
				needle,
			);
		}
		await access(
			join(
				process.cwd(),
				"src/replay/seeds/__exclusion-proof__/head/broken.test.ts",
			),
		);
	});
});
