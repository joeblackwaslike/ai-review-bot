import { describe, expect, it } from "vitest";
import { splitInlineClaims } from "../replay/claims.js";
import {
	anchorFingerprint,
	formatFpMarkers,
	readFpMarkers,
	suggestionFingerprint,
} from "./fingerprint.js";

const patch = (start: number, lines: string[]) =>
	`@@ -1,1 +${start},${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

const base = { category: "bug", path: "src/a.ts" };

describe("anchorFingerprint", () => {
	it("is stable under reformatting and a line-number shift", () => {
		const a = anchorFingerprint({
			...base,
			line: 12,
			patch: patch(10, ["x();", "const total = items.map(i => i.n);", "y();"]),
		});
		const b = anchorFingerprint({
			...base,
			line: 52,
			patch: patch(50, [
				"x();",
				"  const  total = items.map( i => i.n );",
				"y();",
			]),
		});
		expect(a).not.toBeNull();
		expect(a).toBe(b);
	});

	it("differs for different code", () => {
		const a = anchorFingerprint({
			...base,
			line: 1,
			patch: patch(1, ["foo();"]),
		});
		const b = anchorFingerprint({
			...base,
			line: 1,
			patch: patch(1, ["bar();"]),
		});
		expect(a).not.toBe(b);
	});

	it("separates two identical lines with an occurrence suffix", () => {
		const p = `${patch(1, ["dup();"])}\n${patch(20, ["dup();"])}`;
		const first = anchorFingerprint({ ...base, line: 1, patch: p });
		const second = anchorFingerprint({ ...base, line: 20, patch: p });
		expect(first).toMatch(/\.0$/);
		expect(second).toMatch(/\.1$/);
	});

	it("is null for a line not on the right side", () => {
		expect(
			anchorFingerprint({ ...base, line: 99, patch: patch(1, ["a();"]) }),
		).toBeNull();
	});

	it("starts with category and path", () => {
		const fp = anchorFingerprint({
			...base,
			line: 1,
			patch: patch(1, ["a();"]),
		});
		expect(fp?.startsWith("bug|src/a.ts|")).toBe(true);
	});
});

describe("suggestionFingerprint", () => {
	it("ignores whitespace and differs for different code", () => {
		expect(suggestionFingerprint("a  = 1;")).toBe(
			suggestionFingerprint("a=1;\n"),
		);
		expect(suggestionFingerprint("a = 1;")).not.toBe(
			suggestionFingerprint("a = 2;"),
		);
	});
});

describe("markers", () => {
	it("round-trip and leave claim titles alone", () => {
		const body = "**P1** \n\n**Null deref in parse**\n\nexplanation";
		const markers = formatFpMarkers({ fp: "bug|src/a.ts|abc.0", sfp: "def" });
		expect(readFpMarkers(`${body}\n\n${markers}`)).toEqual({
			fp: "bug|src/a.ts|abc.0",
			sfp: "def",
		});
		expect(splitInlineClaims(`${body}\n\n${markers}`)[0].title).toBe(
			splitInlineClaims(body)[0].title,
		);
	});

	it("reads nothing from a comment without markers", () => {
		expect(readFpMarkers("plain")).toEqual({});
		expect(formatFpMarkers({})).toBe("");
	});
});
