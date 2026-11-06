import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AdjCandidate, adjudicate } from "./adjudicate.js";
import { VerdictCache } from "./cache.js";
import type { Judge, JudgeOutput } from "./judge.js";
import { claimKey } from "./snapshot.js";

const real: JudgeOutput = { verdict: "real", scope: "change", reason: "r" };
const notReal: JudgeOutput = { verdict: "not-real", scope: null, reason: "n" };
const unclear: JudgeOutput = { verdict: "unclear", scope: null, reason: "u" };

const stub = (out: JudgeOutput | Error) =>
	vi.fn<Judge>(async () => {
		if (out instanceof Error) throw out;
		return out;
	});

const cand = (title: string, path = "a.ts", line = 1): AdjCandidate => ({
	path,
	line,
	title,
});

const setup = () => ({
	snapshot: "snap",
	cache: new VerdictCache(mkdtempSync(join(tmpdir(), "adj-"))),
	evidence: async () => "diff",
});

const judges = (
	first: Judge,
	second: Judge | null,
): Parameters<typeof adjudicate>[0]["judges"] => ({
	first: { family: "anthropic", model: "m1", run: first },
	second: second ? { family: "openai", model: "m2", run: second } : null,
});

describe("adjudicate", () => {
	it("judges one claim once when two candidates share a key", async () => {
		const first = stub(notReal);
		const result = await adjudicate({
			...setup(),
			candidates: [
				cand("Retry delay skipped", "a.ts", 1),
				cand("skipped retry delay", "a.ts", 9),
			],
			producer: "anthropic",
			judges: judges(first, null),
			caps: { anthropic: 10, openai: 0 },
		});
		expect(first).toHaveBeenCalledTimes(1);
		expect(result.verdicts.size).toBe(1);
		expect(result.counts.notReal).toBe(1);
		expect(result.spend.anthropic).toBe(1);
	});

	it("makes no call for a cache hit", async () => {
		const base = setup();
		const c = cand("Retry delay skipped");
		const run = (first: Judge) =>
			adjudicate({
				...base,
				candidates: [c],
				producer: "anthropic",
				judges: judges(first, null),
				caps: { anthropic: 10, openai: 0 },
			});
		await run(stub(notReal));
		const again = stub(notReal);
		const result = await run(again);
		expect(again).not.toHaveBeenCalled();
		expect(result.counts.cached).toBe(1);
		expect(result.spend).toEqual({ anthropic: 0, openai: 0 });
		expect(result.verdicts.get(claimKey(c))?.verdict).toBe("not-real");
	});

	it("marks single-family and calls no OpenAI when the OpenAI cap is 0", async () => {
		const second = stub(real);
		const result = await adjudicate({
			...setup(),
			candidates: [cand("Retry delay skipped")],
			producer: "anthropic",
			judges: judges(stub(real), second),
			caps: { anthropic: 10, openai: 0 },
		});
		expect(second).not.toHaveBeenCalled();
		expect(result.counts.singleFamily).toBe(1);
		expect([...result.verdicts.values()][0]?.status).toBe("single-family");
		expect(result.spend.openai).toBe(0);
	});

	it("agrees when the second judge confirms", async () => {
		const result = await adjudicate({
			...setup(),
			candidates: [cand("Retry delay skipped")],
			producer: "anthropic",
			judges: judges(stub(real), stub(real)),
			caps: { anthropic: 10, openai: 5 },
		});
		expect([...result.verdicts.values()][0]?.status).toBe("agreed");
		expect(result.counts.real).toBe(1);
		expect(result.spend).toEqual({ anthropic: 1, openai: 1 });
	});

	it("reports unresolved when the judges disagree", async () => {
		const result = await adjudicate({
			...setup(),
			candidates: [cand("Retry delay skipped")],
			producer: "anthropic",
			judges: judges(stub(real), stub(notReal)),
			caps: { anthropic: 10, openai: 5 },
		});
		expect([...result.verdicts.values()][0]?.status).toBe("unresolved");
		expect(result.counts.unresolved).toBe(1);
		expect(result.counts.real).toBe(0);
	});

	it("skips the second judge when the first says not-real", async () => {
		const second = stub(real);
		await adjudicate({
			...setup(),
			candidates: [cand("Retry delay skipped")],
			producer: "anthropic",
			judges: judges(stub(notReal), second),
			caps: { anthropic: 10, openai: 5 },
		});
		expect(second).not.toHaveBeenCalled();
	});

	it("cross-checks an unclear first verdict", async () => {
		const second = stub(unclear);
		const result = await adjudicate({
			...setup(),
			candidates: [cand("Retry delay skipped")],
			producer: "anthropic",
			judges: judges(stub(unclear), second),
			caps: { anthropic: 10, openai: 5 },
		});
		expect(second).toHaveBeenCalledTimes(1);
		expect(result.counts.unclear).toBe(1);
	});

	it("defers candidates once the Anthropic cap is reached", async () => {
		const first = stub(notReal);
		const result = await adjudicate({
			...setup(),
			candidates: [
				cand("Alpha problem here", "a.ts"),
				cand("Bravo issue there", "b.ts"),
				cand("Charlie bug elsewhere", "c.ts"),
			],
			producer: "anthropic",
			judges: judges(first, null),
			caps: { anthropic: 2, openai: 0 },
		});
		expect(first).toHaveBeenCalledTimes(2);
		expect(result.counts.deferred).toBe(1);
		expect(result.verdicts.size).toBe(2);
	});

	it("never uses a second judge for an openai-produced candidate", async () => {
		const second = stub(real);
		const result = await adjudicate({
			...setup(),
			candidates: [cand("Retry delay skipped")],
			producer: "openai",
			judges: judges(stub(real), second),
			caps: { anthropic: 10, openai: 5 },
		});
		expect(second).not.toHaveBeenCalled();
		expect(result.spend.openai).toBe(0);
		expect([...result.verdicts.values()][0]?.status).toBe("single-family");
	});

	it("records a judge error as unclear and does not cache it", async () => {
		const base = setup();
		const result = await adjudicate({
			...base,
			candidates: [cand("Retry delay skipped")],
			producer: "anthropic",
			judges: judges(stub(new Error("boom")), null),
			caps: { anthropic: 10, openai: 0 },
		});
		const record = [...result.verdicts.values()][0];
		expect(record?.verdict).toBe("unclear");
		expect(record?.reason).toMatch(/^judge error:/);
		expect(
			base.cache.get("snap", claimKey(cand("Retry delay skipped"))),
		).toBeUndefined();
	});

	it("upgrades a cached single-family verdict once the OpenAI cap allows it", async () => {
		const base = setup();
		const c = cand("Retry delay skipped");
		const key = claimKey(c);
		const run = (first: Judge, second: Judge, openai: number) =>
			adjudicate({
				...base,
				candidates: [c],
				producer: "anthropic",
				judges: judges(first, second),
				caps: { anthropic: 10, openai },
			});
		await run(stub(real), stub(real), 0);
		expect(base.cache.get("snap", key)?.status).toBe("single-family");

		const first = stub(real);
		const second = stub(real);
		const result = await run(first, second, 5);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
		expect(result.spend).toEqual({ anthropic: 0, openai: 1 });
		expect(result.verdicts.get(key)?.status).toBe("agreed");
		expect(base.cache.get("snap", key)?.status).toBe("agreed");
		expect(result.counts.singleFamily).toBe(0);
	});

	it("leaves a cached single-family verdict alone while the OpenAI cap is 0", async () => {
		const base = setup();
		const c = cand("Retry delay skipped");
		const run = (second: Judge) =>
			adjudicate({
				...base,
				candidates: [c],
				producer: "anthropic",
				judges: judges(stub(real), second),
				caps: { anthropic: 10, openai: 0 },
			});
		await run(stub(real));
		const second = stub(real);
		const result = await run(second);
		expect(second).not.toHaveBeenCalled();
		expect(result.counts.cached).toBe(1);
	});

	it("does not upgrade a cached not-real verdict", async () => {
		const base = setup();
		const c = cand("Retry delay skipped");
		const run = (second: Judge, openai: number) =>
			adjudicate({
				...base,
				candidates: [c],
				producer: "anthropic",
				judges: judges(stub(notReal), second),
				caps: { anthropic: 10, openai },
			});
		await run(stub(real), 0);
		const second = stub(real);
		await run(second, 5);
		expect(second).not.toHaveBeenCalled();
	});
});
