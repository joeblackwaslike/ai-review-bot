import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPlan, planHash } from "../experiment/plan.js";
import { strategyA } from "./a.js";
import { strategyA0 } from "./a0.js";
import { strategyF0 } from "./f0.js";
import { strategyF1 } from "./f1.js";

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

	it("strategy f0 matches plan.json", () => {
		expect(strategyF0.version).toBe(pinned("f0"));
	});

	it("strategy f1 matches plan.json", () => {
		expect(strategyF1.version).toBe(pinned("f1"));
	});

	it("plan-chained.json pins the same strategy versions as plan.json", () => {
		const chained = JSON.parse(
			readFileSync(
				new URL(
					"../../../docs/review-experiments/plan-chained.json",
					import.meta.url,
				),
				"utf8",
			),
		) as { strategies: { name: string; version: string }[] };
		expect(chained.strategies).toEqual(plan.strategies);
	});

	it("plan-pilot-f1.json loads against its lock and pins the strategies' versions", () => {
		const path = new URL(
			"../../../docs/review-experiments/plan-pilot-f1.json",
			import.meta.url,
		).pathname;
		const { plan: pilot, lockedHash } = loadPlan(path);
		expect(lockedHash).toBe(planHash(pilot));
		const byName = { a: strategyA, f0: strategyF0, f1: strategyF1 } as const;
		for (const [name, strategy] of Object.entries(byName))
			expect(pilot.strategies.find((s) => s.name === name)?.version).toBe(
				strategy.version,
			);
	});
});
