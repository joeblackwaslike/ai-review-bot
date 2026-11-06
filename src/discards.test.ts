import { afterEach, describe, expect, it, vi } from "vitest";
import { type Discard, discardKey, logDiscards } from "./discards.js";

const base: Discard = {
	reason: "CAP",
	code: null,
	disposition: "dropped",
	title: "Off-by-one",
	path: "src/a.ts",
	line: 3,
	severity: "P2",
	skill: "code-reviewer",
	reviewer: "claude",
};

describe("discardKey", () => {
	it("is stable across case and surrounding whitespace in the title", () => {
		expect(discardKey({ path: "src/a.ts", title: "  OFF-BY-ONE " })).toBe(
			discardKey({ path: "src/a.ts", title: "off-by-one" }),
		);
	});

	it("differs by path", () => {
		expect(discardKey({ path: "src/a.ts", title: "x" })).not.toBe(
			discardKey({ path: "src/b.ts", title: "x" }),
		);
	});

	it("matches the sha1 prefix of path|lowercased title", () => {
		expect(discardKey({ path: "src/a.ts", title: "Off-by-one" })).toBe(
			"8dcf0f9d1a1b",
		);
	});
});

describe("logDiscards", () => {
	afterEach(() => vi.restoreAllMocks());

	it("logs one line per record with the reason", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		logDiscards([base, { ...base, reason: "OFF_DIFF", code: "BAD_RANGE" }], {
			owner: "o",
			repo: "r",
			pullNumber: 7,
		});
		expect(log).toHaveBeenCalledTimes(2);
		expect(log.mock.calls[0][0]).toBe("finding discarded");
		expect(log.mock.calls[0][1]).toMatchObject({
			reason: "CAP",
			pullNumber: 7,
		});
		expect(log.mock.calls[1][1]).toMatchObject({
			reason: "OFF_DIFF",
			code: "BAD_RANGE",
		});
	});
});

/** The reason, code and disposition of each `Discard` variant. */
type Kind<T> = T extends Discard
	? Pick<T, "reason" | "code" | "disposition">
	: never;
const kind = (k: Kind<Discard>) => k;

describe("Discard", () => {
	it("rejects contradictory reason, code and disposition combinations", () => {
		const rejected = [
			// @ts-expect-error a CAP discard has no off-diff code
			kind({ reason: "CAP", code: "BAD_RANGE", disposition: "dropped" }),
			// @ts-expect-error an OFF_DIFF discard needs its code
			kind({ reason: "OFF_DIFF", code: null, disposition: "dropped" }),
			// @ts-expect-error an OFF_DIFF discard is dropped, not held
			kind({ reason: "OFF_DIFF", code: "BAD_RANGE", disposition: "held" }),
			// @ts-expect-error an open restatement is held, not dropped
			kind({ reason: "SUPPRESSED_OPEN", code: null, disposition: "dropped" }),
			// @ts-expect-error only an open restatement is held
			kind({ reason: "SUPPRESSED_SETTLED", code: null, disposition: "held" }),
		];
		expect(rejected).toHaveLength(5);
	});
});
