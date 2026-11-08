import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { computeCost } from "../../models.js";
import { REVIEWER_TUNING } from "../../reviewer-tuning.js";
import {
	buildInlineComment,
	buildModelReview,
	buildPullFile,
	SIMPLE_PATCH,
} from "../../testing.js";
import { freezeFixture } from "../frozen.js";
import { toCandidates } from "../live-wiring.js";
import { runStrategy } from "../run-strategy.js";
import type { StrategyInput } from "../strategy.js";
import { ledgerForRound, postFilterTrace } from "../trace.js";
import type {
	CandidateRecord,
	LabelFile,
	ReplayFixture,
	Round,
} from "../types.js";
import { strategyA, strategyVersion } from "./a.js";

const mockRunAuditPass = vi.hoisted(() => vi.fn());
vi.mock("../../audit.js", () => ({ runAuditPass: mockRunAuditPass }));
vi.mock("../../auth.js", () => ({
	resolveAnthropicAuth: vi.fn(async () => ({})),
	resolveOpenAIAuth: vi.fn(async () => ({})),
}));

const FIXTURE_DIR = new URL("../fixtures/", import.meta.url);
const readJson = <T>(name: string): T =>
	JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8")) as T;

const fixture = readJson<ReplayFixture>(
	"joeblackwaslike__ai-listings__50__anthropic.json",
);
const labels = readJson<LabelFile>(
	"joeblackwaslike__ai-listings__50__anthropic.labels.json",
);
const round = fixture.rounds[1] as Round;
const files = [buildPullFile("src/a.ts", SIMPLE_PATCH)];

const inputFor = (): StrategyInput => ({
	fixture: freezeFixture(fixture, round.index),
	round,
	diff: "x".repeat(4000),
	files,
	approximateDiff: false,
	checkout: null,
	history: { ledger: ledgerForRound(fixture, labels, round) },
	budget: { maxUsd: 100, maxWallMs: 600_000 },
	signal: new AbortController().signal,
});

describe("strategyA", () => {
	it("is named a, needs no checkout, and has a stable version", () => {
		expect(strategyA.name).toBe("a");
		expect(strategyA.needsCheckout).toBe(false);
		expect(strategyA.version).toMatch(/^[0-9a-f]{12}$/);
	});

	it("changes version when a skill file's contents change and is stable otherwise", () => {
		const read = (text: string) => (name: string) => `${name}:${text}`;
		const v1 = strategyVersion(read("one"));
		expect(strategyVersion(read("one"))).toBe(v1);
		expect(strategyVersion(read("two"))).not.toBe(v1);
		expect(v1).toMatch(/^[0-9a-f]{12}$/);
	});

	it("returns the candidates and the post-filter trace of the audit pass", async () => {
		const agentReviews = [
			{
				skill: "code-reviewer",
				review: buildModelReview({
					inline_comments: [
						buildInlineComment({
							title: "Off by one",
							path: "src/a.ts",
							line: 2,
						}),
					],
				}),
			},
		];
		mockRunAuditPass.mockResolvedValue({
			review: agentReviews[0]?.review,
			agentReviews,
			usageBySkill: {
				"code-reviewer": { promptTokens: 3, completionTokens: 4 },
			},
			agentsAttempted: 1,
			agentsSucceeded: 1,
		});
		const input = inputFor();

		const out = await runStrategy(strategyA, input);

		expect(out.candidates).toEqual(toCandidates(agentReviews));
		expect(out.posted).toEqual(
			postFilterTrace({
				agentReviews,
				ledger: input.history.ledger,
				files,
				tuning: REVIEWER_TUNING,
			}).posted,
		);
		expect(out.usage).toEqual({
			"code-reviewer.md": { promptTokens: 3, completionTokens: 4 },
		});
		expect(out.toolCalls).toEqual([]);
		expect(out.wallMs).toBeGreaterThanOrEqual(0);
	});

	it("throws when every attempted agent failed", async () => {
		mockRunAuditPass.mockResolvedValue({
			review: buildModelReview(),
			agentReviews: [],
			usageBySkill: {},
			agentsAttempted: 5,
			agentsSucceeded: 0,
		});
		await expect(strategyA.run(inputFor())).rejects.toThrow(
			new Error("all 5 review agents failed"),
		);
	});

	it("estimates with the old formula for the routed model", () => {
		const input = inputFor();
		expect(strategyA.estimateCost(input)).toBe(
			computeCost(
				{ promptTokens: (4000 / 4) * 5, completionTokens: 2000 * 5 },
				"claude-sonnet-5-5",
			),
		);
	});

	it("routes and prices with asReviewer instead of the fixture's reviewer", async () => {
		const input = { ...inputFor(), asReviewer: "codex" };
		expect(strategyA.estimateCost(input)).toBe(
			computeCost(
				{ promptTokens: (4000 / 4) * 5, completionTokens: 2000 * 5 },
				"gpt-6.1-sol",
			),
		);
		mockRunAuditPass.mockResolvedValueOnce({
			review: buildModelReview({ inline_comments: [], general_findings: [] }),
			usage: { promptTokens: 0, completionTokens: 0 },
			agentsSucceeded: 1,
			agentsAttempted: 1,
			agentReviews: [],
			usageBySkill: {},
		});
		await strategyA.run(input);
		expect(mockRunAuditPass.mock.lastCall?.[0].selection.model).toBe(
			"gpt-6.1-sol",
		);
	});

	it("maps saved trace candidates back to themselves", async () => {
		const saved = (round.trace?.candidates ?? []) as CandidateRecord[];
		expect(saved.length).toBeGreaterThan(0);
		const bySkill = new Map<string, CandidateRecord[]>();
		for (const c of saved) {
			const skill = c.skill ?? "";
			bySkill.set(skill, [...(bySkill.get(skill) ?? []), c]);
		}
		const agentReviews = [...bySkill].map(([skill, cs]) => ({
			skill: skill.replace(/\.md$/, ""),
			review: buildModelReview({
				inline_comments: cs
					.filter((c) => c.path !== null)
					.map((c) =>
						buildInlineComment({
							title: c.title,
							path: c.path as string,
							line: c.line as number,
							severity: c.severity as "P0",
						}),
					),
				general_findings: cs
					.filter((c) => c.path === null)
					.map((c) => ({
						title: c.title,
						body: "b",
						severity: c.severity as "P0",
						category: "style" as const,
						confidence: 0.8,
						evidence: "e",
						suppressible: true,
					})),
			}),
		}));
		mockRunAuditPass.mockResolvedValue({
			review: buildModelReview(),
			agentReviews,
			usageBySkill: {},
			agentsAttempted: agentReviews.length,
			agentsSucceeded: agentReviews.length,
		});

		const out = await strategyA.run(inputFor());

		expect(out.candidates).toEqual(saved);
	});
});
