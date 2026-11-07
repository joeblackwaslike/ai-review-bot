import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { strategyA } from "./a.js";
import { strategyA0 } from "./a0.js";

describe("strategy versions pinned by the committed plan", () => {
	const plan = JSON.parse(
		readFileSync(
			new URL("../../../docs/review-experiments/plan.json", import.meta.url),
			"utf8",
		),
	) as { strategies: { name: string; version: string }[] };
	const pinned = (name: string) =>
		plan.strategies.find((s) => s.name === name)?.version;

	it("strategy a matches plan.json", () => {
		expect(strategyA.version).toBe(pinned("a"));
	});

	it("strategy a0 matches plan.json", () => {
		expect(strategyA0.version).toBe(pinned("a0"));
	});
});
