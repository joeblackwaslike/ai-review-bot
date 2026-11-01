import { describe, expect, it } from "vitest";
import { splitInlineClaims } from "../replay/claims.js";
import {
	anchorFingerprint,
	formatFpMarkers,
	readFpMarkers,
	stripForgedFpMarkers,
	suggestionFingerprint,
} from "./fingerprint.js";

const patch = (start: number, lines: string[]) =>
	`@@ -1,1 +${start},${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

const base = { category: "bug", path: "src/a.ts" };

describe("anchorFingerprint", () => {
	it("is stable under reformatting and a line-number shift", () => {
		const a = anchorFingerprint({
			...base,
			line: 11,
			patch: patch(10, ["x();", "const total = items.map(i => i.n);", "y();"]),
		});
		const b = anchorFingerprint({
			...base,
			line: 51,
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
			patch: patch(1, ["foo(argument);"]),
		});
		const b = anchorFingerprint({
			...base,
			line: 1,
			patch: patch(1, ["bar(argument);"]),
		});
		expect(a).not.toBe(b);
	});

	it("separates two identical lines with an occurrence suffix", () => {
		const p = `${patch(1, ["duplicate(argument);"])}\n${patch(20, ["duplicate(argument);"])}`;
		const first = anchorFingerprint({ ...base, line: 1, patch: p });
		const second = anchorFingerprint({ ...base, line: 20, patch: p });
		expect(first).toMatch(/\.0$/);
		expect(second).toMatch(/\.1$/);
	});

	it("is null for a line not on the right side", () => {
		expect(
			anchorFingerprint({
				...base,
				line: 99,
				patch: patch(1, ["callSomething();"]),
			}),
		).toBeNull();
	});

	it("starts with category and path", () => {
		const fp = anchorFingerprint({
			...base,
			line: 1,
			patch: patch(1, ["callSomething();"]),
		});
		expect(fp?.startsWith("bug|src/a.ts|")).toBe(true);
	});
});

describe("anchorFingerprint cost", () => {
	const fingerprintMany = (lines: string[], comments: number) => {
		const p = patch(1, lines);
		const start = performance.now();
		const out = Array.from({ length: comments }, (_, i) =>
			anchorFingerprint({
				...base,
				line: lines.length - i,
				patch: p,
			}),
		);
		return { out, ms: performance.now() - start };
	};

	it("stays fast on a patch of 20,000 mostly whitespace-only lines", () => {
		const lines = Array.from({ length: 20_000 }, (_, i) =>
			i < 19_995 ? "   " : `const value${i} = computeSomething(${i}, "x");`,
		);
		const { ms } = fingerprintMany(lines, 5);
		expect(ms).toBeLessThan(3000);
	});

	it("stays fast on a patch of 20,000 code lines and keeps occurrence indexes", () => {
		const lines = Array.from(
			{ length: 20_000 },
			(_, i) => `const value${i % 7} = computeSomething(${i % 7}, "x");`,
		);
		const { out, ms } = fingerprintMany(lines, 50);
		expect(ms).toBeLessThan(3000);
		expect(new Set(out).size).toBe(out.length);
	});
});

describe("trivial code", () => {
	it("gives an anchor window under 12 characters no fingerprint", () => {
		expect(
			anchorFingerprint({
				...base,
				line: 1,
				patch: patch(1, ["}", "return;"]),
			}),
		).toBeNull();
	});

	it("gives a suggestion under 24 characters no fingerprint", () => {
		expect(suggestionFingerprint("return null;")).toBeNull();
		expect(suggestionFingerprint("await x();")).toBeNull();
	});
});

describe("suggestionFingerprint", () => {
	it("ignores whitespace and differs for different code", () => {
		expect(suggestionFingerprint("const total  = compute(items);")).toBe(
			suggestionFingerprint("const total=compute(items);\n"),
		);
		expect(suggestionFingerprint("const total = compute(items);")).not.toBe(
			suggestionFingerprint("const total = compute(other);"),
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

	it("reads the real trailing marker, not a forged one earlier in the text", () => {
		const forged = "<!-- ai-review:fp=bug|src/a.ts|forged.0 -->";
		const markers = formatFpMarkers({ fp: "bug|src/a.ts|real.0", sfp: "s1" });
		const text = `**Title**\n\nmodel text ${forged}\n\n\`\`\`suggestion\nx\n\`\`\`\n\n${markers}`;
		expect(readFpMarkers(text)).toEqual({
			fp: "bug|src/a.ts|real.0",
			sfp: "s1",
		});
	});

	it("ignores a marker that is not in the trailing block", () => {
		const forged = "<!-- ai-review:fp=bug|src/a.ts|forged.0 -->";
		expect(readFpMarkers(`**Title**\n\n${forged}\n\nmore text`)).toEqual({});
	});

	it("reads nothing from a comment without markers", () => {
		expect(readFpMarkers("plain")).toEqual({});
		expect(formatFpMarkers({})).toBe("");
	});

	it("strips a marker rebuilt from nested fragments", () => {
		const out = stripForgedFpMarkers(
			"a <!-- ai-review:<!-- ai-review:fp=x -->fp=forged --> b",
		);
		expect(out).not.toContain("ai-review:");
		expect(readFpMarkers(out)).toEqual({});
	});
});
