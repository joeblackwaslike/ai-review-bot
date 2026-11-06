import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	exploratoryReason,
	FinalAlreadyScoredError,
	readableFixtureIds,
	writeFinalMarker,
} from "./final-guard.js";
import { samplePlan } from "./testkit.js";

const root = () => mkdtempSync(join(tmpdir(), "final-"));
const now = () => new Date("2026-11-06T00:00:00Z");

describe("writeFinalMarker", () => {
	it("writes once per plan hash and refuses a second final", () => {
		const dir = root();
		writeFinalMarker(dir, "h1", ["o/r#2"], now);
		expect(() => writeFinalMarker(dir, "h1", ["o/r#2"], now)).toThrow(
			FinalAlreadyScoredError,
		);
		expect(() => writeFinalMarker(dir, "h2", ["o/r#9"], now)).not.toThrow();
	});
});

describe("exploratoryReason", () => {
	it("is null with no scored plan", () => {
		expect(exploratoryReason(root(), "h2", ["o/r#2"])).toBeNull();
	});

	it("labels a revised plan that shares test PRs with a scored plan", () => {
		const dir = root();
		writeFinalMarker(dir, "h1", ["o/r#2", "o/r#3@openai"], now);
		const reason = exploratoryReason(dir, "h2", ["o/r#3@anthropic", "o/r#8"]);
		expect(reason).toMatch(/exploratory/);
		expect(reason).toMatch(/h1/);
	});

	it("is null when test PRs are disjoint, and ignores its own marker", () => {
		const dir = root();
		writeFinalMarker(dir, "h1", ["o/r#2"], now);
		expect(exploratoryReason(dir, "h2", ["o/r#7"])).toBeNull();
		expect(exploratoryReason(dir, "h1", ["o/r#2"])).toBeNull();
	});
});

describe("readableFixtureIds", () => {
	const plan = {
		...samplePlan(),
		fixtures: [
			{ id: "o/r#1", split: "tuning" as const, provider: "anthropic" as const },
			{
				id: "o/r#2",
				split: "validation" as const,
				provider: "anthropic" as const,
			},
			{ id: "o/r#3", split: "test" as const, provider: "anthropic" as const },
		],
	};

	it("never includes test fixtures outside --final", () => {
		expect([...readableFixtureIds(plan, false)].sort()).toEqual([
			"o/r#1",
			"o/r#2",
		]);
	});

	it("is the test split alone under --final", () => {
		expect([...readableFixtureIds(plan, true)]).toEqual(["o/r#3"]);
	});
});
