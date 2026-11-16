import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentDeadline, VERCEL_FUNCTION_LIMIT_MS } from "./review-deadline.js";

const agentStartMs = 1_000_000;
const agentBudgetMs = 210_000;

describe("agentDeadline", () => {
	it("returns agent start plus budget when no request start is known", () => {
		expect(agentDeadline({ agentStartMs, agentBudgetMs })).toBe(1_210_000);
	});

	it("keeps the full budget when setup is fast", () => {
		expect(
			agentDeadline({
				agentStartMs,
				agentBudgetMs,
				requestStartedAtMs: agentStartMs - 20_000,
			}),
		).toBe(1_210_000);
	});

	it("shrinks the budget by setup time that eats into the function limit", () => {
		expect(
			agentDeadline({
				agentStartMs,
				agentBudgetMs,
				requestStartedAtMs: agentStartMs - 100_000,
			}),
		).toBe(agentStartMs + 140_000);
	});

	it("returns a deadline in the past when setup used more than the limit minus reserve", () => {
		expect(
			agentDeadline({
				agentStartMs,
				agentBudgetMs,
				requestStartedAtMs: agentStartMs - 250_000,
			}),
		).toBeLessThan(agentStartMs);
	});

	it("ignores a request start in the future", () => {
		expect(
			agentDeadline({
				agentStartMs,
				agentBudgetMs,
				requestStartedAtMs: agentStartMs + 100_000,
			}),
		).toBe(1_210_000);
	});

	it("matches maxDuration for api/github in vercel.json", () => {
		const config = JSON.parse(readFileSync("vercel.json", "utf8"));
		expect(config.functions["api/github/**/*.ts"].maxDuration * 1000).toBe(
			VERCEL_FUNCTION_LIMIT_MS,
		);
	});
});
