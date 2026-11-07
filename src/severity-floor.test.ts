import { describe, expect, it } from "vitest";
import { applySeverityFloor } from "./severity-floor.js";

const all = ["P0", "P1", "P2", "P3"].map((severity) => ({ severity }));
const kept = (floor: "P3" | "P2" | "P1") =>
	applySeverityFloor(all, floor).kept.map((f) => f.severity);

describe("applySeverityFloor", () => {
	it("P3 keeps everything", () => {
		expect(kept("P3")).toEqual(["P0", "P1", "P2", "P3"]);
	});
	it("P2 drops P3", () => {
		const out = applySeverityFloor(all, "P2");
		expect(out.kept.map((f) => f.severity)).toEqual(["P0", "P1", "P2"]);
		expect(out.dropped.map((f) => f.severity)).toEqual(["P3"]);
	});
	it("P1 drops P2 and P3", () => {
		expect(kept("P1")).toEqual(["P0", "P1"]);
	});
	it("P0 and P1 survive every floor", () => {
		for (const floor of ["P3", "P2", "P1"] as const)
			expect(kept(floor)).toEqual(expect.arrayContaining(["P0", "P1"]));
	});
	it("keeps a finding with no severity", () => {
		expect(applySeverityFloor([{}], "P1").kept).toHaveLength(1);
	});
});
