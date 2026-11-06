import { describe, expect, it, vi } from "vitest";
import {
	applyLimits,
	limitNotice,
	resolveLimits,
	supportCounts,
} from "./adaptive-limits.js";
import type { LedgerEntry } from "./ledger/types.js";
import type { Sev } from "./trajectory.js";
import * as trajectory from "./trajectory.js";

vi.mock("./trajectory.js", async (orig) => {
	const actual = await orig<typeof import("./trajectory.js")>();
	return { ...actual, limitsForScore: vi.fn(actual.limitsForScore) };
});

interface F {
	id: string;
	severity: Sev;
	confidence: number;
	advisory?: true;
}

const f = (id: string, severity: Sev, confidence = 0.5): F => ({
	id,
	severity,
	confidence,
});

const adv = (id: string, severity: Sev, confidence = 0.5): F => ({
	...f(id, severity, confidence),
	advisory: true,
});

const review = (event: string, general: F[], inline: F[] = []) => ({
	event,
	general_findings: general,
	inline_comments: inline,
});

const noSupport = () => 0;

describe("applyLimits", () => {
	it("never removes P0 or P1", () => {
		const r = review("COMMENT", [f("a", "P0"), f("b", "P1"), f("c", "P1")]);
		const out = applyLimits(r, { floor: "P2", budget: 1 }, noSupport, false);
		expect(out.removed).toEqual([]);
		expect(out.review.general_findings).toHaveLength(3);
	});

	it("floor P2 removes P3 and keeps P2", () => {
		const r = review("COMMENT", [f("a", "P2"), f("b", "P3")]);
		const out = applyLimits(r, { floor: "P2", budget: null }, noSupport, false);
		expect(out.review.general_findings.map((x) => x.id)).toEqual(["a"]);
		expect(out.removed.map((x) => x.id)).toEqual(["b"]);
	});

	it("budget 3 keeps both P1 and the best P2 by confidence, then support, then position", () => {
		const r = review(
			"COMMENT",
			[f("p1a", "P1"), f("p2a", "P2", 0.5), f("p2b", "P2", 0.9)],
			[f("p1b", "P1"), f("p2c", "P2", 0.9), f("p2d", "P2", 0.1)],
		);
		const support = (x: F) => (x.id === "p2c" ? 5 : 0);
		const out = applyLimits(r, { floor: null, budget: 3 }, support, false);
		const kept = [
			...out.review.general_findings,
			...out.review.inline_comments,
		].map((x) => x.id);
		expect(kept.sort()).toEqual(["p1a", "p1b", "p2c"]);
		expect(out.removed).toHaveLength(3);
	});

	it("breaks full ties by original position, general before inline", () => {
		const r = review("COMMENT", [f("g", "P2")], [f("i", "P2")]);
		const out = applyLimits(r, { floor: null, budget: 1 }, noSupport, false);
		expect(out.review.general_findings.map((x) => x.id)).toEqual(["g"]);
		expect(out.review.inline_comments).toEqual([]);
	});

	it("changes nothing with no limits", () => {
		const r = review("REQUEST_CHANGES", [f("a", "P3")], [f("b", "P2")]);
		const out = applyLimits(r, { floor: null, budget: null }, noSupport, false);
		expect(out.removed).toEqual([]);
		expect(out.review).toEqual(r);
	});

	it("downgrades REQUEST_CHANGES to COMMENT when everything is removed and nothing is carried", () => {
		const r = review("REQUEST_CHANGES", [f("a", "P3")]);
		const out = applyLimits(r, { floor: "P2", budget: null }, noSupport, false);
		expect(out.review.event).toBe("COMMENT");
	});

	it("keeps REQUEST_CHANGES when carried findings block", () => {
		const r = review("REQUEST_CHANGES", [f("a", "P3")]);
		const out = applyLimits(r, { floor: "P2", budget: null }, noSupport, true);
		expect(out.review.event).toBe("REQUEST_CHANGES");
	});

	it("keeps REQUEST_CHANGES when a finding remains", () => {
		const r = review("REQUEST_CHANGES", [f("a", "P3"), f("b", "P1")]);
		const out = applyLimits(r, { floor: "P2", budget: null }, noSupport, false);
		expect(out.review.event).toBe("REQUEST_CHANGES");
	});

	it("never changes COMMENT", () => {
		const r = review("COMMENT", [f("a", "P3")]);
		const out = applyLimits(r, { floor: "P2", budget: null }, noSupport, false);
		expect(out.review.event).toBe("COMMENT");
	});

	it("does not mutate its input", () => {
		const r = review("REQUEST_CHANGES", [f("a", "P3")], [f("b", "P3")]);
		const copy = structuredClone(r);
		applyLimits(r, { floor: "P2", budget: 1 }, noSupport, false);
		expect(r).toEqual(copy);
	});

	it("budget 0 and a negative budget remove every P2/P3 and keep P0/P1", () => {
		for (const budget of [0, -3]) {
			const r = review(
				"COMMENT",
				[f("a", "P0"), f("b", "P2"), f("c", "P3")],
				[f("d", "P1"), f("e", "P2")],
			);
			const out = applyLimits(r, { floor: null, budget }, noSupport, false);
			expect(out.review.general_findings.map((x) => x.id)).toEqual(["a"]);
			expect(out.review.inline_comments.map((x) => x.id)).toEqual(["d"]);
			expect(out.removed).toHaveLength(3);
		}
	});

	it("P1 count toward the budget, leaving no room for P2", () => {
		const r = review("COMMENT", [f("a", "P1"), f("b", "P1"), f("c", "P2")]);
		const out = applyLimits(r, { floor: null, budget: 2 }, noSupport, false);
		expect(out.review.general_findings.map((x) => x.id)).toEqual(["a", "b"]);
	});

	it("ranks by confidence alone when severity and support are equal", () => {
		const r = review("COMMENT", [
			f("low", "P2", 0.2),
			f("high", "P2", 0.9),
			f("mid", "P2", 0.5),
		]);
		const out = applyLimits(r, { floor: null, budget: 2 }, noSupport, false);
		expect(out.review.general_findings.map((x) => x.id)).toEqual([
			"high",
			"mid",
		]);
	});

	it("breaks ties by earlier position, general before inline", () => {
		const r = review(
			"COMMENT",
			[f("g1", "P2"), f("g2", "P2")],
			[f("i1", "P2")],
		);
		const out = applyLimits(r, { floor: null, budget: 2 }, noSupport, false);
		expect(out.review.general_findings.map((x) => x.id)).toEqual(["g1", "g2"]);
		expect(out.review.inline_comments).toEqual([]);
	});

	it("keeps kept findings in their input order", () => {
		const r = review("COMMENT", [
			f("a", "P3"),
			f("b", "P1"),
			f("c", "P2", 0.9),
			f("d", "P2", 0.1),
		]);
		const out = applyLimits(r, { floor: null, budget: 2 }, noSupport, false);
		expect(out.review.general_findings.map((x) => x.id)).toEqual(["b", "c"]);
	});

	it("returns kept findings in input order, not rank order", () => {
		const r = review("COMMENT", [f("c", "P2", 0.9), f("b", "P1")]);
		const out = applyLimits(r, { floor: null, budget: 2 }, noSupport, false);
		expect(out.review.general_findings.map((x) => x.id)).toEqual(["c", "b"]);
	});

	it("downgrades REQUEST_CHANGES when only an advisory finding is kept", () => {
		const r = review("REQUEST_CHANGES", [
			adv("note", "P2", 0.9),
			f("nit", "P3"),
		]);
		const out = applyLimits(r, { floor: "P2", budget: null }, noSupport, false);
		expect(out.review.general_findings.map((x) => x.id)).toEqual(["note"]);
		expect(out.review.event).toBe("COMMENT");
	});

	it("keeps REQUEST_CHANGES when a non-advisory finding is kept beside an advisory one", () => {
		const r = review("REQUEST_CHANGES", [
			adv("note", "P2"),
			f("nit", "P2", 0.9),
		]);
		const out = applyLimits(r, { floor: "P2", budget: null }, noSupport, false);
		expect(out.review.event).toBe("REQUEST_CHANGES");
	});

	it("keeps REQUEST_CHANGES with only advisory kept when carried findings block", () => {
		const r = review("REQUEST_CHANGES", [adv("note", "P2"), f("nit", "P3")]);
		const out = applyLimits(r, { floor: "P2", budget: null }, noSupport, true);
		expect(out.review.event).toBe("REQUEST_CHANGES");
	});

	it("ranks advisory below non-advisory at the same severity", () => {
		const r = review("COMMENT", [adv("note", "P2", 0.9), f("real", "P2", 0.1)]);
		const out = applyLimits(r, { floor: null, budget: 1 }, noSupport, false);
		expect(out.review.general_findings.map((x) => x.id)).toEqual(["real"]);
	});

	it("leaves REQUEST_CHANGES alone when there were no findings to remove", () => {
		const r = review("REQUEST_CHANGES", []);
		const out = applyLimits(r, { floor: "P2", budget: 1 }, noSupport, false);
		expect(out.review.event).toBe("REQUEST_CHANGES");
	});

	it("infers extra finding fields without casts", () => {
		const r = {
			event: "COMMENT",
			general_findings: [
				{ id: "abc", severity: "P3" as Sev, confidence: 0.5, title: "t" },
			],
			inline_comments: [
				{
					id: "de",
					severity: "P3" as Sev,
					confidence: 0.5,
					path: "a.ts",
					line: 1,
				},
			],
		};
		const out = applyLimits(
			r,
			{ floor: "P2", budget: null },
			(x) => x.id.length,
			false,
		);
		const id: string = out.removed[0].id;
		expect(id).toBe("abc");
	});
});

const entry = (id: string, round: number, status: LedgerEntry["status"]) =>
	({
		id,
		round,
		path: "a.ts",
		line: 1,
		severity: "P2",
		title: id,
		status,
		decidedBy: status === "fixed" ? "author" : "reviewer",
		reason: null,
		evidence: [],
	}) as LedgerEntry;

describe("resolveLimits", () => {
	const entries = [entry("x", 0, "rejected"), entry("y", 0, "fixed")];
	const docsDelta = [
		{
			filename: "README.md",
			status: "modified",
			patch:
				"@@ -1,1 +1,16 @@\n+a\n+b\n+c\n+d\n+e\n+f\n+g\n+h\n+i\n+j\n+k\n+l\n+m\n+n\n+o",
			additions: 15,
			deletions: 0,
		},
	];

	it("skips the push shape for a non-incremental review", () => {
		const out = resolveLimits({
			entries,
			reactionsFor: () => [],
			currentRound: 1,
			delta: null,
		});
		expect(out.budget).toBe(10);
		expect(out.shape).toBeNull();
		expect(out.score).toBe(0.5);
	});

	it("shapes the budget by the push", () => {
		const out = resolveLimits({
			entries,
			reactionsFor: () => [],
			currentRound: 1,
			delta: docsDelta,
		});
		expect(out.budget).toBe(2);
		expect(out.shape).not.toBeNull();
	});

	it("returns no limits for a null score whatever the delta", () => {
		const out = resolveLimits({
			entries: [],
			reactionsFor: () => [],
			currentRound: 1,
			delta: docsDelta,
		});
		expect(out.floor).toBeNull();
		expect(out.budget).toBeNull();
		expect(out.score).toBeNull();
	});

	it("keeps a floor when the band has no budget", () => {
		vi.mocked(trajectory.limitsForScore).mockReturnValueOnce({
			floor: "P2",
			budget: null,
		});
		const out = resolveLimits({
			entries,
			reactionsFor: () => [],
			currentRound: 1,
			delta: docsDelta,
		});
		expect(out.floor).toBe("P2");
		expect(out.budget).toBeNull();
		expect(out.shape).toBeNull();
	});
});

describe("limitNotice", () => {
	const base = { score: 0.9, rounds: [], shape: null };

	it("is null when nothing was removed", () => {
		expect(limitNotice({ ...base, floor: "P2", budget: 5 }, 0)).toBeNull();
	});

	it("names the budget and floor", () => {
		expect(limitNotice({ ...base, floor: "P2", budget: 5 }, 3)).toBe(
			"Held back 3 findings below P2 or over the budget of 5 this round, because earlier rounds drew a high share of declined findings.",
		);
	});

	it("names only the budget", () => {
		expect(limitNotice({ ...base, floor: null, budget: 10 }, 1)).toBe(
			"Held back 1 finding over the budget of 10 this round, because earlier rounds drew a high share of declined findings.",
		);
	});

	it("names only the floor", () => {
		expect(limitNotice({ ...base, floor: "P2", budget: null }, 1)).toBe(
			"Held back 1 finding below P2 this round, because earlier rounds drew a high share of declined findings.",
		);
	});

	it("carries no bullet or marker", () => {
		const n = limitNotice({ ...base, floor: "P2", budget: 5 }, 2) ?? "";
		expect(n).not.toContain("> - ");
		expect(n).not.toContain("ai-review:");
	});
});

describe("supportCounts", () => {
	const key = (c: { k: string }) => c.k;

	it("counts each agent once per survivor, through the aliases", () => {
		const s = supportCounts({
			inlineByAgent: [[{ k: "a" }, { k: "a2" }], [{ k: "a2" }], [{ k: "b" }]],
			generalByAgent: [],
			inlineKey: key,
			aliases: new Map([["a2", "a"]]),
		});
		expect(s.inline({ k: "a" })).toBe(2);
		expect(s.inline({ k: "b" })).toBe(1);
		expect(s.inline({ k: "unknown" })).toBe(1);
	});

	it("counts general findings by case-insensitive title and floors at 1", () => {
		const s = supportCounts({
			inlineByAgent: [],
			generalByAgent: [[{ title: "Leak" }], [{ title: "leak" }], []],
			inlineKey: key,
			aliases: new Map(),
		});
		expect(s.general("LEAK")).toBe(2);
		expect(s.general("other")).toBe(1);
	});
});
