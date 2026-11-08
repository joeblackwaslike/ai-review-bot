import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseSpikeArgs, runVerifierSpike } from "./command.js";

describe("parseSpikeArgs", () => {
	it("defaults to both tiers, a real run and a 10 dollar cap", () => {
		expect(parseSpikeArgs([])).toMatchObject({
			tiers: ["cheap", "mid"],
			plan: false,
			maxCostUsd: 10,
			json: false,
		});
	});

	it("reads a single tier, a cap, a cache dir, a fixtures dir and the plan flag", () => {
		expect(
			parseSpikeArgs([
				"--tier",
				"mid",
				"--max-cost",
				"2.5",
				"--cache",
				"/tmp/c",
				"--fixtures",
				"/tmp/f",
				"--plan",
				"--json",
			]),
		).toMatchObject({
			tiers: ["mid"],
			maxCostUsd: 2.5,
			cacheDir: "/tmp/c",
			fixtures: "/tmp/f",
			plan: true,
			json: true,
		});
	});

	it.each([
		[["--tier", "huge"]],
		[["--max-cost", "0"]],
		[["--max-cost", "-1"]],
		[["--max-cost", "abc"]],
		[["--tier"]],
		[["--bogus"]],
	])("rejects %j", (args) => {
		expect(parseSpikeArgs(args)).toHaveProperty("error");
	});
});

const writeFixture = (dir: string) => {
	const claim = (id: string, severity: string) => ({
		id,
		roundIndex: 0,
		reviewId: 1,
		source: "inline",
		commentId: 10,
		path: "src/a.ts",
		line: 3,
		severity,
		title: `title ${id}`,
		text: `text ${id}`,
	});
	writeFileSync(
		join(dir, "o__r__5__anthropic.json"),
		JSON.stringify({
			schemaVersion: 1,
			owner: "o",
			repo: "r",
			pull: 5,
			provider: "anthropic",
			author: "joe",
			recordedAt: "2026-11-01T00:00:00Z",
			rounds: [
				{
					index: 0,
					reviewId: 1,
					provider: "anthropic",
					submittedAt: "2026-11-01T00:00:00Z",
					headSha: "head",
					baseSha: "base",
					mergeBase: null,
					triggerAt: null,
					approximate: false,
					commitsSince: [],
					claims: [claim("a", "P2"), claim("b", "P3")],
				},
			],
			threads: [],
			reactions: [],
		}),
	);
	writeFileSync(
		join(dir, "o__r__5__anthropic.labels.json"),
		JSON.stringify({
			fixtureId: "o__r__5__anthropic",
			provisional: false,
			labels: [
				{
					claimId: "a",
					label: "rejected",
					confidence: "high",
					evidence: [],
					confirmed: true,
				},
				{
					claimId: "b",
					label: "fixed",
					confidence: "high",
					evidence: [],
					confirmed: true,
				},
			],
			repeatPairs: [],
			negativePairs: [],
			allowedSuppression: [],
		}),
	);
};

const setup = () => {
	const fixtures = mkdtempSync(join(tmpdir(), "spike-fx-"));
	writeFixture(fixtures);
	const lines: string[] = [];
	return {
		fixtures,
		cacheDir: mkdtempSync(join(tmpdir(), "spike-cache-")),
		out: (s: string) => lines.push(s),
		text: () => lines.join("\n"),
	};
};

describe("runVerifierSpike", () => {
	it("plans without fetching a file or calling a model", async () => {
		const s = setup();
		const call = vi.fn();
		const fetchFile = vi.fn();
		const code = await runVerifierSpike(["--plan"], {
			fixturesDir: s.fixtures,
			cacheDir: s.cacheDir,
			out: s.out,
			fetchFile,
			call,
			costOf: () => 0.001,
		});
		expect(code).toBe(0);
		expect(call).not.toHaveBeenCalled();
		expect(fetchFile).not.toHaveBeenCalled();
		expect(s.text()).toContain("2 findings");
		expect(s.text()).toContain("4 calls");
	});

	it("runs every judge over every finding and prints the table", async () => {
		const s = setup();
		const call = vi.fn(async () => ({
			refuted: true,
			reason: "pure_style" as const,
			rationale: "style",
			costUsd: 0.01,
		}));
		const code = await runVerifierSpike([], {
			fixturesDir: s.fixtures,
			cacheDir: s.cacheDir,
			out: s.out,
			fetchFile: async () => "file",
			call,
			costOf: () => 0,
		});
		expect(code).toBe(0);
		expect(call).toHaveBeenCalledTimes(4);
		expect(s.text()).toContain("| Producer | Judge | Tier |");
		expect(s.text()).toContain("gpt-6-luna");
		expect(s.text()).toContain("gpt-6.1-sol");
	});

	it("exits 3 and says so when the cost cap stops the run early", async () => {
		const s = setup();
		const call = vi.fn(async () => ({
			refuted: false,
			reason: null,
			rationale: "ok",
			costUsd: 5,
		}));
		const code = await runVerifierSpike(["--max-cost", "1"], {
			fixturesDir: s.fixtures,
			cacheDir: s.cacheDir,
			out: s.out,
			fetchFile: async () => "file",
			call,
			costOf: () => 0,
			concurrency: 1,
		});
		expect(code).toBe(3);
		expect(s.text()).toMatch(/cost cap/i);
	});

	it("refuses a real run when a judge model has no price, since the cost cap could not hold", async () => {
		const s = setup();
		const call = vi.fn();
		const code = await runVerifierSpike([], {
			fixturesDir: s.fixtures,
			cacheDir: s.cacheDir,
			out: s.out,
			fetchFile: async () => "file",
			call,
			costOf: () => undefined,
		});
		expect(code).toBe(1);
		expect(call).not.toHaveBeenCalled();
		expect(s.text()).toMatch(/no price/i);
		expect(s.text()).toContain("gpt-6-luna");
	});

	it("exits 2 on a bad argument without touching the fixtures", async () => {
		const s = setup();
		const code = await runVerifierSpike(["--tier", "huge"], {
			fixturesDir: s.fixtures,
			cacheDir: s.cacheDir,
			out: s.out,
			fetchFile: async () => "file",
			call: vi.fn(),
			costOf: () => 0,
		});
		expect(code).toBe(2);
		expect(s.text()).toContain("--tier");
	});

	it("emits JSON with the cells and the skipped counts", async () => {
		const s = setup();
		const code = await runVerifierSpike(["--json"], {
			fixturesDir: s.fixtures,
			cacheDir: s.cacheDir,
			out: s.out,
			fetchFile: async () => "file",
			call: async () => ({
				refuted: false,
				reason: null,
				rationale: "ok",
				costUsd: 0,
			}),
			costOf: () => 0,
		});
		expect(code).toBe(0);
		const parsed = JSON.parse(s.text());
		expect(parsed).toHaveProperty("cells");
		expect(parsed).toHaveProperty("skipped");
		expect(parsed.cells).toHaveLength(2);
		expect(parsed.results).toHaveLength(4);
		expect(parsed.results[0]).toMatchObject({
			itemId: expect.any(String),
			judgeId: expect.any(String),
			outcome: { kind: "verdict" },
		});
		expect(parsed.findings[0]).toMatchObject({
			id: expect.any(String),
			label: expect.stringMatching(/fixed|rejected/),
			severity: expect.any(String),
			confirmed: true,
			title: expect.any(String),
		});
	});
});
