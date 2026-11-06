import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerdictCache } from "./adjudication/cache.js";
import { PROMPT_HASH } from "./adjudication/judge.js";
import type { AdjudicationJudges } from "./adjudication/run.js";
import { claimKey, snapshotId } from "./adjudication/snapshot.js";
import { fixtureId } from "./claims.js";
import { defaultFixturesDir, runReplay } from "./command.js";
import type { GhClient } from "./gh.js";
import type { ReplayPipeline } from "./pipeline.js";
import { strategyA } from "./strategies/a.js";
import { registerStrategy, resetStrategiesForTest } from "./strategy.js";
import { makeFixture, makeLabel, makeLabels } from "./testkit.js";

const failRename = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (orig) => {
	const actual = await orig<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: (...a: Parameters<typeof actual.rename>) =>
			failRename.on
				? Promise.reject(new Error("rename boom"))
				: actual.rename(...a),
	};
});

const tmp = () => mkdtempSync(join(tmpdir(), "replay-"));

function seed(dir: string, labels = makeLabels()) {
	const f = makeFixture([["a", "b"], ["c"]]);
	const id = fixtureId(f);
	writeFileSync(join(dir, `${id}.json`), JSON.stringify(f));
	writeFileSync(
		join(dir, `${id}.labels.json`),
		JSON.stringify({ ...labels, fixtureId: id }),
	);
	return id;
}

function seedClean(dir: string, posted: number) {
	const f = makeFixture([["a"]], { expect: { clean: true } });
	const item = {
		skill: "s.md",
		title: "t",
		path: "a.ts",
		line: 1,
		severity: "high",
	};
	if (posted >= 0)
		f.rounds[0] = {
			...f.rounds[0],
			trace: { candidates: [], posted: posted ? [item] : [], usage: {} },
		} as (typeof f.rounds)[0];
	const id = fixtureId(f);
	writeFileSync(join(dir, `${id}.json`), JSON.stringify(f));
	writeFileSync(
		join(dir, `${id}.labels.json`),
		JSON.stringify({ ...makeLabels(), fixtureId: id }),
	);
	return id;
}

function collect() {
	const lines: string[] = [];
	return { lines, out: (s: string) => lines.push(s) };
}

const PR_URL = "https://github.com/o/r/pull/7";

function fakeClient(): GhClient {
	return {
		async rest<T>(route: string): Promise<T> {
			if (route.endsWith("/pulls/7"))
				return { user: { login: "me" }, base: { sha: "base" } } as T;
			return [] as T;
		},
		async graphql<T>(): Promise<T> {
			return {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			} as T;
		},
	};
}

const recordArgs = [
	"--record",
	PR_URL,
	"--provider",
	"anthropic",
	"--bot",
	"bot[bot]",
];

describe("runReplay", () => {
	it("exits non-zero when a clean fixture posted something", async () => {
		const dir = tmp();
		const id = seedClean(dir, 1);
		const { lines, out } = collect();
		expect(await runReplay([], { fixturesDir: dir, out })).toBe(1);
		expect(lines.join("\n")).toContain(`FAIL ${id} round 0`);
	});

	it("warns on a clean fixture with no trace and exits 0", async () => {
		const dir = tmp();
		const id = seedClean(dir, -1);
		const { lines, out } = collect();
		expect(await runReplay([], { fixturesDir: dir, out })).toBe(0);
		expect(lines.join("\n")).toContain(
			`warning ${id}: clean fixture has no trace`,
		);
	});

	it("no flags replays every fixture in the directory and prints counts", async () => {
		const dir = tmp();
		const id = seed(dir);
		const { lines, out } = collect();
		const code = await runReplay([], { fixturesDir: dir, out });
		expect(code).toBe(0);
		const text = lines.join("\n");
		expect(text).toContain(id);
		expect(text).toContain("replayed 1 fixture");
	});

	it("ignores .classes.json files in the fixtures directory", async () => {
		const dir = tmp();
		const id = seed(dir);
		writeFileSync(
			join(dir, `${id}.classes.json`),
			JSON.stringify({ records: [] }),
		);
		const { lines, out } = collect();
		const code = await runReplay([], { fixturesDir: dir, out });
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("replayed 1 fixture");
	});

	it("prints the false-positive class report when a classes file exists", async () => {
		const dir = tmp();
		const id = seed(
			dir,
			makeLabels({
				labels: [makeLabel("a", "rejected"), makeLabel("b", "rejected")],
			}),
		);
		const rec = (
			claimId: string,
			c: "filler" | "stale",
			x: "filler" | "stale" | "other",
		) => ({
			claimId,
			rules: c === "filler" ? ("filler" as const) : null,
			claude: c,
			codex: x,
			final: c === x ? c : "unadjudicated",
			reactionOnly: false,
		});
		writeFileSync(
			join(dir, `${id}.classes.json`),
			JSON.stringify({
				fixtureId: id,
				provisional: true,
				records: [rec("a", "filler", "filler"), rec("b", "stale", "other")],
			}),
		);
		const { lines, out } = collect();
		expect(await runReplay([], { fixturesDir: dir, out })).toBe(0);
		const text = lines.join("\n");
		expect(text).toContain("classified 1 of 2 first-seen rejected");
		expect(text).toMatch(/filler\s+1/);
		expect(text).toMatch(/stale\s+0/);
		expect(text).toContain("agreement 1 of 2");
		expect(text).toContain("rules vs models: 1 of 1");
		expect(text).toContain("unadjudicated 1");
		expect(text).toContain("provisional");
		expect(text).toMatch(
			/candidate retraction rule would remove 0 of \d+ filler, 0 other-rejected, 0 unadjudicated, 0 of \d+ fixed/,
		);
	});

	it("skips a classes file with no labels file and keeps it out of the report", async () => {
		const dir = tmp();
		const id = seed(
			dir,
			makeLabels({
				labels: [makeLabel("a", "rejected"), makeLabel("b", "rejected")],
			}),
		);
		const rec = (claimId: string) => ({
			claimId,
			rules: null,
			claude: "other",
			codex: "other",
			final: "other",
			reactionOnly: false,
		});
		writeFileSync(
			join(dir, `${id}.classes.json`),
			JSON.stringify({
				fixtureId: id,
				provisional: true,
				records: [rec("a"), rec("b")],
			}),
		);
		writeFileSync(
			join(dir, "ghost__r__9__anthropic.classes.json"),
			JSON.stringify({
				fixtureId: "ghost__r__9__anthropic",
				provisional: true,
				records: [rec("x"), rec("y"), rec("z")],
			}),
		);
		const { lines, out } = collect();
		expect(await runReplay([], { fixturesDir: dir, out })).toBe(0);
		const text = lines.join("\n");
		expect(text).toContain(
			"ghost__r__9__anthropic.classes.json: skipped: no labels file",
		);
		expect(text).toContain("classified 2 of 2 first-seen rejected");
	});

	it("prints no filter margin when there are no classes files", async () => {
		const dir = tmp();
		seed(dir);
		const { lines, out } = collect();
		expect(await runReplay([], { fixturesDir: dir, out })).toBe(0);
		expect(lines.join("\n")).not.toContain("candidate retraction rule");
	});

	it("exits 1 when the guard has a failure and 0 when only warnings", async () => {
		const suppressA: ReplayPipeline = ({ claims }) => ({
			posted: claims.filter((c) => c.id !== "a").map((c) => c.id),
			suppressed: claims.filter((c) => c.id === "a").map((c) => c.id),
		});
		const { out } = collect();

		const failDir = tmp();
		seed(
			failDir,
			makeLabels({ labels: [makeLabel("a", "rejected", { confirmed: true })] }),
		);
		expect(
			await runReplay([], { fixturesDir: failDir, out, pipeline: suppressA }),
		).toBe(1);

		const warnDir = tmp();
		seed(
			warnDir,
			makeLabels({
				labels: [makeLabel("a", "rejected", { confirmed: false })],
			}),
		);
		expect(
			await runReplay([], { fixturesDir: warnDir, out, pipeline: suppressA }),
		).toBe(0);
	});

	it("--record writes the fixture and a proposed labels file with the fake client", async () => {
		const dir = tmp();
		const { out } = collect();
		const code = await runReplay(recordArgs, {
			client: fakeClient(),
			fixturesDir: dir,
			out,
		});
		expect(code).toBe(0);
		const id = "o__r__7__anthropic";
		expect(existsSync(join(dir, `${id}.json`))).toBe(true);
		const labels = JSON.parse(
			readFileSync(join(dir, `${id}.labels.json`), "utf8"),
		);
		expect(labels.fixtureId).toBe(id);
		expect(labels.provisional).toBe(true);
	});

	it("--record does not overwrite a labels file that has confirmed entries", async () => {
		const dir = tmp();
		const { out } = collect();
		const id = "o__r__7__anthropic";
		const confirmed = makeLabels({
			fixtureId: id,
			labels: [makeLabel("r0:c1:0", "fixed")],
		});
		const path = join(dir, `${id}.labels.json`);
		writeFileSync(path, JSON.stringify(confirmed));
		const before = readFileSync(path, "utf8");
		const code = await runReplay(recordArgs, {
			client: fakeClient(),
			fixturesDir: dir,
			out,
		});
		expect(code).toBe(0);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(existsSync(join(dir, `${id}.labels.proposed.json`))).toBe(true);
	});

	it("unknown flag prints usage and exits 2", async () => {
		const { lines, out } = collect();
		const code = await runReplay(["--bogus"], { fixturesDir: tmp(), out });
		expect(code).toBe(2);
		const text = lines.join("\n");
		expect(text).toContain("Usage");
		expect(text).toContain("ai-review replay");
		expect(text).toContain("--record");
		expect(text).toContain("--fixtures");
	});

	it("--record without provider and bot exits 2", async () => {
		const { out } = collect();
		const code = await runReplay(["--record", PR_URL], {
			client: fakeClient(),
			fixturesDir: tmp(),
			out,
		});
		expect(code).toBe(2);
	});

	it("a fixture with no labels file exits 1", async () => {
		const dir = tmp();
		const f = makeFixture([["a"]]);
		writeFileSync(join(dir, `${fixtureId(f)}.json`), JSON.stringify(f));
		const { lines, out } = collect();
		expect(await runReplay([], { fixturesDir: dir, out })).toBe(1);
		expect(lines.join("\n")).toContain("missing");
	});

	it("an empty or missing fixtures dir exits 1 with a hint", async () => {
		for (const dir of [tmp(), join(tmp(), "nope")]) {
			const { lines, out } = collect();
			expect(await runReplay([], { fixturesDir: dir, out })).toBe(1);
			expect(lines.join("\n")).toContain(
				`no fixtures found in ${dir}; record some with --record`,
			);
		}
	});

	it("--record reports a failing client without throwing", async () => {
		const dir = tmp();
		const { lines, out } = collect();
		const client: GhClient = {
			async rest() {
				throw new Error("HTTP 502 boom");
			},
			async graphql() {
				throw new Error("unused");
			},
		};
		const code = await runReplay(recordArgs, { client, fixturesDir: dir, out });
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("record failed: HTTP 502 boom");
	});

	it("--record refuses to touch a corrupt existing labels file", async () => {
		const dir = tmp();
		const { lines, out } = collect();
		const path = join(dir, "o__r__7__anthropic.labels.json");
		writeFileSync(path, "{not json");
		const code = await runReplay(recordArgs, {
			client: fakeClient(),
			fixturesDir: dir,
			out,
		});
		expect(code).toBe(1);
		expect(lines.join("\n")).toMatch(/record failed: .*labels\.json/);
		expect(readFileSync(path, "utf8")).toBe("{not json");
	});
});

describe("runReplay live and record flags", () => {
	const item = {
		skill: "s.md",
		title: "t",
		path: "a.ts",
		line: 1,
		severity: "high",
	};
	const stubStrategy = (
		posted: number,
		estimate: () => number,
		onRun: () => void = () => {},
	) => {
		resetStrategiesForTest();
		registerStrategy({
			name: "a",
			version: "1",
			needsCheckout: false,
			estimateCost: estimate,
			run: async () => {
				onRun();
				return {
					findings: [],
					candidates: [],
					posted: Array.from({ length: posted }, () => item),
					usage: {},
					toolCalls: [],
					wallMs: 0,
				};
			},
		});
	};
	afterEach(() => resetStrategiesForTest());
	type Wiring = NonNullable<Parameters<typeof runReplay>[1]>["liveWiring"];
	const fetchOnly = (() => ({
		fetchDiff: async () => ({ diff: "d", files: [], approximate: false }),
	})) as unknown as Wiring;
	const wiringFor = (n: number) => {
		stubStrategy(n, () => 0);
		return fetchOnly;
	};

	function seedLive(dir: string, clean: boolean) {
		const f = makeFixture([["a"]], clean ? { expect: { clean: true } } : {});
		const id = fixtureId(f);
		writeFileSync(join(dir, `${id}.json`), JSON.stringify(f, null, 2));
		writeFileSync(
			join(dir, `${id}.labels.json`),
			JSON.stringify({ ...makeLabels(), fixtureId: id }),
		);
		return { id, path: join(dir, `${id}.json`) };
	}

	it("--save-trace writes the trace deterministically", async () => {
		const dir = tmp();
		const { path } = seedLive(dir, false);
		const run = () =>
			runReplay(["--live", "--save-trace"], {
				fixturesDir: dir,
				out: () => {},
				client: fakeClient(),
				liveWiring: wiringFor(1),
			});
		expect(await run()).toBe(0);
		const first = readFileSync(path, "utf8");
		const round = JSON.parse(first).rounds[0];
		expect(Object.keys(round).at(-1)).toBe("trace");
		expect(Object.keys(round.trace)).toEqual(["candidates", "posted", "usage"]);
		expect(round.trace.posted).toHaveLength(1);
		expect(first.endsWith("}\n")).toBe(true);
		await run();
		expect(readFileSync(path, "utf8")).toBe(first);
	});

	it("resolves the real built-in strategy a when --strategy is absent", async () => {
		resetStrategiesForTest();
		const dir = tmp();
		seedLive(dir, false);
		const estimate = vi.spyOn(strategyA, "estimateCost").mockReturnValue(0);
		const run = vi.spyOn(strategyA, "run").mockResolvedValue({
			findings: [],
			candidates: [],
			posted: [],
			usage: {},
			toolCalls: [],
			wallMs: 0,
		});
		expect(
			await runReplay(["--live"], {
				fixturesDir: dir,
				out: () => {},
				client: fakeClient(),
				liveWiring: fetchOnly,
			}),
		).toBe(0);
		expect(estimate).toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
		estimate.mockRestore();
		run.mockRestore();
	});

	it("leaves the fixture untouched without --save-trace", async () => {
		const dir = tmp();
		const { path } = seedLive(dir, false);
		const before = readFileSync(path, "utf8");
		await runReplay(["--live"], {
			fixturesDir: dir,
			out: () => {},
			client: fakeClient(),
			liveWiring: wiringFor(1),
		});
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("fails a clean fixture that would post, passes one that posts nothing", async () => {
		const dir = tmp();
		const { id } = seedLive(dir, true);
		const { lines, out } = collect();
		const base = { fixturesDir: dir, client: fakeClient() };
		expect(
			await runReplay(["--live"], { ...base, out, liveWiring: wiringFor(1) }),
		).toBe(1);
		expect(lines).toContain(
			`FAIL ${id} round 0: clean fixture would post 1 findings`,
		);
		expect(
			await runReplay(["--live"], {
				...base,
				out: () => {},
				liveWiring: wiringFor(0),
			}),
		).toBe(0);
	});

	it("exits 1 and reports the estimated total spend, failing round included, when the strategy throws mid-run", async () => {
		const dir = tmp();
		const f = makeFixture([["a"], ["b"]]);
		const id = fixtureId(f);
		writeFileSync(join(dir, `${id}.json`), JSON.stringify(f, null, 2));
		writeFileSync(
			join(dir, `${id}.labels.json`),
			JSON.stringify({ ...makeLabels(), fixtureId: id }),
		);
		let runs = 0;
		stubStrategy(
			0,
			() => 1,
			() => {
				if (++runs === 2) throw new Error("model exploded");
			},
		);
		const { lines, out } = collect();
		expect(
			await runReplay(["--live"], {
				fixturesDir: dir,
				out,
				client: fakeClient(),
				liveWiring: fetchOnly,
			}),
		).toBe(1);
		expect(lines).toContain(
			`live failed for ${id}: a round 1: model exploded (estimated spend $2.00 across fixtures)`,
		);
	});

	it("exits 1 with one line when a cost estimate is invalid, reviewing nothing", async () => {
		const dir = tmp();
		const { id } = seedLive(dir, false);
		const { lines, out } = collect();
		let reviews = 0;
		stubStrategy(
			0,
			() => Number.NaN,
			() => reviews++,
		);
		const wiring = fetchOnly;
		expect(
			await runReplay(["--live"], {
				fixturesDir: dir,
				out,
				client: fakeClient(),
				liveWiring: wiring,
			}),
		).toBe(1);
		expect(lines).toContain(
			`live failed for ${id}: round 0: invalid cost estimate NaN`,
		);
		expect(reviews).toBe(0);
	});

	describe("a clean fixture the cost cap cut short", () => {
		const costly = (n: number) => {
			stubStrategy(n, () => 1);
			return fetchOnly;
		};
		const seedTwoRounds = (dir: string) => {
			const f = makeFixture([["a"], ["b"]], { expect: { clean: true } });
			const id = fixtureId(f);
			writeFileSync(join(dir, `${id}.json`), JSON.stringify(f, null, 2));
			writeFileSync(
				join(dir, `${id}.labels.json`),
				JSON.stringify({ ...makeLabels(), fixtureId: id }),
			);
			return id;
		};
		const run = (maxCost: string, posted: number) => {
			const dir = tmp();
			const id = seedTwoRounds(dir);
			const { lines, out } = collect();
			return runReplay(["--live", "--max-cost", maxCost], {
				fixturesDir: dir,
				out,
				client: fakeClient(),
				liveWiring: costly(posted),
			}).then((code) => ({ code, lines, id }));
		};

		it("warns when the cap stops it before the first round", async () => {
			const { code, lines, id } = await run("0.5", 0);
			expect(code).toBe(0);
			expect(lines).toContain(
				`UNCHECKED ${id}: cost cap stopped before round 0 (0 of 2 rounds replayed)`,
			);
		});

		it("warns when the cap stops it after a clean first round", async () => {
			const { code, lines, id } = await run("1.5", 0);
			expect(code).toBe(0);
			expect(lines).toContain(
				`UNCHECKED ${id}: cost cap stopped before round 1 (1 of 2 rounds replayed)`,
			);
		});

		it("still fails when a replayed round posts", async () => {
			const { code, lines, id } = await run("1.5", 1);
			expect(code).toBe(1);
			expect(lines).toContain(
				`FAIL ${id} round 0: clean fixture would post 1 findings`,
			);
		});

		it("says nothing extra when every selected round ran", async () => {
			const { code, lines } = await run("5", 0);
			expect(code).toBe(0);
			expect(lines.some((l) => l.startsWith("UNCHECKED"))).toBe(false);
		});
	});

	it("passes a non-clean fixture that posts findings", async () => {
		const dir = tmp();
		seedLive(dir, false);
		expect(
			await runReplay(["--live"], {
				fixturesDir: dir,
				out: () => {},
				client: fakeClient(),
				liveWiring: wiringFor(2),
			}),
		).toBe(0);
	});

	it("--record sets heldOut and expect only when asked", async () => {
		const flagged = tmp();
		expect(
			await runReplay(
				[...recordArgs, "--held-out", "--expect-clean", "--fixtures", flagged],
				{ client: fakeClient(), out: () => {} },
			),
		).toBe(0);
		const plain = tmp();
		expect(
			await runReplay([...recordArgs, "--fixtures", plain], {
				client: fakeClient(),
				out: () => {},
			}),
		).toBe(0);
		const read = (d: string) =>
			JSON.parse(
				readFileSync(
					join(
						d,
						readdirSync(d).find(
							(n) => n.endsWith(".json") && !n.includes(".labels."),
						) as string,
					),
					"utf8",
				),
			);
		expect(read(flagged).heldOut).toBe(true);
		expect(read(flagged).expect).toEqual({ clean: true });
		expect("heldOut" in read(plain)).toBe(false);
		expect("expect" in read(plain)).toBe(false);
	});

	it("cleans up the temp file when the write fails", async () => {
		const dir = tmp();
		const { path } = seedLive(dir, false);
		failRename.on = true;
		try {
			await expect(
				runReplay(["--live", "--save-trace"], {
					fixturesDir: dir,
					out: () => {},
					client: fakeClient(),
					liveWiring: wiringFor(1),
				}),
			).rejects.toThrow("rename boom");
		} finally {
			failRename.on = false;
		}
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});

	it("keeps the fixture file mode when saving a trace", async () => {
		const dir = tmp();
		const { path } = seedLive(dir, false);
		chmodSync(path, 0o640);
		await runReplay(["--live", "--save-trace"], {
			fixturesDir: dir,
			out: () => {},
			client: fakeClient(),
			liveWiring: wiringFor(1),
		});
		expect(statSync(path).mode & 0o777).toBe(0o640);
	});

	it("--rounds 1 writes the last round and leaves an earlier trace alone", async () => {
		const dir = tmp();
		const f = makeFixture([["a"], ["b"]]);
		const old = {
			candidates: [],
			posted: [],
			usage: { "s.md": { promptTokens: 1, completionTokens: 1 } },
		};
		f.rounds[0] = { ...f.rounds[0], trace: old } as (typeof f.rounds)[0];
		const id = fixtureId(f);
		const path = join(dir, `${id}.json`);
		writeFileSync(path, JSON.stringify(f, null, 2));
		writeFileSync(
			join(dir, `${id}.labels.json`),
			JSON.stringify({ ...makeLabels(), fixtureId: id }),
		);
		await runReplay(["--live", "--rounds", "1", "--save-trace"], {
			fixturesDir: dir,
			out: () => {},
			client: fakeClient(),
			liveWiring: wiringFor(1),
		});
		const rounds = JSON.parse(readFileSync(path, "utf8")).rounds;
		expect(rounds[0].trace).toEqual(old);
		expect(rounds[1].trace.posted).toHaveLength(1);
	});

	it("fails a clean fixture with no labels file", async () => {
		const dir = tmp();
		const { id } = seedLive(dir, true);
		rmSync(join(dir, `${id}.labels.json`));
		const { lines, out } = collect();
		expect(
			await runReplay(["--live"], {
				fixturesDir: dir,
				out,
				client: fakeClient(),
				liveWiring: wiringFor(0),
			}),
		).toBe(1);
		expect(lines).toContain(`FAIL ${id}: clean fixture has no labels file`);
	});

	it("re-record keeps heldOut and expect, drops traces, and notes it", async () => {
		const dir = tmp();
		const first = tmp();
		await runReplay([...recordArgs, "--fixtures", first], {
			client: fakeClient(),
			out: () => {},
		});
		const name = readdirSync(first).find(
			(n) => n.endsWith(".json") && !n.includes(".labels."),
		) as string;
		const f = JSON.parse(readFileSync(join(first, name), "utf8"));
		f.heldOut = true;
		f.expect = { clean: true };
		f.rounds = [
			{
				...(f.rounds[0] ?? {}),
				trace: { candidates: [], posted: [], usage: {} },
			},
		];
		writeFileSync(join(dir, name), JSON.stringify(f));
		const { lines, out } = collect();
		await runReplay([...recordArgs, "--fixtures", dir], {
			client: fakeClient(),
			out,
		});
		const after = JSON.parse(readFileSync(join(dir, name), "utf8"));
		expect(after.heldOut).toBe(true);
		expect(after.expect).toEqual({ clean: true });
		expect(JSON.stringify(after.rounds)).not.toContain("trace");
		expect(lines.join("\n")).toContain("replay --live --save-trace");
	});

	it("documents the new flags in usage and rejects --record with --save-trace", async () => {
		const { lines, out } = collect();
		expect(
			await runReplay([...recordArgs, "--live", "--save-trace"], {
				fixturesDir: tmp(),
				client: fakeClient(),
				out,
			}),
		).toBe(2);
		const text = lines.join("\n");
		for (const flag of [
			"--live",
			"--save-trace",
			"--held-out",
			"--expect-clean",
			"--strategy",
		])
			expect(text).toContain(flag);
	});

	it("--strategy a and the default both run strategy a", async () => {
		for (const args of [["--live", "--strategy", "a"], ["--live"]]) {
			const dir = tmp();
			seedLive(dir, false);
			const names: string[] = [];
			stubStrategy(
				0,
				() => 0,
				() => names.push("ran"),
			);
			expect(
				await runReplay(args, {
					fixturesDir: dir,
					out: () => {},
					client: fakeClient(),
					liveWiring: fetchOnly,
				}),
			).toBe(0);
			expect(names).toEqual(["ran"]);
		}
	});

	it("--strategy with an unknown name exits 2, lists known names and never builds the wiring", async () => {
		const dir = tmp();
		seedLive(dir, false);
		stubStrategy(0, () => 0);
		const wiring = vi.fn(fetchOnly as never) as unknown as Wiring;
		const { lines, out } = collect();
		expect(
			await runReplay(["--live", "--strategy", "nope"], {
				fixturesDir: dir,
				out,
				client: fakeClient(),
				liveWiring: wiring,
			}),
		).toBe(2);
		expect(wiring).not.toHaveBeenCalled();
		expect(lines.join("\n")).toContain('unknown strategy "nope"');
		expect(lines.join("\n")).toContain("registered: a");
	});

	it("--strategy needs a value", async () => {
		const { lines, out } = collect();
		expect(
			await runReplay(["--live", "--strategy"], {
				fixturesDir: tmp(),
				out,
				client: fakeClient(),
			}),
		).toBe(2);
		expect(lines.join("\n")).toContain("--strategy <name>");
	});

	it("--strategy requires --live and no --record", async () => {
		for (const args of [
			["--strategy", "a"],
			[...recordArgs, "--live", "--strategy", "a"],
		]) {
			const { lines, out } = collect();
			expect(
				await runReplay(args, {
					fixturesDir: tmp(),
					out,
					client: fakeClient(),
				}),
			).toBe(2);
			expect(lines.join("\n")).toContain(
				"--strategy requires --live without --record",
			);
		}
	});

	it("rejects flags used outside their mode", async () => {
		for (const args of [["--save-trace"], ["--held-out"], ["--expect-clean"]]) {
			const { lines, out } = collect();
			expect(await runReplay(args, { fixturesDir: tmp(), out })).toBe(2);
			expect(lines.join("\n")).toContain("require");
		}
	});
});

describe("defaultFixturesDir", () => {
	const root = join(import.meta.dirname, "..", "..");
	const want = join(root, "src", "replay", "fixtures");
	it("resolves to src/replay/fixtures from a src-style URL", () => {
		const url = pathToFileURL(join(root, "src", "replay", "command.ts")).href;
		expect(defaultFixturesDir(url)).toBe(want);
	});
	it("resolves to src/replay/fixtures from a dist-style URL", () => {
		const url = pathToFileURL(join(root, "dist", "replay", "command.js")).href;
		expect(defaultFixturesDir(url)).toBe(want);
	});
});

describe("runReplay --investigate-join", () => {
	const noRest: GhClient = {
		rest: () => Promise.reject(new Error("no network")),
		graphql: () => Promise.reject(new Error("no network")),
	};

	it("judges with the other family and prints the counts", async () => {
		const dir = tmp();
		const f = makeFixture([["a"]]);
		f.rounds[0] = {
			...f.rounds[0],
			trace: {
				candidates: [
					{
						skill: "s.md",
						title: "other wording",
						path: "a.ts",
						line: 1,
						severity: "P1",
					},
				],
				posted: [],
				usage: {},
			},
		} as (typeof f.rounds)[0];
		const id = fixtureId(f);
		writeFileSync(join(dir, `${id}.json`), JSON.stringify(f));
		writeFileSync(
			join(dir, `${id}.labels.json`),
			JSON.stringify({
				...makeLabels({ labels: [makeLabel("a", "fixed")] }),
				fixtureId: id,
			}),
		);
		const families: string[] = [];
		const { lines, out } = collect();
		const code = await runReplay(
			["--investigate-join", id, "--fixtures", dir],
			{
				out,
				client: noRest,
				joinJudge: async (family) => {
					families.push(family);
					return async () => ({ verdict: "same", reason: "r" });
				},
			},
		);
		expect(code).toBe(0);
		expect(families).toEqual(["openai"]);
		expect(lines.join("\n")).toContain("judgeFoundMatcherMissed=1");
	});

	it("fetches each round's diff once and states the judgement is single-provider", async () => {
		const dir = tmp();
		const f = makeFixture([["a"]]);
		const cands = [1, 2, 3].map((n) => ({
			skill: "s.md",
			title: `other wording ${n}`,
			path: "a.ts",
			line: n * 100,
			severity: "P1",
		}));
		f.rounds[0] = {
			...f.rounds[0],
			trace: { candidates: cands, posted: [], usage: {} },
		} as (typeof f.rounds)[0];
		const id = fixtureId(f);
		writeFileSync(join(dir, `${id}.json`), JSON.stringify(f));
		writeFileSync(
			join(dir, `${id}.labels.json`),
			JSON.stringify({
				...makeLabels({ labels: [makeLabel("a", "fixed")] }),
				fixtureId: id,
			}),
		);
		let calls = 0;
		const client: GhClient = {
			rest: () => {
				calls++;
				return Promise.reject(new Error("no network"));
			},
			graphql: () => Promise.reject(new Error("no network")),
		};
		const { lines, out } = collect();
		await runReplay(["--investigate-join", id, "--fixtures", dir], {
			out,
			client,
			joinJudge: async () => async () => ({
				verdict: "different",
				reason: "r",
			}),
		});
		expect(calls).toBe(1);
		const text = lines.join("\n");
		expect(text).toContain("judge: openai (");
		expect(text).toContain("single-provider judgement");
	});

	it("exits 2 when combined with other modes or given a path-like id", async () => {
		for (const args of [
			["--investigate-join", "x", "--live"],
			["--investigate-join", "x", "--save-trace"],
			["--investigate-join", "x", "--provider", "openai"],
			["--investigate-join", "x", "--bot", "some-bot"],
			["--investigate-join", "../x"],
			["--investigate-join"],
		])
			expect(await runReplay(args, { out: () => {} })).toBe(2);
	});

	it("exits 1 when the fixture is missing", async () => {
		expect(
			await runReplay(["--investigate-join", "nope", "--fixtures", tmp()], {
				out: () => {},
			}),
		).toBe(1);
	});
});

describe("runReplay --adjudicate", () => {
	const noRest: GhClient = {
		rest: () => Promise.reject(new Error("no network")),
		graphql: () => Promise.reject(new Error("no network")),
	};
	const withFiles: GhClient = {
		rest: async <T>() =>
			({ files: [{ filename: "a.ts", patch: "@@ -1 +1 @@\n+x" }] }) as T,
		graphql: () => Promise.reject(new Error("no network")),
	};

	function seedFixture(path: string | null = "a.ts") {
		const dir = tmp();
		const f = makeFixture([["a"]]);
		f.rounds[0] = {
			...f.rounds[0],
			trace: {
				candidates: [
					{
						skill: "s.md",
						title: "unrelated cache invalidation race condition",
						path,
						line: 1,
						severity: "P1",
					},
				],
				posted: [],
				usage: {},
			},
		} as (typeof f.rounds)[0];
		const id = fixtureId(f);
		writeFileSync(join(dir, `${id}.json`), JSON.stringify(f));
		writeFileSync(
			join(dir, `${id}.labels.json`),
			JSON.stringify({
				...makeLabels({ labels: [makeLabel("a", "fixed")] }),
				fixtureId: id,
			}),
		);
		return { dir, id };
	}

	const stubJudges = () => {
		const calls = { verdict: vi.fn(), audit: vi.fn() };
		const judges: AdjudicationJudges = {
			verdictJudges: async (producer, model, wantSecond) => {
				calls.verdict(producer, model, wantSecond);
				return {
					first: {
						family: "anthropic",
						model: "stub",
						run: async () => ({
							verdict: "real",
							scope: "change",
							reason: "r",
						}),
					},
					second: wantSecond
						? {
								family: "openai",
								model: "stub2",
								run: async () => ({
									verdict: "real",
									scope: "change",
									reason: "r",
								}),
							}
						: null,
				};
			},
			auditJudges: async () => {
				calls.audit();
				return {
					judge: { family: "anthropic", model: "stub", run: async () => [] },
					second: null,
				};
			},
		};
		return { judges, calls };
	};

	it("exits 2 on misuse", async () => {
		for (const args of [
			["--adjudicate", "x", "--plan", "--audit"],
			["--adjudicate", "../x"],
			["--adjudicate", "x", "--live"],
			["--adjudicate", "x", "--investigate-join", "y"],
			["--adjudicate", "x", "--record", "u"],
			["--plan"],
			["--audit"],
			["--max-openai", "2"],
			["--adjudicate", "x", "--max-openai", "-1"],
			["--adjudicate", "x", "--max-anthropic", "1.5"],
			["--adjudicate"],
		])
			expect(await runReplay(args, { out: () => {} })).toBe(2);
	});

	it("exits 1 when the fixture is missing", async () => {
		expect(
			await runReplay(["--adjudicate", "nope", "--fixtures", tmp()], {
				out: () => {},
			}),
		).toBe(1);
	});

	it("--plan constructs no judge and calls no model", async () => {
		const { dir, id } = seedFixture();
		const { judges, calls } = stubJudges();
		const { lines, out } = collect();
		const code = await runReplay(
			["--adjudicate", id, "--plan", "--fixtures", dir],
			{
				out,
				client: noRest,
				adjudicationJudges: judges,
				adjudicationDir: join(dir, "cache"),
			},
		);
		expect(code).toBe(0);
		expect(calls.verdict).not.toHaveBeenCalled();
		expect(calls.audit).not.toHaveBeenCalled();
		const text = lines.join("\n");
		expect(text).toContain("candidates to judge: 1");
		expect(text).toContain("anthropic calls allowed: 1 of 40");
		expect(text).toContain("openai calls allowed: 0");
	});

	it.each([
		["a stale prompt hash", "old-hash", "claude-opus-5-5", 0],
		["a model the judges would not pick", PROMPT_HASH, "old-model", 0],
		["a current record", PROMPT_HASH, "claude-opus-5-5", 1],
	])("--plan counts a cached record with %s only if adjudicate would accept it", async (_n, hash, model, cached) => {
		const { dir, id } = seedFixture();
		const f = JSON.parse(
			readFileSync(join(dir, `${id}.json`), "utf8"),
		) as Parameters<typeof snapshotId>[0];
		new VerdictCache(join(dir, "cache")).put(
			snapshotId(f),
			claimKey({
				path: "a.ts",
				title: "unrelated cache invalidation race condition",
			}),
			{
				verdict: "not-real",
				scope: null,
				reason: "r",
				first: { family: "anthropic", model, promptHash: hash },
				second: null,
				secondVerdict: null,
				status: "single-family",
			},
		);
		const { lines, out } = collect();
		await runReplay(["--adjudicate", id, "--plan", "--fixtures", dir], {
			out,
			client: noRest,
			adjudicationDir: join(dir, "cache"),
		});
		const text = lines.join("\n");
		expect(text).toContain(`cached: ${cached}`);
		expect(text).toContain(`candidates to judge: ${1 - cached}`);
	});

	it("routes the producer model from the round's compare files and defaults the OpenAI cap to 0", async () => {
		const { dir, id } = seedFixture();
		const { judges, calls } = stubJudges();
		const { lines, out } = collect();
		const code = await runReplay(["--adjudicate", id, "--fixtures", dir], {
			out,
			client: withFiles,
			adjudicationJudges: judges,
			adjudicationDir: join(dir, "cache"),
		});
		expect(code).toBe(0);
		expect(calls.verdict).toHaveBeenCalledWith(
			"anthropic",
			"claude-sonnet-5-5",
			false,
		);
		const text = lines.join("\n");
		expect(text).toContain("real=1");
		expect(text).toContain("single-family=1");
		expect(text).toContain("single-family verdicts have no second-model check");
		expect(text).toContain("anthropic=1 openai=0");
	});

	it("does not judge a candidate whose round diff could not be fetched", async () => {
		const { dir, id } = seedFixture();
		const { judges, calls } = stubJudges();
		const { lines, out } = collect();
		const code = await runReplay(
			["--adjudicate", id, "--max-openai", "3", "--fixtures", dir],
			{
				out,
				client: noRest,
				adjudicationJudges: judges,
				adjudicationDir: join(dir, "cache"),
			},
		);
		expect(code).toBe(0);
		expect(calls.verdict).not.toHaveBeenCalled();
		expect(existsSync(join(dir, "cache"))).toBe(false);
		const text = lines.join("\n");
		expect(text).toContain("evidence unavailable");
		expect(text).toContain("deferred=1");
	});

	it("aborts the audit without a record when the last round's diff cannot be fetched", async () => {
		const { dir, id } = seedFixture();
		const { judges, calls } = stubJudges();
		const { lines, out } = collect();
		const code = await runReplay(
			["--adjudicate", id, "--audit", "--fixtures", dir],
			{
				out,
				client: noRest,
				adjudicationJudges: judges,
				adjudicationDir: join(dir, "cache"),
			},
		);
		expect(code).toBe(1);
		expect(calls.audit).not.toHaveBeenCalled();
		expect(existsSync(join(dir, "cache"))).toBe(false);
		expect(lines.join("\n")).toContain("evidence unavailable");
	});

	it("judges a claim with the evidence of its first occurrence", async () => {
		const dir = tmp();
		const f = makeFixture([["a"], ["b"]]);
		const cand = (title: string, line: number) => ({
			skill: "s.md",
			title,
			path: "a.ts",
			line,
			severity: "P1",
		});
		const [r0, r1] = f.rounds;
		if (!r0 || !r1) throw new Error("rounds");
		f.rounds[0] = {
			...r0,
			headSha: "h1",
			trace: {
				candidates: [cand("Retry delay skipped", 1)],
				posted: [],
				usage: {},
			},
		} as typeof r0;
		f.rounds[1] = {
			...r1,
			headSha: "h2",
			trace: {
				candidates: [cand("skipped retry delay", 9)],
				posted: [],
				usage: {},
			},
		} as typeof r1;
		const id = fixtureId(f);
		writeFileSync(join(dir, `${id}.json`), JSON.stringify(f));
		writeFileSync(
			join(dir, `${id}.labels.json`),
			JSON.stringify({
				...makeLabels({ labels: [makeLabel("a", "fixed")] }),
				fixtureId: id,
			}),
		);
		const client: GhClient = {
			rest: async <T>(route: string) =>
				({
					files: [
						{
							filename: "a.ts",
							patch: route.endsWith("h1") ? "PATCH-ONE" : "PATCH-TWO",
						},
					],
				}) as T,
			graphql: () => Promise.reject(new Error("no network")),
		};
		const seen: string[] = [];
		const judges: AdjudicationJudges = {
			verdictJudges: async () => ({
				first: {
					family: "anthropic",
					model: "stub",
					run: async (input) => {
						seen.push(input.diffEvidence);
						return { verdict: "not-real", scope: null, reason: "r" };
					},
				},
				second: null,
			}),
			auditJudges: async () => {
				throw new Error("unused");
			},
		};
		await runReplay(["--adjudicate", id, "--fixtures", dir], {
			out: () => {},
			client,
			adjudicationJudges: judges,
			adjudicationDir: join(dir, "cache"),
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("PATCH-ONE");
	});

	it.each([
		["a null path", null, withFiles, "unanchored finding, no evidence"],
		[
			"a file missing from the compare files",
			"z.ts",
			withFiles,
			"no patch evidence",
		],
		[
			"a file with no patch",
			"a.ts",
			{
				rest: async <T>() => ({ files: [{ filename: "a.ts" }] }) as T,
				graphql: () => Promise.reject(new Error("no network")),
			} satisfies GhClient,
			"no patch evidence",
		],
	])("defers a candidate with %s instead of judging it", async (_n, path, client, reason) => {
		const { dir, id } = seedFixture(path);
		const { judges, calls } = stubJudges();
		const { lines, out } = collect();
		const code = await runReplay(["--adjudicate", id, "--fixtures", dir], {
			out,
			client,
			adjudicationJudges: judges,
			adjudicationDir: join(dir, "cache"),
		});
		expect(code).toBe(0);
		expect(calls.verdict).not.toHaveBeenCalled();
		expect(existsSync(join(dir, "cache"))).toBe(false);
		const text = lines.join("\n");
		expect(text).toContain(reason);
		expect(text).toContain("deferred=1");
	});

	it("prints error samples next to the error count", async () => {
		const { dir, id } = seedFixture();
		const { lines, out } = collect();
		await runReplay(["--adjudicate", id, "--fixtures", dir], {
			out,
			client: withFiles,
			adjudicationJudges: {
				verdictJudges: async () => ({
					first: {
						family: "anthropic",
						model: "stub",
						run: async () => {
							throw new Error("session expired");
						},
					},
					second: null,
				}),
				auditJudges: async () => {
					throw new Error("unused");
				},
			},
			adjudicationDir: join(dir, "cache"),
		});
		const text = lines.join("\n");
		expect(text).toContain("errors=1");
		expect(text).toContain("error samples: session expired");
	});

	it("--audit prints a failed cross-check", async () => {
		const { dir, id } = seedFixture();
		const { lines, out } = collect();
		const finding = {
			path: "a.ts",
			line: 1,
			title: "Unbounded loop never terminates on empty queue",
			body: "b",
		};
		await runReplay(
			["--adjudicate", id, "--audit", "--max-openai", "2", "--fixtures", dir],
			{
				out,
				client: withFiles,
				adjudicationJudges: {
					verdictJudges: async () => {
						throw new Error("unused");
					},
					auditJudges: async () => ({
						judge: {
							family: "anthropic",
							model: "stub",
							run: async () => [finding],
						},
						second: {
							family: "openai",
							model: "stub2",
							run: async () => {
								throw new Error("quota exhausted");
							},
						},
					}),
				},
				adjudicationDir: join(dir, "cache"),
			},
		);
		expect(lines.join("\n")).toContain("cross-check failed: quota exhausted");
	});

	it("--audit runs the audit judges", async () => {
		const { dir, id } = seedFixture();
		const { judges, calls } = stubJudges();
		const { lines, out } = collect();
		const code = await runReplay(
			["--adjudicate", id, "--audit", "--fixtures", dir],
			{
				out,
				client: withFiles,
				adjudicationJudges: judges,
				adjudicationDir: join(dir, "cache"),
			},
		);
		expect(code).toBe(0);
		expect(calls.audit).toHaveBeenCalledTimes(1);
		expect(lines.join("\n")).toContain("audit:");
	});
});
