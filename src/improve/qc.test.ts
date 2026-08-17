import { describe, expect, it } from "vitest";
import { parseQcCommand } from "../commands.js";
import { parseSampleRate } from "../config.js";
import {
	formatQcComment,
	type JudgeableFinding,
	judgeSelection,
	type QcVerdict,
	selectQcSample,
	summarize,
} from "./qc.js";

function finding(over: Partial<JudgeableFinding> = {}): JudgeableFinding {
	return {
		id: 1,
		provider: "anthropic",
		path: "src/x.ts",
		line: 10,
		title: "a finding",
		severity: "high",
		body: "why",
		...over,
	};
}

function verdict(over: Partial<QcVerdict> = {}): QcVerdict {
	return {
		isFalsePositive: false,
		isUseful: true,
		severityCorrect: true,
		suggestedSeverity: null,
		rationale: "holds up",
		...over,
	};
}

describe("parseQcCommand", () => {
	it("matches the bare command", () => {
		expect(parseQcCommand("/qc", "/qc")).toEqual({ full: false });
	});

	it("accepts --full", () => {
		expect(parseQcCommand("/qc --full", "/qc")).toEqual({ full: true });
	});

	// A comment discussing /qc must not trigger a run.
	it("ignores a body that merely mentions the command", () => {
		expect(parseQcCommand("we should run /qc on this", "/qc")).toBeNull();
		expect(parseQcCommand("/qcsomething", "/qc")).toBeNull();
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseQcCommand("  /qc  ", "/qc")).toEqual({ full: false });
	});
});

describe("parseSampleRate", () => {
	it("defaults when unset", () => {
		expect(parseSampleRate(undefined)).toBe(0.1);
		expect(parseSampleRate("  ")).toBe(0.1);
	});

	// A typo must not multiply model spend across every PR.
	it("clamps out-of-range values rather than obeying them", () => {
		expect(parseSampleRate("5")).toBe(1);
		expect(parseSampleRate("-2")).toBe(0);
	});

	it("falls back on a non-numeric value", () => {
		expect(parseSampleRate("half")).toBe(0.1);
	});
});

describe("selectQcSample", () => {
	const findings = [1, 2, 3, 4].map((id) => ({ id }));

	it("judges everything at rate 1 and nothing at rate 0", () => {
		expect(selectQcSample(findings, 1, () => 0.5)).toHaveLength(4);
		expect(selectQcSample(findings, 0, () => 0)).toEqual([]);
	});

	it("is deterministic for a given rng", () => {
		const seq = () => {
			let i = 0;
			const values = [0.05, 0.9, 0.05, 0.9];
			return () => values[i++];
		};
		expect(selectQcSample(findings, 0.5, seq())).toEqual(
			selectQcSample(findings, 0.5, seq()),
		);
	});

	// Otherwise the sample depends on the order rows came back from the database.
	it("does not depend on input order", () => {
		const seq = () => {
			let i = 0;
			const values = [0.05, 0.9, 0.05, 0.9];
			return () => values[i++];
		};
		expect(selectQcSample([...findings].reverse(), 0.5, seq())).toEqual(
			selectQcSample(findings, 0.5, seq()),
		);
	});
});

describe("judgeSelection", () => {
	// A cross-provider judge measures disagreement between models, which is a
	// different question from whether the finding holds.
	it("judges each finding with its own provider", () => {
		expect(judgeSelection("openai").provider).toBe("openai");
		expect(judgeSelection("anthropic").provider).toBe("anthropic");
	});

	// The ChatGPT-account Codex backend rejects gpt-5.1 outright, and /qc's
	// judging pass is one of the two call sites watch's re-review loop exercises.
	it("judges openai findings with gpt-5.4, not the retired gpt-5.1", () => {
		expect(judgeSelection("openai").model).toBe("gpt-5.4");
	});
});

describe("summarize", () => {
	it("counts each category independently", () => {
		const report = summarize([
			{
				finding: finding({ id: 1 }),
				verdict: verdict({ isFalsePositive: true }),
			},
			{ finding: finding({ id: 2 }), verdict: verdict({ isUseful: false }) },
			{
				finding: finding({ id: 3 }),
				verdict: verdict({ severityCorrect: false }),
			},
			{ finding: finding({ id: 4 }), verdict: verdict() },
		]);
		expect(report).toMatchObject({
			judged: 4,
			falsePositives: 1,
			notUseful: 1,
			severityWrong: 1,
			unjudged: 0,
		});
	});

	// Recording an unjudged finding as a pass would quietly inflate the score.
	it("counts a failed judgement as unjudged, not as a pass", () => {
		const report = summarize([
			{ finding: finding({ id: 1 }), verdict: null },
			{ finding: finding({ id: 2 }), verdict: verdict() },
		]);
		expect(report).toMatchObject({ judged: 1, unjudged: 1, falsePositives: 0 });
	});
});

describe("formatQcComment", () => {
	it("says so plainly when there was nothing to judge", () => {
		expect(formatQcComment("qc", summarize([]))).toContain("Nothing to judge");
	});

	it("names the flagged findings rather than only a count", () => {
		const body = formatQcComment(
			"qc",
			summarize([
				{
					finding: finding({ title: "spawn error not handled" }),
					verdict: verdict({
						isFalsePositive: true,
						rationale: "handler is six lines below",
					}),
				},
			]),
		);
		expect(body).toContain("spawn error not handled");
		expect(body).toContain("handler is six lines below");
		expect(body).toContain("false positive");
	});

	it("reports unjudged findings when any could not be evaluated", () => {
		const body = formatQcComment(
			"qc",
			summarize([
				{ finding: finding(), verdict: null },
				{ finding: finding({ id: 2 }), verdict: verdict() },
			]),
		);
		expect(body).toContain("Could not be judged");
	});

	it("omits the flagged section when everything held up", () => {
		const body = formatQcComment(
			"qc",
			summarize([{ finding: finding(), verdict: verdict() }]),
		);
		expect(body).not.toContain("#### Flagged");
	});

	// It is a second model auditing the first, and the comment should not read
	// as a human verdict.
	it("states what the judgement is and is not", () => {
		const body = formatQcComment(
			"qc",
			summarize([{ finding: finding(), verdict: verdict() }]),
		);
		expect(body).toContain("not a human verdict");
	});
});

describe("formatQcComment when nothing could be judged", () => {
	// "No findings were posted" is flatly untrue during a provider outage: the
	// findings are there, the judge is not.
	it("names the findings and says it was an outage, not a verdict", () => {
		const report = summarize([
			{ finding: finding({ id: 1, title: "first" }), verdict: null },
			{ finding: finding({ id: 2, title: "second" }), verdict: null },
		]);

		const body = formatQcComment("qc", report);

		expect(body).not.toContain("no findings were posted");
		expect(body).toContain("QC outage");
		expect(body).toContain("first");
		expect(body).toContain("second");
	});

	it("still reports an empty PR as having nothing to judge", () => {
		expect(formatQcComment("qc", summarize([]))).toContain(
			"no findings were posted",
		);
	});
});
