import { describe, expect, it } from "vitest";
import { toLiveFindings, toLiveReviewOutput } from "./live-wiring.js";

describe("toLiveFindings", () => {
	const finding = {
		category: "style" as const,
		confidence: 0.8,
		evidence: "See diff.",
		suppressible: true,
	};

	it("carries body, severity and suppressible from inline and general findings", () => {
		const out = toLiveFindings({
			event: "COMMENT",
			inline_comments: [
				{
					...finding,
					title: "Inline",
					body: "inline body",
					severity: "P2",
					path: "src/a.ts",
					line: 7,
					start_line: null,
					suggestion: null,
				},
			],
			general_findings: [
				{
					...finding,
					title: "General",
					body: "general body",
					severity: "P0",
					suppressible: false,
				},
			],
		});
		expect(out).toEqual([
			{
				title: "Inline",
				path: "src/a.ts",
				line: 7,
				body: "inline body",
				severity: "P2",
				suppressible: true,
			},
			{
				title: "General",
				path: null,
				line: null,
				body: "general body",
				severity: "P0",
				suppressible: false,
			},
		]);
	});
});

describe("toLiveReviewOutput", () => {
	const base = {
		category: "style" as const,
		confidence: 0.8,
		evidence: "See diff.",
		suppressible: true,
	};
	const review = (inline: string[], general: string[]) => ({
		event: "COMMENT" as const,
		inline_comments: inline.map((title, i) => ({
			...base,
			title,
			body: "b",
			severity: "P2" as const,
			path: "src/a.ts",
			line: i + 1,
			start_line: null,
			suggestion: null,
		})),
		general_findings: general.map((title) => ({
			...base,
			title,
			body: "b",
			severity: "P3" as const,
		})),
	});

	it("tags candidates with each agent's skill, one per inline and general finding, in agent order", () => {
		const usageBySkill = {
			"code-reviewer": { promptTokens: 3, completionTokens: 1 },
		};
		const out = toLiveReviewOutput({
			review: review(["A"], []),
			agentReviews: [
				{ skill: "code-reviewer", review: review(["A", "B"], ["G"]) },
				{ skill: "security-sast", review: review([], ["H"]) },
			],
			usageBySkill,
		});
		expect(out.candidates).toEqual([
			{
				skill: "code-reviewer",
				title: "A",
				path: "src/a.ts",
				line: 1,
				severity: "P2",
			},
			{
				skill: "code-reviewer",
				title: "B",
				path: "src/a.ts",
				line: 2,
				severity: "P2",
			},
			{
				skill: "code-reviewer",
				title: "G",
				path: null,
				line: null,
				severity: "P3",
			},
			{
				skill: "security-sast",
				title: "H",
				path: null,
				line: null,
				severity: "P3",
			},
		]);
		expect(out.findings.map((f) => f.title)).toEqual(["A"]);
		expect(out.usage).toBe(usageBySkill);
	});
});
