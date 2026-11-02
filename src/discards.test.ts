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
	provider: "anthropic",
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
