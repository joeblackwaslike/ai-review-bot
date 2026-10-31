import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../ledger/types.js";
import {
	capFindings,
	formatReport,
	type GateFinding,
	toGateFinding,
	validateReport,
} from "./report.js";

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
	id: "a1",
	round: 1,
	path: "src/a.ts",
	line: 3,
	severity: "P1",
	title: "Title",
	body: "Body",
	status: "open",
	decidedBy: null,
	reason: null,
	evidence: [],
	...over,
});

const f = (id: string, severity: GateFinding["severity"]): GateFinding => ({
	id,
	severity,
	description: "d",
	action: "ask-user",
});

describe("toGateFinding", () => {
	it("maps P0 and P1 to error ask-user", () => {
		for (const s of ["P0", "P1"]) {
			const g = toGateFinding(entry({ severity: s }));
			expect(g.severity).toBe("error");
			expect(g.action).toBe("ask-user");
		}
	});
	it("maps P2 to warning ask-user", () => {
		const g = toGateFinding(entry({ severity: "P2" }));
		expect([g.severity, g.action]).toEqual(["warning", "ask-user"]);
	});
	it("maps P3 to info no-op", () => {
		const g = toGateFinding(entry({ severity: "P3" }));
		expect([g.severity, g.action]).toEqual(["info", "no-op"]);
	});
	it("omits file and line for a general finding", () => {
		const g = toGateFinding(entry({ path: null, line: null }));
		expect("file" in g).toBe(false);
		expect("line" in g).toBe(false);
	});
	it("joins title, body and suggestion, skipping empties", () => {
		expect(toGateFinding(entry(), "Fix it").description).toBe(
			"Title\n\nBody\n\nFix it",
		);
		expect(toGateFinding(entry({ body: null })).description).toBe("Title");
	});
});

describe("capFindings", () => {
	it("drops info before warning before error", () => {
		const all = [
			f("1", "error"),
			f("2", "info"),
			f("3", "warning"),
			f("4", "info"),
		];
		expect(capFindings(all, 2)).toEqual({ kept: [all[0], all[2]], dropped: 2 });
		expect(capFindings(all, 1).kept).toEqual([all[0]]);
	});
	it("drops the last of a severity first", () => {
		const all = [f("1", "info"), f("2", "info"), f("3", "info")];
		expect(capFindings(all, 2).kept.map((x) => x.id)).toEqual(["1", "2"]);
	});
	it("drops an error only when nothing else is left", () => {
		const all = [f("1", "error"), f("2", "error"), f("3", "info")];
		const r = capFindings(all, 1);
		expect(r.kept.map((x) => x.id)).toEqual(["1"]);
		expect(r.dropped).toBe(2);
	});
	it("keeps everything under the cap", () => {
		expect(capFindings([f("1", "info")]).dropped).toBe(0);
	});
});

describe("validateReport", () => {
	const wrap = (x: unknown) => JSON.stringify({ findings: [x] });
	it("rejects an id with a comma", () => {
		expect(
			validateReport(wrap({ ...f("a,b", "info") })).length,
		).toBeGreaterThan(0);
	});
	it("rejects an unknown field", () => {
		expect(
			validateReport(wrap({ ...f("a", "info"), extra: 1 })).length,
		).toBeGreaterThan(0);
	});
	it("rejects non-JSON, duplicates, bad line, bad enums", () => {
		expect(validateReport("nope").length).toBeGreaterThan(0);
		expect(
			validateReport(
				JSON.stringify({ findings: [f("a", "info"), f("a", "info")] }),
			).length,
		).toBeGreaterThan(0);
		expect(
			validateReport(wrap({ ...f("a", "info"), line: -1 })).length,
		).toBeGreaterThan(0);
		expect(
			validateReport(wrap({ ...f("a", "info"), severity: "bad" })).length,
		).toBeGreaterThan(0);
		expect(
			validateReport(wrap({ ...f("a", "info"), action: "x" })).length,
		).toBeGreaterThan(0);
		expect(
			validateReport(wrap({ ...f("a", "info"), description: "" })).length,
		).toBeGreaterThan(0);
	});
	it("rejects over 500 findings", () => {
		const many = Array.from({ length: 501 }, (_, i) => f(`i${i}`, "info"));
		expect(
			validateReport(JSON.stringify({ findings: many })).length,
		).toBeGreaterThan(0);
	});
	it("formatReport output passes validateReport", () => {
		const out = formatReport([
			toGateFinding(entry()),
			toGateFinding(entry({ id: "b", path: null, line: null })),
		]);
		expect(validateReport(out)).toEqual([]);
	});
});
