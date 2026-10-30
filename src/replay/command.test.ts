import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureId } from "./claims.js";
import { defaultFixturesDir, runReplay } from "./command.js";
import type { GhClient } from "./gh.js";
import type { ReplayPipeline } from "./pipeline.js";
import { makeFixture, makeLabel, makeLabels } from "./testkit.js";

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
