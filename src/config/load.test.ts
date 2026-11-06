import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getConfigTree,
	getLoadedConfig,
	loadConfig,
	resetConfigForTests,
} from "./load.js";

const dirs: string[] = [];
function tempYaml(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "cfg-"));
	dirs.push(dir);
	const file = join(dir, "c.yaml");
	writeFileSync(file, text);
	return file;
}

afterEach(() => {
	resetConfigForTests();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadConfig", () => {
	it("the real .ai-review.yaml parses under ConfigSchema", () => {
		const { config } = loadConfig({ env: {} });
		expect(config.version).toBe(1);
		expect(Object.keys(config.reviewers)).toEqual([
			"claude",
			"codex",
			"gemini",
		]);
		expect(config.routing.complexLines).toBe(500);
	});

	it("missing yaml throws an error that names the resolved path", () => {
		expect(() =>
			loadConfig({ env: {}, yamlPath: "/nonexistent/dir/ai-review.yaml" }),
		).toThrow("/nonexistent/dir/ai-review.yaml");
	});

	it("keeps the read error as the cause", () => {
		let thrown: unknown;
		try {
			loadConfig({ env: {}, yamlPath: "/nonexistent/dir/ai-review.yaml" });
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).cause).toMatchObject({ code: "ENOENT" });
	});

	it("keeps the YAML parse error as the cause", () => {
		const file = tempYaml("a: [unclosed\n");
		let thrown: unknown;
		try {
			loadConfig({ env: {}, yamlPath: file });
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toContain("Invalid YAML");
		expect((thrown as Error).cause).toBeInstanceOf(Error);
	});

	it("env overlay is applied after yaml", () => {
		const { config, sources } = loadConfig({
			env: { AI_REVIEW_REVIEW__AGENT_CONCURRENCY: "7" },
		});
		expect(config.review.agentConcurrency).toBe(7);
		expect(sources["review.agentConcurrency"]).toBe("env");
	});

	it("invalid yaml surfaces the schema issue path", () => {
		const file = tempYaml(
			"version: 1\nmodels: {}\nreviewers: {}\nreview:\n  agentConcurrency: -1\n",
		);
		expect(() => loadConfig({ env: {}, yamlPath: file })).toThrow(
			/review\.agentConcurrency/,
		);
	});
});

describe("getConfigTree", () => {
	it("returns a frozen object", () => {
		const tree = getConfigTree();
		expect(Object.isFrozen(tree)).toBe(true);
		expect(Object.isFrozen(tree.routing.sensitivePathPatterns)).toBe(true);
		expect(() => {
			(tree as { version: number }).version = 2;
		}).toThrow(TypeError);
		expect(getLoadedConfig().config).toBe(tree);
	});
});
