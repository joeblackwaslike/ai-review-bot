import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureId } from "./claims.js";
import { checkRecall } from "./guard.js";
import { computeMetrics, formatReport } from "./metrics.js";
import { asRecordedPipeline } from "./pipeline.js";
import { replayFixture } from "./replay.js";
import type { LabelFile, ReplayFixture } from "./types.js";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const names = existsSync(dir)
	? readdirSync(dir)
			.filter(
				(n) =>
					/\.json$/.test(n) &&
					!/\.(labels(\.proposed)?|classes)\.json$/.test(n),
			)
			.sort()
	: [];

describe("committed replay fixtures", () => {
	if (names.length === 0) {
		it.skip("no fixtures in src/replay/fixtures/ yet (recorded in Task 7)", () => {});
		return;
	}

	const loaded = names.map((name) => {
		const f = JSON.parse(
			readFileSync(join(dir, name), "utf8"),
		) as ReplayFixture;
		const labels = JSON.parse(
			readFileSync(join(dir, `${fixtureId(f)}.labels.json`), "utf8"),
		) as LabelFile;
		return { f, labels, result: replayFixture(f, labels, asRecordedPipeline) };
	});

	it("parses every fixture with its labels file", () => {
		for (const { f, labels } of loaded) {
			expect(f.schemaVersion).toBe(1);
			expect(labels.fixtureId).toBe(fixtureId(f));
		}
	});

	it("as-recorded pipeline has no recall failures", () => {
		for (const { f, labels, result } of loaded) {
			expect(checkRecall(f, labels, result).failures).toEqual([]);
		}
	});

	it("report matches the committed snapshot", () => {
		const report = formatReport(
			loaded.map((l) => computeMetrics(l.f, l.labels, l.result)),
			loaded.map((l) => fixtureId(l.f)),
		);
		expect(report).toMatchSnapshot();
	});
});
