import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReplay } from "../command.js";
import {
	type ReviewStrategy,
	registerStrategy,
	resetStrategiesForTest,
	type StrategyInput,
} from "../strategy.js";
import type { CandidateRecord } from "../types.js";
import { checkSeeds, planSeeds, runSeedsWithStrategy } from "./run.js";

vi.setConfig({ testTimeout: 60_000 });

const OPS = ["REL-01", "REL-10", "DEL-04", "REL-03", "MEC-01"];
let root: string;
let lines: string[];
const out = (s: string) => lines.push(s);

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

async function addSeed(
	op: string,
	variant: string,
	truth: unknown,
): Promise<void> {
	const dir = join(root, op, variant);
	await write(join(dir, "base", "src", "a.ts"), "one\ntwo\nthree\n");
	await write(join(dir, "head", "src", "a.ts"), "one\nTWO\nthree\n");
	await write(join(dir, "truth.json"), JSON.stringify(truth));
}

const defectAt = (startLine: number, endLine = startLine) => ({
	clean: false,
	defects: [{ path: "src/a.ts", startLine, endLine, description: "d" }],
});

async function fullRoot(): Promise<void> {
	for (const op of OPS) {
		await addSeed(op, "original", defectAt(2));
		await addSeed(op, "clean", { clean: true });
	}
}

const posted = (path: string | null, line: number | null): CandidateRecord => ({
	skill: null,
	title: "t",
	path,
	line,
	severity: null,
});

const emptyResult = (postedFindings: CandidateRecord[]) => ({
	findings: [],
	candidates: [],
	posted: postedFindings,
	usage: {},
	toolCalls: [],
	wallMs: 1,
});

function stub(
	decide: (repo: string) => CandidateRecord[],
	over: Partial<Omit<ReviewStrategy, "run">> = {},
): ReviewStrategy & { run: ReturnType<typeof vi.fn> } {
	const run = vi.fn(async (input: StrategyInput) =>
		emptyResult(decide(input.fixture.repo)),
	);
	return {
		name: "stub",
		version: "1",
		needsCheckout: false,
		estimateCost: () => 0.1,
		run,
		...over,
	};
}

const findsAll = (repo: string) =>
	repo.endsWith("-clean") ? [] : [posted("src/a.ts", 2)];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "seed-run-"));
	lines = [];
	resetStrategiesForTest();
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("checkSeeds", () => {
	it("passes a valid root and reports counts without any strategy", async () => {
		await fullRoot();
		expect(await checkSeeds({ root, out })).toBe(0);
		expect(lines.join("\n")).toMatch(/10 seeds/);
	});

	it("fails when a defect lies outside the diff", async () => {
		await addSeed("REL-01", "original", defectAt(9));
		expect(await checkSeeds({ root, out })).toBe(1);
		expect(lines.join("\n")).toContain("REL-01/original");
	});

	it("fails when there are no seeds", async () => {
		expect(await checkSeeds({ root, out })).toBe(1);
	});

	it("fails on a malformed truth", async () => {
		await addSeed("REL-01", "original", { clean: false, defects: [] });
		expect(await checkSeeds({ root, out })).toBe(1);
	});
});

describe("zero seeds and malformed truth", () => {
	it("plan and strategy runs refuse an empty root", async () => {
		const s = stub(findsAll);
		expect(await planSeeds(s, { root, out })).toBe(1);
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 5 })).toBe(1);
		expect(s.run).not.toHaveBeenCalled();
		expect(lines.join("\n")).toContain(`no seeds found under ${root}`);
	});

	it("a malformed truth.json prints and exits 1 in all three modes", async () => {
		await addSeed("REL-01", "original", { clean: false, defects: [] });
		const s = stub(findsAll);
		expect(await checkSeeds({ root, out })).toBe(1);
		expect(await planSeeds(s, { root, out })).toBe(1);
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 5 })).toBe(1);
		expect(s.run).not.toHaveBeenCalled();
		expect(lines.join("\n")).toContain("seed load failed");
	});
});

describe("planSeeds", () => {
	it("prints count, strategy and cost and never runs the strategy", async () => {
		await fullRoot();
		const s = stub(findsAll);
		expect(await planSeeds(s, { root, out })).toBe(0);
		expect(s.run).not.toHaveBeenCalled();
		const text = lines.join("\n");
		expect(text).toContain("10 seeds");
		expect(text).toContain("stub");
		expect(text).toContain("$1.00");
	});
});

describe("planSeeds failures", () => {
	it("prints and exits 1 when estimateCost throws", async () => {
		await fullRoot();
		const s = stub(findsAll, {
			estimateCost: () => {
				throw new Error("estimate boom");
			},
		});
		expect(await planSeeds(s, { root, out })).toBe(1);
		expect(lines.join("\n")).toContain("seed plan failed: estimate boom");
	});

	it("prints and exits 1 when a seed cannot be materialised", async () => {
		await fullRoot();
		await rm(join(root, "REL-01", "original", "head"), { recursive: true });
		const s = stub(findsAll);
		expect(await planSeeds(s, { root, out })).toBe(1);
		expect(lines.join("\n")).toContain("seed plan failed:");
		expect(s.run).not.toHaveBeenCalled();
	});
});

describe("runSeedsWithStrategy", () => {
	it("passes the gate when every defect is found and controls are quiet", async () => {
		await fullRoot();
		const s = stub(findsAll);
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 5 })).toBe(0);
		expect(s.run).toHaveBeenCalledTimes(10);
		expect(lines.join("\n")).toMatch(/gate: pass/i);
	});

	it("fails the gate when two originals are missed", async () => {
		await fullRoot();
		const s = stub((repo) =>
			repo.startsWith("REL-01") || repo.startsWith("MEC-01")
				? []
				: findsAll(repo),
		);
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 5 })).toBe(1);
		expect(lines.join("\n")).toMatch(/gate: fail/i);
	});

	it("passes the gate when exactly one original is missed", async () => {
		await fullRoot();
		const s = stub((repo) => (repo.startsWith("REL-01") ? [] : findsAll(repo)));
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 5 })).toBe(0);
	});

	it("fails the gate on a clean control finding even when every defect is found", async () => {
		await fullRoot();
		const s = stub((repo) => [posted("src/a.ts", 2)].filter(() => repo !== ""));
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 5 })).toBe(1);
		const text = lines.join("\n");
		expect(text).toMatch(/originals missed 0/);
		expect(text).toMatch(/clean control findings 5/);
		expect(text).toMatch(/clean controls/);
	});

	it("a strategy that only posts on clean controls misses the originals and fails", async () => {
		await fullRoot();
		const s = stub((repo) =>
			repo.endsWith("-clean") ? [posted("src/a.ts", 2)] : [],
		);
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 5 })).toBe(1);
		const text = lines.join("\n");
		expect(text).toMatch(/originals missed 5/);
		expect(text).toMatch(/clean control findings 5/);
	});

	it("a strategy that only posts on defect seeds passes", async () => {
		await fullRoot();
		const s = stub((repo) =>
			repo.endsWith("-clean") ? [] : [posted("src/a.ts", 2)],
		);
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 5 })).toBe(0);
		expect(lines.join("\n")).toMatch(/clean control findings 0/);
	});

	it("stops at the cost cap and exits 1", async () => {
		await fullRoot();
		const s = stub(findsAll, { estimateCost: () => 0.6 });
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 1 })).toBe(1);
		expect(s.run).toHaveBeenCalledTimes(1);
		expect(lines.join("\n")).toMatch(/cost cap/);
	});

	it("hands a read-only checkout only to strategies that need one", async () => {
		await addSeed("REL-01", "original", defectAt(2));
		const seen: (string | null)[] = [];
		const needs = stub(findsAll, { needsCheckout: true });
		needs.run.mockImplementation(async (input: StrategyInput) => {
			seen.push(input.checkout?.path ?? null);
			expect(input.approximateDiff).toBe(false);
			return emptyResult(findsAll(input.fixture.repo));
		});
		await runSeedsWithStrategy(needs, { root, out, maxCostUsd: 5 });
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toBeNull();

		const plain = stub(findsAll);
		await runSeedsWithStrategy(plain, { root, out, maxCostUsd: 5 });
		const first = plain.run.mock.calls[0]?.[0] as StrategyInput;
		expect(first.checkout).toBeNull();
	});

	it("reports a strategy failure and exits 1", async () => {
		await fullRoot();
		const s = stub(findsAll);
		s.run.mockRejectedValue(new Error("boom"));
		expect(await runSeedsWithStrategy(s, { root, out, maxCostUsd: 5 })).toBe(1);
		expect(lines.join("\n")).toContain("boom");
	});
});

describe("ai-review replay --seeds", () => {
	const run = (args: string[]) =>
		runReplay(args, { out, seedsRoot: root, fixturesDir: root });

	it("defaults to --check and needs no strategy", async () => {
		await fullRoot();
		expect(await run(["--seeds"])).toBe(0);
		expect(await run(["--seeds", "--check"])).toBe(0);
	});

	it("--plan makes no strategy call", async () => {
		await fullRoot();
		const s = stub(findsAll);
		registerStrategy(s);
		expect(await run(["--seeds", "--plan", "--strategy", "stub"])).toBe(0);
		expect(s.run).not.toHaveBeenCalled();
	});

	it("--strategy runs and scores", async () => {
		await fullRoot();
		registerStrategy(stub(findsAll));
		expect(
			await run(["--seeds", "--strategy", "stub", "--max-cost", "5"]),
		).toBe(0);
	});

	it("exits 2 on misuse", async () => {
		const bad = [
			["--seeds", "--live"],
			["--seeds", "--record", "https://github.com/a/b/pull/1"],
			["--seeds", "--adjudicate", "x"],
			["--seeds", "--investigate-join", "x"],
			["--seeds", "--max-cost", "1"],
			["--seeds", "--check", "--strategy", "stub"],
			["--seeds", "--check", "--plan"],
			["--check"],
			["--seeds", "--fixtures", root],
		];
		for (const args of bad) expect(await run(args), args.join(" ")).toBe(2);
	});

	it("exits 2 on an unknown strategy", async () => {
		expect(await run(["--seeds", "--strategy", "nope"])).toBe(2);
	});
});
