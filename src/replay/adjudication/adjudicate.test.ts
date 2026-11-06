import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AdjCandidate, adjudicate } from "./adjudicate.js";
import { VerdictCache } from "./cache.js";
import { type Judge, type JudgeOutput, PROMPT_HASH } from "./judge.js";
import { claimKey } from "./snapshot.js";
import type { VerdictRecord } from "./types.js";

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

	it("counts an errored first judge only under errors and does not cache it", async () => {
		const base = setup();
		const result = await adjudicate({
			...base,
			candidates: [cand("Retry delay skipped")],
			producer: "anthropic",
			judges: judges(stub(new Error("boom")), null),
			caps: { anthropic: 10, openai: 0 },
		});
		expect(result.verdicts.size).toBe(0);
		expect(result.counts).toEqual({
			real: 0,
			notReal: 0,
			unclear: 0,
			unresolved: 0,
			singleFamily: 0,
			cached: 0,
			deferred: 0,
			errors: 1,
		});
		expect(
			base.cache.get("snap", claimKey(cand("Retry delay skipped"))),
		).toBeUndefined();
	});

	it("counts an errored second judge under errors and keeps the first verdict for a later upgrade", async () => {
		const base = setup();
		const c = cand("Retry delay skipped");
		const result = await adjudicate({
			...base,
			candidates: [c],
			producer: "anthropic",
			judges: judges(stub(real), stub(new Error("boom"))),
			caps: { anthropic: 10, openai: 5 },
		});
		expect(result.verdicts.size).toBe(0);
		expect(result.counts.errors).toBe(1);
		expect(result.counts.real).toBe(0);
		expect(result.counts.singleFamily).toBe(0);
		expect(result.errorSamples).toEqual(["boom"]);
		const kept = base.cache.get("snap", claimKey(c));
		expect(kept?.status).toBe("single-family");
		expect(kept?.verdict).toBe("real");
		expect(kept?.second).toBeNull();

		const first = stub(real);
		const later = await adjudicate({
			...base,
			candidates: [c],
			producer: "anthropic",
			judges: judges(first, stub(real)),
			caps: { anthropic: 10, openai: 5 },
		});
		expect(first).not.toHaveBeenCalled();
		expect(later.spend).toEqual({ anthropic: 0, openai: 1 });
		expect(later.verdicts.get(claimKey(c))?.status).toBe("agreed");
	});

	it("records distinct error messages from the first judge, capped at five", async () => {
		const messages = ["a", "a", "b", "c", "d", "e", "f", "g"];
		let n = 0;
		const first = vi.fn<Judge>(async () => {
			throw new Error(messages[n++ % messages.length]);
		});
		const result = await adjudicate({
			...setup(),
			candidates: messages.map((_m, i) =>
				cand(`Distinct claim number${"x".repeat(i)} here`, `f${i}.ts`),
			),
			producer: "anthropic",
			judges: judges(first, null),
			caps: { anthropic: 20, openai: 0 },
		});
		expect(result.counts.errors).toBe(8);
		expect(result.errorSamples).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("records the message of an errored second judge", async () => {
		const result = await adjudicate({
			...setup(),
			candidates: [cand("Retry delay skipped")],
			producer: "anthropic",
			judges: judges(stub(real), stub(new Error("quota exhausted"))),
			caps: { anthropic: 10, openai: 5 },
		});
		expect(result.errorSamples).toEqual(["quota exhausted"]);
	});

	it("records the message of an errored upgrade", async () => {
		const base = setup();
		const c = cand("Retry delay skipped");
		await adjudicate({
			...base,
			candidates: [c],
			producer: "anthropic",
			judges: judges(stub(real), null),
			caps: { anthropic: 10, openai: 0 },
		});
		const result = await adjudicate({
			...base,
			candidates: [c],
			producer: "anthropic",
			judges: judges(stub(real), stub(new Error("bad key"))),
			caps: { anthropic: 10, openai: 5 },
		});
		expect(result.errorSamples).toEqual(["bad key"]);
		expect(result.counts.errors).toBe(1);
	});
});
