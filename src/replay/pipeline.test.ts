import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureId } from "./claims.js";
import { checkRecall } from "./guard.js";
import { computeMetrics } from "./metrics.js";
import { todaysCodePipeline } from "./pipeline.js";
import { replayFixture } from "./replay.js";
import { makeFixture, makeLabel, makeLabels } from "./testkit.js";
import type { ClaimLabel, LabelFile, ReplayFixture } from "./types.js";

const TITLE = "Missing null check in parseConfig before reading options";

function repeatFixture(rounds: string[][]): ReplayFixture {
	const f = makeFixture(rounds);
	for (const r of f.rounds) for (const c of r.claims) c.title = TITLE;
	return f;
}

const suppressedIds = (f: ReplayFixture, labels: ClaimLabel[]) =>
	replayFixture(f, makeLabels({ labels }), todaysCodePipeline).rounds.flatMap(
		(r) => r.suppressed,
	);

describe("todaysCodePipeline", () => {
	it("suppresses a repeat of a claim the author rejected with visible evidence", () => {
		const f = repeatFixture([["a"], ["b"]]);
		expect(suppressedIds(f, [makeLabel("a", "rejected")])).toEqual(["b"]);
	});

	it("posts a repeat when the earlier label is low confidence", () => {
		const f = repeatFixture([["a"], ["b"]]);
		const labels = [makeLabel("a", "rejected", { confidence: "low" })];
		expect(suppressedIds(f, labels)).toEqual([]);
	});

	it("posts a repeat whose evidence is timestamped after the round cutoff", () => {
		const f = repeatFixture([["a"], ["b"]]);
		const labels = [
			makeLabel("a", "rejected", { evidence: ["2026-01-02T11:00:00Z|later"] }),
		];
		expect(suppressedIds(f, labels)).toEqual([]);
	});

	it("never suppresses round-0 claims", () => {
		const f = repeatFixture([["a", "b"]]);
		const labels = [
			makeLabel("a", "rejected", { evidence: ["2025-12-31T00:00:00Z|x"] }),
			makeLabel("b", "fixed", { evidence: ["2025-12-31T00:00:00Z|x"] }),
		];
		expect(suppressedIds(f, labels)).toEqual([]);
	});
});

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FIXTURE_RECYCLED: Record<string, number> = {
	"joeblackwaslike__agent-skills__10__anthropic": 1,
	"joeblackwaslike__agent-skills__10__openai": 0,
	"joeblackwaslike__ai-listings__74__anthropic": 0,
	"joeblackwaslike__ai-listings__74__openai": 0,
	"joeblackwaslike__stealth-browser__1__anthropic": 2,
	"joeblackwaslike__stealth-browser__1__openai": 4,
};

describe("todaysCodePipeline on committed fixtures", () => {
	const names = readdirSync(dir).filter(
		(n) => n.endsWith(".json") && !n.includes(".labels") && !n.includes(".classes"),
	);

	it("covers every committed fixture", () => {
		expect(names.map((n) => n.replace(/\.json$/, "")).sort()).toEqual(
			Object.keys(FIXTURE_RECYCLED).sort(),
		);
	});

	for (const [id, recycled] of Object.entries(FIXTURE_RECYCLED)) {
		it(`${id}: no recall failures, recycled ${recycled}`, () => {
			const f = JSON.parse(
				readFileSync(join(dir, `${id}.json`), "utf8"),
			) as ReplayFixture;
			const labels = JSON.parse(
				readFileSync(join(dir, `${fixtureId(f)}.labels.json`), "utf8"),
			) as LabelFile;
			const result = replayFixture(f, labels, todaysCodePipeline);
			expect(checkRecall(f, labels, result).failures).toEqual([]);
			expect(computeMetrics(f, labels, result).recycled.count).toBe(recycled);
		});
	}
});
