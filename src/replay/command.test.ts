import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureId } from "./claims.js";
import { runReplay } from "./command.js";
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
		expect(lines.join("\n")).toContain("Usage");
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
});
