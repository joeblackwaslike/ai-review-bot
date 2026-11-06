import { describe, expect, it } from "vitest";
import { makeFixture } from "../testkit.js";
import { claimKey, snapshotId } from "./snapshot.js";

describe("snapshotId", () => {
	it("is unchanged when a trace is saved", () => {
		const fixture = makeFixture([["c1"]]);
		const before = snapshotId(fixture);
		const round = fixture.rounds[0];
		if (!round) throw new Error("no round");
		round.trace = { candidates: [], posted: [], usage: {} };
		expect(snapshotId(fixture)).toBe(before);
		expect(before).toMatch(/^[0-9a-f]{16}$/);
	});

	it("changes when label text changes", () => {
		const a = makeFixture([["c1"]]);
		const b = makeFixture([["c1"]]);
		const claim = b.rounds[0]?.claims[0];
		if (!claim) throw new Error("no claim");
		claim.text = "different";
		expect(snapshotId(b)).not.toBe(snapshotId(a));
	});
});

describe("claimKey", () => {
	it("is stable across rewording with the same tokens", () => {
		const a = claimKey({ path: "a.ts", title: "Retry delay is skipped" });
		const b = claimKey({ path: "a.ts", title: "skipped retry delay" });
		expect(a).toBe(b);
	});

	it("differs by path", () => {
		const title = "Retry delay is skipped";
		expect(claimKey({ path: "a.ts", title })).not.toBe(
			claimKey({ path: "b.ts", title }),
		);
	});

	it("keeps claims that differ only in a backticked identifier apart", () => {
		expect(
			claimKey({ path: "a.ts", title: "`parseA` throws on empty input" }),
		).not.toBe(
			claimKey({ path: "a.ts", title: "`parseB` throws on empty input" }),
		);
	});

	it("matches a reworded title with the same tokens and identifiers", () => {
		expect(
			claimKey({ path: "a.ts", title: "`parseA` throws on empty input" }),
		).toBe(
			claimKey({ path: "a.ts", title: "On empty input `parseA` throws" }),
		);
	});

	it("keeps titles with no tokens distinct", () => {
		expect(claimKey({ path: "a.ts", title: "Do it" })).not.toBe(
			claimKey({ path: "a.ts", title: "Is it" }),
		);
	});
});
