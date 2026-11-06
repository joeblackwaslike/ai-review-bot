import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultFixturesDir } from "./command.js";
import { makeFixture } from "./testkit.js";
import { fixtureReviewer, type ReplayFixture } from "./types.js";

const dir = defaultFixturesDir(import.meta.url);
const FIXTURE_FILE = /^(?!.*\.(labels(\.proposed)?|classes)\.json$).+\.json$/;

describe("fixtureReviewer", () => {
	it("maps every recorded fixture's legacy provider to its reviewer", () => {
		const names = readdirSync(dir).filter((n) => FIXTURE_FILE.test(n));
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			const f = JSON.parse(
				readFileSync(join(dir, name), "utf8"),
			) as ReplayFixture;
			expect(fixtureReviewer(f)).toBe(
				{ anthropic: "claude", openai: "codex" }[f.provider],
			);
		}
	});

	it("loads a fixture holding a reviewer id", () => {
		const f = {
			...makeFixture([["a"]]),
			reviewer: "gemini",
			provider: "gemini",
		};
		expect(fixtureReviewer(f)).toBe("gemini");
	});

	it("loads a fixture whose provider is a reviewer id without a reviewer field", () => {
		expect(
			fixtureReviewer({ ...makeFixture([["a"]]), provider: "claude" }),
		).toBe("claude");
	});

	it("prefers the reviewer field over the provider", () => {
		expect(
			fixtureReviewer({
				...makeFixture([["a"]]),
				provider: "anthropic",
				reviewer: "claude",
			}),
		).toBe("claude");
	});
});
